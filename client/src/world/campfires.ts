/**
 * 篝火烹饪点。
 *
 * 一堆石头圈起来的火 + 旁边架着的大锅。贤者营地里已经有一套，
 * 这里再在野外撒几处——烹饪不该只能在营地做，荒野里猎到野兽
 * 当场烤肉，才是"野外求生"的感觉。
 *
 * 火焰是两层加法混合的锥体（内焰亮黄、外焰橙红）加呼吸脉动，
 * 不挂真实光源：5 处篝火就是 5 盏 PointLight，forward 渲染下
 * 每个像素的着色成本都会跟着涨。自发光 + bloom 的效果足够。
 */

import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
} from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'
import type { NatureGeometry } from './natureLibrary.ts'

export interface Campfire {
  position: Vector3
  /** 锅的交互位置（站到这里按 E 开火） */
  potPosition: Vector3
  flameInner: Mesh
  flameOuter: Mesh
  phase: number
}

/** 站在锅边多远能开火 */
export const COOK_RANGE = 2.8

/** 火焰内外的几何共享：所有篝火用的是同一副 */
let innerGeo: ConeGeometry | null = null
let outerGeo: ConeGeometry | null = null
function flameGeometries(): { inner: ConeGeometry; outer: ConeGeometry } {
  if (!innerGeo) {
    // 火焰要高过石头圈（圈壁约 0.2m），底部埋进柴堆里
    innerGeo = new ConeGeometry(0.2, 0.85, 6)
    innerGeo.translate(0, 0.42, 0)
    outerGeo = new ConeGeometry(0.4, 1.25, 7)
    outerGeo.translate(0, 0.55, 0)
  }
  return { inner: innerGeo!, outer: outerGeo! }
}

export class CampfireField {
  readonly group = new Group()
  readonly fires: Campfire[] = []
  private elapsed = 0

  constructor() {
    this.group.name = 'campfires'
  }

  /**
   * 布置篝火。贤者营地的那一堆由 landmarks 摆好了，这里只登记
   * 它的交互坐标；野外的几堆连模型带火一起建。
   */
  populate(
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    campSite: { x: number; z: number },
    wildCount = 4,
  ): void {
    // ── 营地：模型已有，登记交互点（锅在营地中心偏 (2.0, -0.6)）──
    this.register(hf, campSite.x + 0.4, campSite.z - 1.8, campSite.x + 2.0, campSite.z - 0.6, false)

    // ── 野外：扫描平缓草地，连模型一起建 ──
    let placed = 0
    let tries = 0
    while (placed < wildCount && tries++ < 300) {
      const a = (placed / wildCount) * Math.PI * 2 + tries * 0.7
      const r = 55 + placed * 45 + (tries % 7) * 6
      const x = campSite.x + Math.cos(a) * r
      const z = campSite.z + Math.sin(a) * r
      const h = hf.height(x, z)
      if (h < WATER_LEVEL + 2 || h > 46) continue
      if (hf.slopeAngle(x, z) > 0.35) continue
      // 篝火之间拉开距离，别把野外搞成营地连锁
      if (this.fires.some((f) => Math.hypot(f.position.x - x, f.position.z - z) < 55)) continue

      this.register(hf, x, z, x + 1.5, z + 0.6, true, nature)
      placed++
    }
  }

  private register(
    hf: Heightfield,
    fireX: number,
    fireZ: number,
    potX: number,
    potZ: number,
    buildModels: boolean,
    nature?: ReadonlyMap<string, NatureGeometry>,
  ): void {
    const baseY = hf.height(fireX, fireZ)
    const root = new Group()
    root.position.set(fireX, baseY, fireZ)

    if (buildModels && nature) {
      const stones = nature.get('campfire_stones')
      if (stones) {
        const mesh = new Mesh(stones.geometry, stonesMaterial)
        // 石头圈按素材清单是 1.8m 宽，竖在草地上太厚了，压一圈
        mesh.scale.setScalar(0.72)
        mesh.castShadow = true
        mesh.receiveShadow = true
        root.add(mesh)
      }
      const logs = nature.get('campfire_logs')
      if (logs) {
        const mesh = new Mesh(logs.geometry, logsMaterial)
        mesh.scale.setScalar(0.62)
        mesh.position.y = 0.04
        mesh.castShadow = true
        root.add(mesh)
      }
      const pot = nature.get('pot_large')
      if (pot) {
        const mesh = new Mesh(pot.geometry, potMaterial)
        // 锅架在火边：偏 1.5 米、朝向火堆
        mesh.position.set(potX - fireX, hf.height(potX, potZ) - baseY, potZ - fireZ)
        mesh.rotation.y = Math.atan2(fireX - potX, fireZ - potZ)
        mesh.castShadow = true
        root.add(mesh)
      }
    }

    // ── 火焰：内焰亮黄、外焰橙红，两层的相位错开 ──
    const geo = flameGeometries()
    const phase = this.fires.length * 1.31

    const flameInner = new Mesh(geo.inner, innerFlameMaterial.clone())
    flameInner.position.y = 0.18
    root.add(flameInner)
    const flameOuter = new Mesh(geo.outer, outerFlameMaterial.clone())
    flameOuter.position.y = 0.14
    root.add(flameOuter)

    this.group.add(root)
    this.fires.push({
      position: new Vector3(fireX, baseY, fireZ),
      potPosition: new Vector3(potX, hf.height(potX, potZ), potZ),
      flameInner,
      flameOuter,
      phase,
    })
  }

  /** 离玩家最近的锅（在交互距离内），没有则 null */
  nearestPot(pos: Vector3): Campfire | null {
    let best: Campfire | null = null
    let bestD = COOK_RANGE
    for (const f of this.fires) {
      const d = Math.hypot(f.potPosition.x - pos.x, f.potPosition.z - pos.z)
      if (Math.abs(f.potPosition.y - pos.y) > 2.5) continue
      if (d < bestD) {
        bestD = d
        best = f
      }
    }
    return best
  }

  /** 火焰脉动。锥体缩放 + 透明度呼吸，比换贴图便宜得多 */
  update(dt: number): void {
    this.elapsed += dt
    for (const f of this.fires) {
      const t = this.elapsed * 5.2 + f.phase
      const wobble = Math.sin(t) * 0.12 + Math.sin(t * 1.7 + 1.1) * 0.07
      f.flameOuter.scale.set(1 + wobble, 1 + wobble * 1.6, 1 + wobble)
      f.flameInner.scale.set(1 - wobble * 0.7, 1 + wobble, 1 - wobble * 0.7)
      f.flameOuter.rotation.y = this.elapsed * 0.8 + f.phase
      const outerMat = f.flameOuter.material as MeshBasicMaterial
      outerMat.opacity = 0.5 + wobble * 0.8
    }
  }
}

// 共享材质：篝火五处共一份，火焰材质每堆 clone（透明度要各自脉动）。
// 素材几何是顶点着色的，必须用 vertexColors 材质才显色
const stonesMaterial = new MeshLambertMaterial({ vertexColors: true })
const logsMaterial = new MeshLambertMaterial({ vertexColors: true })
const potMaterial = new MeshLambertMaterial({ vertexColors: true })

// HDR 颜色：值超过 1 的部分交给 bloom 拉出光晕
const innerFlameMaterial = new MeshBasicMaterial({
  color: new Color(3.2, 2.4, 0.9),
  transparent: true,
  opacity: 0.85,
  blending: AdditiveBlending,
  depthWrite: false,
})
const outerFlameMaterial = new MeshBasicMaterial({
  color: new Color(2.6, 1.1, 0.35),
  transparent: true,
  opacity: 0.5,
  blending: AdditiveBlending,
  depthWrite: false,
})
