/**
 * 神庙：散布在野外的试炼场。
 *
 * 塞尔达的神庙是"看见光柱 → 走过去 → 一场小挑战 → 一份祝福"
 * 的循环。这里做成露天的环形石阵（不做室内副本——副本是另一张
 * 地图，成本是这个数量级的十倍，而核心循环完全相同）：
 *
 *   走近石台 → 四角落下封印光柱 → 三波守卫依次现身 →
 *   全灭 → 中央升起祝福宝箱 → 心之容器（生命上限 +1）
 *
 * 四座神庙各守一个方向，外观一致但光柱颜色按方位分四季。
 */

import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
} from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'
import type { NatureGeometry } from './natureLibrary.ts'
import type { ObstacleGrid } from '../physics/obstacleGrid.ts'

export interface Shrine {
  id: string
  name: string
  position: Vector3
  /** 挑战状态 */
  state: 'dormant' | 'active' | 'cleared'
  /** 当前是第几波（0 起） */
  wave: number
  /** 顶部的远视光柱与四角封印柱 */
  beacon: Mesh
  beaconMat: MeshBasicMaterial
  sealPillars: Mesh[]
  /** 奖励宝箱（挑战完成后才可见） */
  reward: Group
  rewardLid: Group
  rewardOpened: boolean
  phase: number
}

/** 站上石台多远触发挑战 */
const TRIGGER_RADIUS = 4.4
/** 宝箱交互距离 */
const REWARD_RANGE = 2.6

/** 四座神庙：方位、名字、光柱色。按方位撒，保证玩家向任何方向走都能撞见一座 */
const SHRINE_PLAN = [
  { id: 'shrine-ne', name: '晨曦神庙', bearing: Math.PI * 0.25, color: new Color(2.6, 1.9, 0.8) },
  { id: 'shrine-se', name: '落霞神庙', bearing: Math.PI * 0.75, color: new Color(2.4, 1.2, 0.9) },
  { id: 'shrine-sw', name: '听涛神庙', bearing: Math.PI * 1.25, color: new Color(0.9, 1.8, 2.6) },
  { id: 'shrine-nw', name: '凌峰神庙', bearing: Math.PI * 1.75, color: new Color(1.6, 1.2, 2.6) },
] as const

/** 每座神庙的波次：种类 × 数量 */
const WAVES: ReadonlyArray<ReadonlyArray<'minion' | 'warrior' | 'elite'>> = [
  ['minion', 'minion'],
  ['warrior', 'warrior'],
  ['elite'],
]

let beaconGeo: CylinderGeometry | null = null
function beaconGeometry(): CylinderGeometry {
  if (!beaconGeo) {
    // 细高的光柱，顶部开口——从山上俯瞰时它就是一根插在地上的光标
    beaconGeo = new CylinderGeometry(0.5, 1.1, 26, 8, 1, true)
    beaconGeo.translate(0, 13, 0)
  }
  return beaconGeo
}

export class ShrineField {
  readonly group = new Group()
  readonly shrines: Shrine[] = []

  constructor() {
    this.group.name = 'shrines'
  }

  /** 布置四座神庙。选址沿各自方位角扫描：平缓、离地水位、彼此远离 */
  populate(
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    origin: Vector3,
    obstacles?: ObstacleGrid,
  ): void {
    for (const plan of SHRINE_PLAN) {
      const site = this.findSite(hf, origin, plan.bearing)
      if (!site) continue
      this.build(hf, nature, plan, site.x, site.z, obstacles)
    }
  }

  private findSite(hf: Heightfield, origin: Vector3, bearing: number): { x: number; z: number } | null {
    for (let r = 100; r <= 240; r += 18) {
      for (let fan = -0.3; fan <= 0.3; fan += 0.1) {
        const a = bearing + fan
        const x = origin.x + Math.cos(a) * r
        const z = origin.z + Math.sin(a) * r
        const h = hf.height(x, z)
        if (h < WATER_LEVEL + 3 || h > 55) continue
        if (hf.slope(x, z) > 0.16) continue
        if (this.shrines.some((s) => Math.hypot(s.position.x - x, s.position.z - z) < 90)) continue
        return { x, z }
      }
    }
    return null
  }

  private build(
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    plan: (typeof SHRINE_PLAN)[number],
    x: number,
    z: number,
    obstacles?: ObstacleGrid,
  ): void {
    const baseY = hf.height(x, z)
    const root = new Group()
    root.position.set(x, baseY, z)
    const stoneMat = shrineStoneMaterial

    // ── 环形石台 ──
    const platform = nature.get('platform_stone')
    if (platform) {
      const mesh = new Mesh(platform.geometry, stoneMat)
      // 素材归一化到 6m 宽，神庙台子再大一圈：站上去要容得下一场战斗
      mesh.scale.setScalar(1.5)
      mesh.castShadow = true
      mesh.receiveShadow = true
      root.add(mesh)
    }

    // ── 四角立柱 ──
    const column = nature.get('statue_column')
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const cx = Math.cos(a) * 5.4
      const cz = Math.sin(a) * 5.4
      if (column) {
        const mesh = new Mesh(column.geometry, stoneMat)
        mesh.position.set(cx, hf.height(x + cx, z + cz) - baseY, cz)
        mesh.castShadow = true
        root.add(mesh)
      }
      obstacles?.insert(x + cx, z + cz, 0.55)
    }

    // ── 中央雕像（试炼的"神像"）──
    const head = nature.get('statue_head')
    if (head) {
      const mesh = new Mesh(head.geometry, stoneMat)
      mesh.position.set(0, 0.1, -5.2)
      mesh.rotation.y = Math.PI
      mesh.castShadow = true
      root.add(mesh)
      obstacles?.insert(x, z - 5.2, 0.9)
    }

    // ── 远视光柱：神庙在地平线上的招牌 ──
    const beaconMat = new MeshBasicMaterial({
      color: plan.color,
      transparent: true,
      opacity: 0.34,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    const beacon = new Mesh(beaconGeometry(), beaconMat)
    root.add(beacon)

    // ── 四角封印柱（挑战激活时升起）──
    const sealPillars: Mesh[] = []
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const mat = new MeshBasicMaterial({
        color: plan.color,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
      })
      const pillar = new Mesh(sealPillarGeometry(), mat)
      pillar.position.set(Math.cos(a) * 6.2, 0, Math.sin(a) * 6.2)
      pillar.scale.y = 0.01
      sealPillars.push(pillar)
      root.add(pillar)
    }

    // ── 奖励宝箱：挑战完成前藏着 ──
    const reward = new Group()
    reward.position.set(0, 0.6, 0)
    const chestBody = new Mesh(chestBodyGeometry(), chestWoodMaterial)
    chestBody.position.y = 0.25
    reward.add(chestBody)
    const rewardLid = new Group()
    rewardLid.position.set(0, 0.5, -0.31)
    const lidMesh = new Mesh(chestLidGeometry(), chestWoodMaterial)
    lidMesh.position.set(0, 0.085, 0.31)
    rewardLid.add(lidMesh)
    reward.add(rewardLid)
    reward.visible = false
    root.add(reward)

    this.group.add(root)
    this.shrines.push({
      id: plan.id,
      name: plan.name,
      position: new Vector3(x, baseY, z),
      state: 'dormant',
      wave: 0,
      beacon,
      beaconMat,
      sealPillars,
      reward,
      rewardLid,
      rewardOpened: false,
      phase: this.shrines.length * 1.9,
    })
  }

  /** 玩家站上某座神庙的石台（且在休眠中）→ 该触发挑战了 */
  pendingActivation(pos: Vector3): Shrine | null {
    for (const s of this.shrines) {
      if (s.state !== 'dormant') continue
      const d = Math.hypot(s.position.x - pos.x, s.position.z - pos.z)
      if (d < TRIGGER_RADIUS && Math.abs(s.position.y - pos.y) < 3.5) return s
    }
    return null
  }

  activate(shrine: Shrine): void {
    shrine.state = 'active'
    shrine.wave = 0
  }

  /** 当前波次的配置 */
  waveOf(shrine: Shrine): ReadonlyArray<'minion' | 'warrior' | 'elite'> {
    return WAVES[Math.min(shrine.wave, WAVES.length - 1)]
  }

  advanceWave(shrine: Shrine): boolean {
    shrine.wave++
    if (shrine.wave >= WAVES.length) {
      shrine.state = 'cleared'
      shrine.reward.visible = true
      return true
    }
    return false
  }

  /** 找可以开奖励宝箱的神庙 */
  nearestReward(pos: Vector3): Shrine | null {
    for (const s of this.shrines) {
      if (s.state !== 'cleared' || s.rewardOpened) continue
      const d = Math.hypot(s.position.x - pos.x, s.position.z - pos.z)
      if (d < REWARD_RANGE && Math.abs(s.position.y - pos.y) < 3) return s
    }
    return null
  }

  openReward(shrine: Shrine): void {
    shrine.rewardOpened = true
  }

  /** 存档：已完成的神庙 id */
  toSave(): string[] {
    return this.shrines.filter((s) => s.state === 'cleared').map((s) => s.id)
  }

  restore(cleared: readonly string[]): void {
    const set = new Set(cleared)
    for (const s of this.shrines) {
      if (!set.has(s.id)) continue
      s.state = 'cleared'
      s.wave = WAVES.length
      s.reward.visible = true
      s.rewardOpened = true // 读档回来的神庙奖励视为已领，防止无限刷心
      s.rewardLid.rotation.x = -1.9
    }
  }

  update(dt: number, elapsed: number): void {
    for (const s of this.shrines) {
      // 光柱呼吸：休眠时淡而慢，激活时急促，通关后变金色常亮
      const pulse = 1 + Math.sin(elapsed * 2.1 + s.phase) * 0.15
      if (s.state === 'cleared') {
        s.beaconMat.opacity += (0.5 - s.beaconMat.opacity) * Math.min(1, dt * 2)
        s.beaconMat.color.lerp(goldColor, Math.min(1, dt * 1.5))
      } else {
        s.beaconMat.opacity = (s.state === 'active' ? 0.5 : 0.3) * pulse
      }
      s.beacon.scale.set(pulse, 1, pulse)

      // 封印柱：激活时升起，通关后落下
      const target = s.state === 'active' ? 1 : 0
      for (const p of s.sealPillars) {
        const cur = p.scale.y
        const next = cur + (target - cur) * Math.min(1, dt * 3.2)
        p.scale.y = Math.max(0.01, next)
        const mat = p.material as MeshBasicMaterial
        mat.opacity = next * 0.55
      }

      // 奖励宝箱的开盖动画
      if (s.rewardOpened && s.rewardLid.rotation.x > -1.9) {
        s.rewardLid.rotation.x += (-1.9 - s.rewardLid.rotation.x) * Math.min(1, dt * 6)
      }
    }
  }
}

let sealPillarGeo: CylinderGeometry | null = null
function sealPillarGeometry(): CylinderGeometry {
  if (!sealPillarGeo) {
    sealPillarGeo = new CylinderGeometry(0.32, 0.42, 5.4, 6, 1, true)
    sealPillarGeo.translate(0, 2.7, 0)
  }
  return sealPillarGeo
}

let chestBodyGeo: BoxGeometry | null = null
let chestLidGeo: BoxGeometry | null = null
function chestBodyGeometry(): BoxGeometry {
  if (!chestBodyGeo) chestBodyGeo = new BoxGeometry(0.92, 0.5, 0.62)
  return chestBodyGeo
}
function chestLidGeometry(): BoxGeometry {
  if (!chestLidGeo) chestLidGeo = new BoxGeometry(0.92, 0.17, 0.62)
  return chestLidGeo
}

const shrineStoneMaterial = new MeshLambertMaterial({ vertexColors: true })
const chestWoodMaterial = new MeshLambertMaterial({ color: new Color(0x7a5230) })
const goldColor = new Color(2.4, 1.9, 0.8)
