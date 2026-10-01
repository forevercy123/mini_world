/**
 * 键盘输入 → 角色移动输入的映射。
 *
 * 每帧复用同一个对象而不是新建，避免在 60FPS 下产生持续的 GC 压力。
 * 因此调用方只能读取，不要修改返回的对象。
 */

import { type MoveInput } from '../gameplay/characterController.ts'

export class KeyboardInput {
  /** 关闭时忽略全部按键，用于把控制权让给其他控制方式 */
  enabled = true

  /** 外部（鼠标点击）可以置位，下一次 consumeAttack 时会被消费掉 */
  attackQueued = false

  private readonly keys = new Set<string>()
  private readonly result: MoveInput = { forward: 0, right: 0, jump: false, sprint: false }
  private prevAttackKey = false
  private prevIgniteKey = false
  private prevFreezeKey = false
  private prevUseKey = false
  private prevInteractKey = false
  private prevShockKey = false
  private prevDodgeKey = false
  private prevGustKey = false

  constructor() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    this.keys.add(e.code)
    // 空格默认会滚动页面，角色模式下要拦掉
    if (e.code === 'Space') e.preventDefault()
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code)
  }

  private onBlur = (): void => {
    this.keys.clear()
  }

  /** 读取本帧输入。返回值是复用的对象，请勿修改。 */
  read(): MoveInput {
    if (!this.enabled) {
      this.result.forward = 0
      this.result.right = 0
      this.result.jump = false
      this.result.sprint = false
      return this.result
    }

    const k = this.keys
    this.result.forward =
      (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
    this.result.right =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    this.result.jump = k.has('Space')
    this.result.sprint = k.has('ShiftLeft') || k.has('ShiftRight')
    return this.result
  }

  /**
   * 消费一次攻击输入。返回 true 表示本帧刚触发攻击。
   *
   * 做边沿检测：按住不放只算一次，避免连续触发把战斗变成无脑连点。
   * 键盘（J）和鼠标点击两条来源共用这个出口，优先级由谁先置位决定。
   */
  consumeAttack(): boolean {
    if (!this.enabled) {
      this.attackQueued = false
      this.prevAttackKey = false
      return false
    }
    const held = this.keys.has('KeyJ')
    const edge = held && !this.prevAttackKey
    this.prevAttackKey = held

    const queued = this.attackQueued
    this.attackQueued = false
    return edge || queued
  }

  /** 消费一次点火输入（F 键）。同样是边沿检测。 */
  consumeIgnite(): boolean {
    if (!this.enabled) {
      this.prevIgniteKey = false
      return false
    }
    const held = this.keys.has('KeyF')
    const edge = held && !this.prevIgniteKey
    this.prevIgniteKey = held
    return edge
  }

  /** 消费一次冻结输入（R 键） */
  consumeFreeze(): boolean {
    if (!this.enabled) {
      this.prevFreezeKey = false
      return false
    }
    const held = this.keys.has('KeyR')
    const edge = held && !this.prevFreezeKey
    this.prevFreezeKey = held
    return edge
  }

  /** 消费一次使用物品输入（G 键） */
  consumeUse(): boolean {
    if (!this.enabled) {
      this.prevUseKey = false
      return false
    }
    const held = this.keys.has('KeyG')
    const edge = held && !this.prevUseKey
    this.prevUseKey = held
    return edge
  }

  /**
   * 消费一次交互输入（E 键）：和贤者说话、翻对话页。
   *
   * 对话期间调用方会把 enabled 关掉以冻结移动，但**不能**因此让 E 失效——
   * 否则对话框一弹出来就再也翻不了页。所以这里和其它 consume 不同，
   * 不看 enabled，只看边沿。
   */
  consumeInteract(): boolean {
    const held = this.keys.has('KeyE')
    const edge = held && !this.prevInteractKey
    this.prevInteractKey = held
    return edge
  }

  /** 消费一次放电输入（T 键） */
  consumeShock(): boolean {
    if (!this.enabled) {
      this.prevShockKey = false
      return false
    }
    const held = this.keys.has('KeyT')
    const edge = held && !this.prevShockKey
    this.prevShockKey = held
    return edge
  }

  /** 消费一次闪避输入（Q 键） */
  consumeDodge(): boolean {
    if (!this.enabled) {
      this.prevDodgeKey = false
      return false
    }
    const held = this.keys.has('KeyQ')
    const edge = held && !this.prevDodgeKey
    this.prevDodgeKey = held
    return edge
  }

  /** 消费一次起风输入（V 键） */
  consumeGust(): boolean {
    if (!this.enabled) {
      this.prevGustKey = false
      return false
    }
    const held = this.keys.has('KeyV')
    const edge = held && !this.prevGustKey
    this.prevGustKey = held
    return edge
  }

  /** 对话期间要把按键状态清干净，避免关掉对话的瞬间角色还在往前跑 */
  clearHeld(): void {
    this.keys.clear()
    this.prevAttackKey = false
    this.prevIgniteKey = false
    this.prevFreezeKey = false
    this.prevUseKey = false
    this.prevInteractKey = false
  }

  /** 是否按着某个键，供调试快捷键使用 */
  isDown(code: string): boolean {
    return this.keys.has(code)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }
}
