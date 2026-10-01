/**
 * 自由飞行相机控制：鼠标拖拽转向 + WASD 移动。
 *
 * 没有用 PointerLockControls，因为性能测试需要频繁切换到面板改参数，
 * 每次都要重新点击锁定很烦。拖拽式操作更适合这种反复试的场景。
 */

import { Euler, Vector3, type PerspectiveCamera } from 'three'

export interface GroundSampler {
  heightAt: (x: number, z: number) => number
}

export class FlyController {
  /** 关闭时忽略全部输入，用于把控制权让给角色模式 */
  enabled = true
  /** 移动速度（米/秒） */
  speed = 26
  /** 开启后相机自动保持在地面以上，用于模拟玩家贴地视角 */
  groundFollow = false
  /** 贴地模式下离地高度（米） */
  clearance = 2.5
  /** 鼠标灵敏度 */
  sensitivity = 0.0024

  private readonly keys = new Set<string>()
  private dragging = false
  private yaw = 0
  private pitch = 0
  private readonly euler = new Euler(0, 0, 0, 'YXZ')
  private readonly forward = new Vector3()
  private readonly right = new Vector3()

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly ground?: GroundSampler,
  ) {
    this.syncFromCamera()
    dom.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  /** 用相机当前朝向初始化 yaw/pitch，避免一上来视角跳变 */
  private syncFromCamera(): void {
    this.euler.setFromQuaternion(this.camera.quaternion)
    this.yaw = this.euler.y
    this.pitch = this.euler.x
  }

  /** 外部（如巡检）直接改了相机朝向时，让控制器跟上 */
  syncFrom(camera: PerspectiveCamera): void {
    this.euler.setFromQuaternion(camera.quaternion)
    this.yaw = this.euler.y
    this.pitch = this.euler.x
  }

  private onPointerDown = (e: PointerEvent): void => {
    // 只响应画布上的拖拽，面板上的操作不旋转视角
    if (!this.enabled || e.target !== this.dom) return
    this.dragging = true
    this.dom.setPointerCapture?.(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.dragging) return
    this.yaw -= e.movementX * this.sensitivity
    this.pitch -= e.movementY * this.sensitivity
    // 限制俯仰，避免翻转
    const limit = Math.PI / 2 - 0.02
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch))
    this.euler.set(this.pitch, this.yaw, 0, 'YXZ')
    this.camera.quaternion.setFromEuler(this.euler)
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  private onBlur = (): void => {
    this.keys.clear()
    this.dragging = false
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return
    // 面板里输入数字时不要触发移动
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    this.keys.add(e.code)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  update(dt: number): void {
    if (!this.enabled) return
    const k = this.keys
    let fwd = 0
    let side = 0
    let up = 0

    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1
    if (k.has('KeyA') || k.has('ArrowLeft')) side -= 1
    if (k.has('KeyD') || k.has('ArrowRight')) side += 1
    if (k.has('KeyE') || k.has('Space')) up += 1
    if (k.has('KeyQ')) up -= 1

    if (fwd === 0 && side === 0 && up === 0) {
      if (this.groundFollow) this.applyGroundFollow()
      return
    }

    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1
    const distance = this.speed * boost * dt

    // 前向按视线方向（可以俯冲/爬升），右向保持在水平面
    this.camera.getWorldDirection(this.forward)
    this.right.set(this.forward.z, 0, -this.forward.x).normalize()

    this.camera.position.addScaledVector(this.forward, fwd * distance)
    this.camera.position.addScaledVector(this.right, side * distance)
    this.camera.position.y += up * distance

    if (this.groundFollow) this.applyGroundFollow()
  }

  private applyGroundFollow(): void {
    if (!this.ground) return
    const { x, z } = this.camera.position
    const groundY = this.ground.heightAt(x, z) + this.clearance
    if (this.camera.position.y < groundY) this.camera.position.y = groundY
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }
}
