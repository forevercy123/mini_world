/**
 * 箭矢抛射物。
 *
 * 一根箭的一生：离弦 → 抛物线飞行 → 扎在目标或地面上 → 停一会儿消失。
 * 抛物线是手感的核心——激光一样笔直的箭没有"弓"的感觉，
 * 玩家必须学会抬高一点枪口去够远处的目标，这才是射箭。
 *
 * 渲染用 InstancedMesh 池化：箭的飞行以秒计，同屏最多十几支，
 * 池化复用避免反复分配。命中检测是"箭与目标的水平距离"，
 * 加上高度容差——箭从敌人头顶掠过去不算中。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Heightfield } from '../terrain/heightfield.ts'
import type { AttackTarget } from '../gameplay/playerCombat.ts'

/** 同屏箭矢上限 */
const MAX_ARROWS = 16
/** 箭矢飞行速度（米/秒）。弩比弓快而平，但也要有下坠 */
const ARROW_SPEED = 34
/** 命中后箭停留时间（秒） */
const STUCK_SECONDS = 3.5
/** 重力（米/秒²）。比真实小，箭才不会几十米就扎进地里 */
const GRAVITY = 12

export interface ArrowHit {
  target: AttackTarget
  point: Vector3
}

interface Arrow {
  active: boolean
  stuck: boolean
  stuckFor: number
  position: Vector3
  velocity: Vector3
}

export class ArrowField {
  readonly group = new Group()
  private readonly mesh: InstancedMesh
  private readonly arrows: Arrow[] = []
  private readonly matrix = new Matrix4()
  private readonly quaternion = new Quaternion()
  private readonly scale = new Vector3(1, 1, 1)
  private readonly up = new Vector3(0, 1, 0)
  private readonly dir = new Vector3()

  constructor() {
    this.group.name = 'arrows'
    const material = new MeshLambertMaterial({ vertexColors: true })
    this.mesh = new InstancedMesh(createArrowGeometry(), material, MAX_ARROWS)
    this.mesh.frustumCulled = false
    this.mesh.castShadow = true
    this.group.add(this.mesh)
    for (let i = 0; i < MAX_ARROWS; i++) {
      this.arrows.push({
        active: false,
        stuck: false,
        stuckFor: 0,
        position: new Vector3(),
        velocity: new Vector3(),
      })
    }
  }

  get activeCount(): number {
    let n = 0
    for (const a of this.arrows) if (a.active) n++
    return n
  }

  /**
   * 射出一支箭。
   * @param from 出射点（角色手部高度）
   * @param dirYaw 水平朝向
   * @param pitch 仰角：弓要稍微抬头够远
   */
  fire(from: Vector3, dirYaw: number, pitch = 0.06): void {
    const arrow = this.arrows.find((a) => !a.active) ?? this.arrows[0]
    arrow.active = true
    arrow.stuck = false
    arrow.stuckFor = 0
    arrow.position.copy(from)
    const cp = Math.cos(pitch)
    arrow.velocity.set(
      Math.sin(dirYaw) * cp * ARROW_SPEED,
      Math.sin(pitch) * ARROW_SPEED,
      Math.cos(dirYaw) * cp * ARROW_SPEED,
    )
  }

  /**
   * 推进全部箭。返回本帧命中的目标列表（由外部结算伤害与特效）。
   */
  update(
    dt: number,
    terrain: Heightfield,
    targets: readonly AttackTarget[],
    hitsOut: ArrowHit[],
  ): void {
    hitsOut.length = 0

    let write = 0
    for (const arrow of this.arrows) {
      if (!arrow.active) continue

      if (arrow.stuck) {
        arrow.stuckFor += dt
        if (arrow.stuckFor >= STUCK_SECONDS) {
          arrow.active = false
          continue
        }
      } else {
        // 抛物线飞行
        arrow.velocity.y -= GRAVITY * dt
        arrow.position.addScaledVector(arrow.velocity, dt)

        // 命中敌人：水平距离 + 高度容差
        for (const target of targets) {
          if (target.health.isDead) continue
          const dx = target.position.x - arrow.position.x
          const dz = target.position.z - arrow.position.z
          const dy = target.position.y + 0.9 - arrow.position.y
          if (dx * dx + dz * dz < 0.72 * 0.72 && Math.abs(dy) < 1.25) {
            hitsOut.push({ target, point: arrow.position })
            arrow.active = false
            break
          }
        }
        if (!arrow.active) continue

        // 扎进地面
        const groundY = terrain.height(arrow.position.x, arrow.position.z)
        if (arrow.position.y <= groundY + 0.06) {
          arrow.position.y = groundY + 0.06
          arrow.stuck = true
        }
        // 飞出太远就回收
        if (arrow.position.y < -20) arrow.active = false
        if (!arrow.active) continue
      }

      // 写实例矩阵：箭杆沿速度方向
      this.dir.copy(arrow.velocity).normalize()
      this.quaternion.setFromUnitVectors(this.up, this.dir)
      this.matrix.compose(arrow.position, this.quaternion, this.scale)
      this.mesh.setMatrixAt(write, this.matrix)
      write++
    }

    this.mesh.count = write
    this.mesh.instanceMatrix.needsUpdate = true
  }

  clear(): void {
    for (const a of this.arrows) a.active = false
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshLambertMaterial).dispose()
    this.mesh.dispose()
  }
}

/**
 * 一支箭的几何：细长箭杆 + 锥形箭头 + 尾部两片羽。
 * 原点在杆中心，长度沿 Y 轴——飞行时用速度方向对齐它。
 */
function createArrowGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []

  const shaft = new CylinderGeometry(0.014, 0.014, 0.62, 5)
  paint(shaft, 0x8a6a42)
  parts.push(shaft)

  const head = new ConeGeometry(0.03, 0.11, 5)
  head.translate(0, 0.36, 0)
  paint(head, 0xb8bcc2)
  parts.push(head)

  for (const side of [-1, 1]) {
    const feather = new ConeGeometry(0.028, 0.12, 4)
    feather.scale(1, 1, 0.35)
    feather.rotateX(-0.35)
    feather.translate(side * 0.035, -0.27, 0)
    paint(feather, 0xe8e4da)
    parts.push(feather)
  }

  const merged = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  return merged
}

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
