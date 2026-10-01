/**
 * 第三人称跟随相机。
 *
 * 三个手感要点：
 *  1. 位置用**帧率无关的指数平滑**跟随角色（`1 - exp(-k·dt)`），
 *     直接用 `lerp(target, 0.2)` 这类固定系数会导致不同帧率下手感不一致。
 *  2. 相机与角色之间隔着地形时自动拉近，防止镜头穿进山体。
 *  3. `yaw` 同时是角色移动的参考系——按 W 是朝相机前方走，而不是世界坐标的某个固定方向。
 *     这是第三人称操作之所以"跟手"的根本原因。
 */

import { Vector3, type PerspectiveCamera } from 'three'
import type { GroundSampler } from '../core/flyControls.ts'

export interface ThirdPersonCameraConfig {
  /** 默认距离（米） */
  distance: number
  minDistance: number
  maxDistance: number
  /** 注视点相对角色原点的高度偏移，一般抬到胸口位置 */
  targetHeight: number
  /** 相机仰角范围（弧度）。正值表示相机在角色上方俯视。 */
  minPitch: number
  maxPitch: number
  sensitivity: number
  /** 位置跟随锐度，越大越跟手；8 左右比较跟手又不抖 */
  followSharpness: number
  /** 距离变化的平滑锐度，避免碰撞回避时镜头忽近忽远 */
  distanceSharpness: number
}

export const DEFAULT_TPC_CONFIG: ThirdPersonCameraConfig = {
  distance: 6.5,
  minDistance: 1.8,
  maxDistance: 14,
  targetHeight: 1.4,
  minPitch: 0.02,
  maxPitch: 1.15,
  sensitivity: 0.0026,
  followSharpness: 9,
  distanceSharpness: 7,
}

export class ThirdPersonCamera {
  readonly config: ThirdPersonCameraConfig
  /** 关闭时忽略全部输入，用于把控制权让给自由飞行模式 */
  enabled = true
  yaw = 0
  pitch = 0.32

  private readonly camera: PerspectiveCamera
  private readonly dom: HTMLElement
  private readonly ground: GroundSampler

  private readonly smoothedTarget = new Vector3()
  private currentDistance: number
  private dragging = false
  private initialized = false

  private readonly _offset = new Vector3()
  private readonly _probe = new Vector3()
  private readonly _forward = new Vector3()
  private readonly _right = new Vector3()

  constructor(
    camera: PerspectiveCamera,
    dom: HTMLElement,
    ground: GroundSampler,
    config: Partial<ThirdPersonCameraConfig> = {},
  ) {
    this.camera = camera
    this.dom = dom
    this.ground = ground
    this.config = { ...DEFAULT_TPC_CONFIG, ...config }
    this.currentDistance = this.config.distance

    dom.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('blur', this.onBlur)
  }

  /** 相机前方在水平面上的投影，角色移动以此为参考 */
  get forward(): Vector3 {
    return this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
  }

  /** 相机右方在水平面上的投影 */
  get right(): Vector3 {
    return this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || e.target !== this.dom) return
    this.dragging = true
    this.dom.setPointerCapture?.(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragging) return
    this.rotate(e.movementX, e.movementY)
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled || e.target !== this.dom) return
    e.preventDefault()
    const next = this.config.distance + e.deltaY * 0.006
    this.config.distance = Math.min(this.config.maxDistance, Math.max(this.config.minDistance, next))
  }

  private onBlur = (): void => {
    this.dragging = false
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * this.config.sensitivity
    this.pitch += dy * this.config.sensitivity
    this.pitch = Math.min(this.config.maxPitch, Math.max(this.config.minPitch, this.pitch))
  }

  /** 立即把相机贴到目标背后，用于传送或初始化时避免镜头飞掠 */
  snapTo(targetPos: Vector3): void {
    this.smoothedTarget.copy(targetPos)
    this.initialized = true
    this.applyPosition()
  }

  update(dt: number, targetPos: Vector3): void {
    if (!this.initialized) {
      this.snapTo(targetPos)
      return
    }

    // 帧率无关的指数平滑
    const alpha = 1 - Math.exp(-this.config.followSharpness * dt)
    this.smoothedTarget.lerp(targetPos, alpha)

    // 先把注视点抬高到胸口，再解算相机位置
    this.applyPosition(dt)
  }

  private applyPosition(dt = 0): void {
    const { targetHeight, minDistance } = this.config

    const pivotX = this.smoothedTarget.x
    const pivotY = this.smoothedTarget.y + targetHeight
    const pivotZ = this.smoothedTarget.z

    const cosPitch = Math.cos(this.pitch)
    const dirX = Math.sin(this.yaw) * cosPitch
    const dirY = Math.sin(this.pitch)
    const dirZ = Math.cos(this.yaw) * cosPitch

    // 沿视线方向探测地形，遇到遮挡就把相机拉近
    const desired = this.config.distance
    const steps = 6
    let allowed = desired
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * desired
      const px = pivotX + dirX * t
      const py = pivotY + dirY * t
      const pz = pivotZ + dirZ * t
      if (py < this.ground.heightAt(px, pz) + 0.45) {
        allowed = Math.max(minDistance, t - desired / steps)
        break
      }
    }

    // 距离变化也做平滑，否则贴着山坡走时镜头会一跳一跳
    if (dt > 0) {
      const k = 1 - Math.exp(-this.config.distanceSharpness * dt)
      this.currentDistance += (allowed - this.currentDistance) * k
    } else {
      this.currentDistance = allowed
    }

    this._offset.set(dirX, dirY, dirZ).multiplyScalar(this.currentDistance)
    this.camera.position.set(pivotX + this._offset.x, pivotY + this._offset.y, pivotZ + this._offset.z)

    this._probe.set(pivotX, pivotY, pivotZ)
    this.camera.lookAt(this._probe)
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('blur', this.onBlur)
  }
}
