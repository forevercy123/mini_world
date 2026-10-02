/**
 * 插在野外的武器。
 *
 * 武器不做成"躺在地上的小图标"，而是**斜插进土里、只露出柄**——
 * 剑插在石头缝里是冒险游戏里最经典的"这里有东西"信号，配合一道
 * 稀有度颜色的光柱，玩家在两百米外的山坡上就能看见目标。
 *
 * 位置是扫描出来的（高地、林缘、水畔），和宝箱同一套哲学：
 * 给"拐个弯"一个回报。但武器点比宝箱更招摇——宝箱要开到才知道
 * 有什么，武器的光柱颜色直接告诉了你好坏。
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Heightfield } from '../terrain/heightfield.ts'
import {
  createBranchMesh,
  RARITY_GLOW,
  WEAPON_DEFS,
  type WeaponId,
} from '../gameplay/weapons.ts'

/** 走到多近自动拔起武器。和果实拾取一致，玩家不用学新规则 */
const PICKUP_RADIUS = 1.7
/** 光柱呼吸脉动的幅度 */
const BEAM_PULSE = 0.14

export interface WeaponSpawn {
  id: SpawnContent
  position: Vector3
  taken: boolean
  root: Group
  beam: Mesh
  beamMat: MeshBasicMaterial
  /** 呼吸相位，避免所有光柱同步闪 */
  phase: number
}

/** 武器点的内容：武器，或者一捆箭（弹药补给） */
export type SpawnContent = WeaponId | 'arrow_bundle'

/** 各武器插在地上时的展示长度（米）。按武器气质定，不是模型原始尺寸 */
export const DISPLAY_LENGTH: Record<SpawnContent, number> = {
  branch: 0.62,
  dagger: 0.5,
  sword1h: 0.95,
  axe1h: 0.8,
  sword2h: 1.3,
  axe2h: 1.2,
  crossbow: 0.7,
  arrow_bundle: 0.5,
}

/** 武器 GLB 的共享缓存：同一种武器全图只加载一次 */
const modelCache = new Map<string, Object3D>()

async function loadWeaponModel(url: string): Promise<Object3D | null> {
  const hit = modelCache.get(url)
  if (hit) return hit
  try {
    const gltf = await new GLTFLoader().loadAsync(url)
    modelCache.set(url, gltf.scene)
    return gltf.scene
  } catch (err) {
    console.warn('[武器] 模型加载失败：', url, err)
    return null
  }
}

/**
 * 做一个武器外观实例。模型被缩放归一到指定长度——不同来源的武器
 * 原始尺寸差好几倍，不归一的话匕首会和大剑一样长。
 */
export function makeWeaponVisual(id: SpawnContent, length: number): Object3D | null {
  const modelUrl = id === 'arrow_bundle' ? '/assets/weapons/arrow_bundle.gltf' : WEAPON_DEFS[id].model
  let visual: Object3D | null = null

  if (modelUrl === null) {
    visual = createBranchMesh()
  } else {
    const cached = modelCache.get(modelUrl)
    if (cached) visual = cached.clone(true)
  }
  if (!visual) return null

  // 模型原点在握把，长度沿 Y 轴。量出原始长度再缩放
  const box = measureBox(visual)
  const raw = Math.max(0.001, box.max.y - box.min.y)
  visual.scale.setScalar(length / raw)
  return visual
}

const _boxMin = new Vector3()
const _boxMax = new Vector3()
function measureBox(obj: Object3D): { min: Vector3; max: Vector3 } {
  _boxMin.set(Infinity, Infinity, Infinity)
  _boxMax.set(-Infinity, -Infinity, -Infinity)
  obj.updateMatrixWorld(true)
  obj.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    const geo = mesh.geometry as BufferGeometry
    if (!geo.boundingBox) geo.computeBoundingBox()
    const bb = geo.boundingBox!
    for (const cx of [bb.min.x, bb.max.x]) {
      for (const cy of [bb.min.y, bb.max.y]) {
        for (const cz of [bb.min.z, bb.max.z]) {
          _v.set(cx, cy, cz).applyMatrix4(mesh.matrixWorld)
          _boxMin.min(_v)
          _boxMax.max(_v)
        }
      }
    }
  })
  return { min: _boxMin, max: _boxMax }
}
const _v = new Vector3()

/** 光柱几何缓存：所有武器点共用同一个，只在材质上区分颜色 */
let cachedBeamGeometry: CylinderGeometry | null = null
function beamGeometry(): CylinderGeometry {
  if (!cachedBeamGeometry) {
    cachedBeamGeometry = new CylinderGeometry(0.34, 0.5, 2.6, 10, 1, true)
    cachedBeamGeometry.translate(0, 1.3, 0)
  }
  return cachedBeamGeometry
}

export class WeaponSpawnField {
  readonly group = new Group()
  readonly spawns: WeaponSpawn[] = []
  private elapsed = 0

  constructor() {
    this.group.name = 'weapon-spawns'
  }

  /**
   * 扫描地形并布置武器点。
   *
   * 先加载全部武器模型（并行），再按地形特征选点：
   * 好武器（史诗）放高处——要先爬上去才够得着；
   * 普通货色放在路边，顺手就能拔。
   */
  async populate(hf: Heightfield, sites: readonly { x: number; z: number }[]): Promise<number> {
    // 把要用的模型先全部拉下来，缺模型的武器点直接跳过
    const urls = new Set<string>()
    for (const def of Object.values(WEAPON_DEFS)) {
      if (def.model) urls.add(def.model)
    }
    urls.add('/assets/weapons/arrow_bundle.gltf')
    await Promise.all([...urls].map((u) => loadWeaponModel(u)))

    let placed = 0
    for (let i = 0; i < sites.length; i++) {
      const id = SPAWN_TABLE[i % SPAWN_TABLE.length]
      const y = hf.height(sites[i].x, sites[i].z)
      if (this.dropAt(sites[i].x, y, sites[i].z, id)) placed++
    }
    return placed
  }

  /**
   * 在指定位置插一把武器。
   *
   *  populate 用它布置野外武器点，强敌掉落也走这里——精英怪
   *  倒地时剑插在尸体旁边，和野外捡到的武器是同一个待遇。
   *  返回 false 表示模型还没加载好（启动早期），调用方可忽略。
   */
  dropAt(x: number, y: number, z: number, id: SpawnContent): boolean {
    const visual = makeWeaponVisual(id, DISPLAY_LENGTH[id])
    if (!visual) return false

    const root = new Group()
    root.position.set(x, y, z)

    // 斜插进土：柄朝天、尖朝地，转一个看着像"随手一插"的角度
    const seed = this.spawns.length
    visual.rotation.set(2.62, (seed * 1.7) % (Math.PI * 2), 0.16)
    visual.position.y = 0.62
    visual.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.isMesh) mesh.castShadow = true
    })
    root.add(visual)

    // 稀有度光柱。加法混合 + 写 HDR 颜色，bloom 会把它拉成一道光
    const rarity = id === 'arrow_bundle' ? 'common' : WEAPON_DEFS[id].rarity
    const beamMat = new MeshBasicMaterial({
      color: RARITY_GLOW[rarity],
      transparent: true,
      opacity: 0.32,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    const beam = new Mesh(beamGeometry(), beamMat)
    root.add(beam)

    this.group.add(root)
    this.spawns.push({
      id,
      position: new Vector3(x, y, z),
      taken: false,
      root,
      beam,
      beamMat,
      phase: seed * 1.37,
    })
    return true
  }

  /**
   * 每帧：光柱呼吸 + 检测拾取。
   * @returns 本帧被拾起的武器 id（没有则为 null）
   */
  update(dt: number, playerPos: Vector3): SpawnContent | null {
    this.elapsed += dt
    let picked: SpawnContent | null = null

    for (const s of this.spawns) {
      if (s.taken) continue

      // 呼吸脉动：光柱透明度与粗细一起涨落
      const pulse = 1 + Math.sin(this.elapsed * 2.2 + s.phase) * BEAM_PULSE
      s.beamMat.opacity = 0.32 * pulse
      s.beam.scale.set(pulse, 1, pulse)
      s.beam.rotation.y = this.elapsed * 0.6 + s.phase

      const dx = s.position.x - playerPos.x
      const dz = s.position.z - playerPos.z
      const dy = s.position.y - playerPos.y
      if (Math.hypot(dx, dz) < PICKUP_RADIUS && Math.abs(dy) < 2.4) {
        s.taken = true
        s.root.visible = false
        picked = s.id
      }
    }
    return picked
  }

  /** 存档：已拔走的武器点 id（武器点按生成顺序编号） */
  toSave(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.spawns.length; i++) {
      if (this.spawns[i].taken) out.push(i)
    }
    return out
  }

  restore(takenIndexes: readonly number[]): void {
    const set = new Set(takenIndexes)
    for (let i = 0; i < this.spawns.length; i++) {
      const s = this.spawns[i]
      s.taken = set.has(i)
      s.root.visible = !s.taken
    }
  }

  /** 调试/验证用：第一个还在的武器点坐标 */
  firstAvailable(): Vector3 | null {
    for (const s of this.spawns) {
      if (!s.taken) return s.position
    }
    return null
  }
}

/**
 * 武器点的种类轮转表。好东西夹在中间，不会开局就撞见大剑，
 * 也不会让迟来的玩家只剩树枝可捡。
 */
const SPAWN_TABLE: SpawnContent[] = [
  'sword1h',
  'branch',
  'dagger',
  'arrow_bundle',
  'axe1h',
  'branch',
  'crossbow',
  'sword2h',
  'sword1h',
  'arrow_bundle',
  'dagger',
  'axe2h',
  'branch',
]
