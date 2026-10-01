/**
 * 敌人的外观构建。
 *
 * 从 Enemy 的 AI 逻辑里拆出来，因为"长什么样"和"怎么行动"是两件独立
 * 的事，混在一个文件里两边都难改。
 *
 * 关键取舍：**静态部件全部合并成一个几何、用顶点色区分材质**。
 * 一个有头有脸有四肢的怪大约十几个部件，逐个建模材会让 8 只怪吃掉
 * 一百多个 draw call；合并后静态部分只剩 1 个，加上需要独立摆动的
 * 四肢，每只怪 5 个。顶点色还省掉了多套材质的切换开销。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export interface EnemyRig {
  /** 根节点，位置与朝向由 AI 控制 */
  root: Group
  /**
   * 会随攻击动作前倾、受击时后仰的上半身。
   * 手写版是 Group，骨骼版是驱动骨骼用的 pivot——两者都只要能被写
   * `rotation` 就行，所以类型放宽到 Object3D。
   */
  torso: Object3D
  armL: Object3D
  armR: Object3D
  legL: Object3D
  legR: Object3D
  /** 只用一种材质（顶点色区分部件），数组形式是为了统一 dispose */
  materials: MeshLambertMaterial[]
  geometries: BufferGeometry[]
  /**
   * 骨骼版专用：每帧推进基础动画并记录基准旋转，手写版不需要。
   * @param speed 水平速度（米/秒），用来挑走/跑动作并按比例调播放速率
   */
  update?(dt: number, speed?: number): void
  /** 骨骼版专用：把 pivot 上的摆动叠加到骨骼。必须在设完 rotation 之后调 */
  syncPose?(): void
  /** 骨骼版专用：播一次攻击动作（自带前摇与收招） */
  playAttack?(): void
  /** 骨骼版专用：播一次倒地动作 */
  playDeath?(): void
  /** 骨骼版专用：停掉动画混合器。几何体是共享的，不在这里释放 */
  dispose?(): void
}

const SKIN = 0x9c4a3f
const SKIN_DARK = 0x7a342c
const CLOTH = 0x5c4a35
const EYE_WHITE = 0xf2ece0
const PUPIL = 0x1a1a20
const TOOTH = 0xeee6d4

const HIP_Y = 0.42
const SHOULDER_Y = 0.86

export function buildEnemyRig(): EnemyRig {
  const geometries: BufferGeometry[] = []
  const materials: MeshLambertMaterial[] = []

  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true })
  materials.push(material)

  const root = new Group()
  const torso = new Group()
  root.add(torso)

  // ── 静态部分：躯干、头、口鼻、耳朵、角、眼睛，合并成一个几何 ──
  const staticParts: BufferGeometry[] = []

  // 躯干：上窄下宽的矮胖形体，比正球更有"生物"感
  const body = new CylinderGeometry(0.34, 0.42, 0.44, 7)
  body.translate(0, HIP_Y + 0.2, 0)
  paint(body, SKIN)
  staticParts.push(body)

  // 肚皮：浅色的一块，让正面有层次
  const belly = new SphereGeometry(0.3, 8, 6)
  belly.scale(0.85, 0.7, 0.55)
  belly.translate(0, HIP_Y + 0.16, 0.16)
  paint(belly, SKIN_DARK)
  staticParts.push(belly)

  // 头：略扁的球
  const head = new SphereGeometry(0.28, 10, 8)
  head.scale(1, 0.92, 0.95)
  head.translate(0, 1.02, 0)
  paint(head, SKIN)
  staticParts.push(head)

  // 口鼻：向前突出，是辨认"正脸"的关键
  const snout = new SphereGeometry(0.16, 8, 6)
  snout.scale(1, 0.8, 1.15)
  snout.translate(0, 0.96, 0.22)
  paint(snout, SKIN_DARK)
  staticParts.push(snout)

  // 獠牙：两颗向上翘的小锥，野性来源
  for (const side of [-1, 1]) {
    const tusk = new ConeGeometry(0.035, 0.13, 4)
    tusk.rotateX(-0.35)
    tusk.translate(0.075 * side, 0.9, 0.3)
    paint(tusk, TOOTH)
    staticParts.push(tusk)
  }

  // 尖耳朵
  for (const side of [-1, 1]) {
    const ear = new ConeGeometry(0.07, 0.2, 4)
    ear.rotateZ((Math.PI / 2) * -side)
    ear.rotateX(-0.3)
    ear.translate(0.26 * side, 1.08, -0.02)
    paint(ear, SKIN_DARK)
    staticParts.push(ear)
  }

  // 头顶的角
  const horn = new ConeGeometry(0.08, 0.26, 5)
  horn.translate(0, 1.28, -0.02)
  paint(horn, 0x6b2f28)
  staticParts.push(horn)

  // 眼睛：眼白 + 瞳孔 + 一点高光。三层是让眼神"活"起来的最小配置。
  for (const side of [-1, 1]) {
    const white = new SphereGeometry(0.075, 8, 6)
    white.scale(1, 1.1, 0.7)
    white.translate(0.11 * side, 1.06, 0.22)
    paint(white, EYE_WHITE)
    staticParts.push(white)

    const pupil = new SphereGeometry(0.038, 7, 6)
    pupil.scale(1, 1.15, 0.7)
    pupil.translate(0.115 * side, 1.05, 0.27)
    paint(pupil, PUPIL)
    staticParts.push(pupil)
  }

  const merged = mergeGeometries(staticParts, false)
  if (merged) {
    for (const g of staticParts) g.dispose()
    geometries.push(merged)
    const mesh = new Mesh(merged, material)
    mesh.castShadow = true
    torso.add(mesh)
  }

  // ── 四肢：需要独立旋转，各自成组 ──
  const makeLimb = (
    side: number,
    pivotY: number,
    radius: number,
    length: number,
    color: number,
    foot: boolean,
  ): Group => {
    const pivot = new Group()
    pivot.position.set(0.3 * side, pivotY, 0)

    const parts: BufferGeometry[] = []
    const limb = new CylinderGeometry(radius * 0.85, radius, length, 5)
    limb.translate(0, -length / 2, 0)
    paint(limb, color)
    parts.push(limb)

    if (foot) {
      const footGeo = new SphereGeometry(radius * 1.25, 7, 5)
      footGeo.scale(1, 0.6, 1.3)
      footGeo.translate(0, -length, 0.05)
      paint(footGeo, SKIN_DARK)
      parts.push(footGeo)
    }

    const geo = mergeGeometries(parts, false)
    for (const g of parts) g.dispose()
    if (geo) {
      geometries.push(geo)
      const mesh = new Mesh(geo, material)
      mesh.castShadow = true
      pivot.add(mesh)
    }
    return pivot
  }

  const armL = makeLimb(-1, SHOULDER_Y, 0.09, 0.36, SKIN, false)
  const armR = makeLimb(1, SHOULDER_Y, 0.09, 0.36, SKIN, false)
  const legL = makeLimb(-1, HIP_Y, 0.11, 0.36, CLOTH, true)
  const legR = makeLimb(1, HIP_Y, 0.11, 0.36, CLOTH, true)

  torso.add(armL, armR)
  root.add(legL, legR)

  return { root, torso, armL, armR, legL, legR, materials, geometries }
}

/** 给整个几何刷上同一个顶点色 */
function paint(geometry: BufferGeometry, color: number): void {
  const c = new Color(color)
  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
}

/** 供外部微调朝向用的常量 */
export const ENEMY_FORWARD = new Vector3(0, 0, 1)
