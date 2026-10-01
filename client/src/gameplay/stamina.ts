/**
 * 体力系统。
 *
 * 这是塞尔达式设计的**核心约束机制**：攀爬、游泳、滑翔、冲刺共享同一个
 * 体力池，于是"地形"本身变成了关卡——想抄近路直接爬崖？体力可能不够，
 * 得绕路。没有这个约束，攀爬就只是"按方向键上升"，地形也不再重要。
 *
 * 数值按下面这个思路定：所有消耗都换算成"满体力能撑几秒"。
 * 攀爬约 5.5 秒、冲刺 4.5 秒、游泳 10 秒、滑翔 14 秒——攀爬最贵，
 * 因为它能直接跨越地形障碍；滑翔最便宜，因为它本身就是"从高处慢慢下降"。
 */

export interface StaminaConfig {
  /** 体力上限。用 100 便于按百分比理解 */
  max: number
  /** 每秒恢复量 */
  regenRate: number
  /** 停止消耗后多久开始恢复（秒） */
  regenDelay: number
  /** 攀爬每秒消耗 */
  climbDrain: number
  /** 冲刺每秒消耗 */
  sprintDrain: number
  /** 游泳每秒消耗 */
  swimDrain: number
  /** 滑翔每秒消耗 */
  glideDrain: number
}

export const DEFAULT_STAMINA: StaminaConfig = {
  max: 100,
  regenRate: 46,
  regenDelay: 0.55,
  climbDrain: 18,
  sprintDrain: 22,
  swimDrain: 10,
  glideDrain: 7,
}

export class Stamina {
  readonly config: StaminaConfig
  current: number

  private cooldown = 0
  /** 本帧是否发生了消耗，供 UI 判断"正在被消耗"的状态 */
  draining = false

  constructor(config: Partial<StaminaConfig> = {}) {
    this.config = { ...DEFAULT_STAMINA, ...config }
    this.current = this.config.max
  }

  get ratio(): number {
    return this.config.max > 0 ? this.current / this.config.max : 0
  }

  get isEmpty(): boolean {
    return this.current <= 0.001
  }

  get isFull(): boolean {
    return this.current >= this.config.max - 0.001
  }

  /** 一次性消耗。体力不足时返回 false 且不扣减。 */
  consume(amount: number): boolean {
    if (this.current < amount) return false
    this.current -= amount
    this.cooldown = this.config.regenDelay
    this.draining = true
    return true
  }

  /**
   * 持续消耗（按每秒速率）。返回 false 表示体力已耗尽，
   * 调用方应据此中断攀爬/冲刺等行为。
   */
  drainContinuous(dt: number, ratePerSecond: number): boolean {
    const amount = ratePerSecond * dt
    if (this.current <= amount) {
      this.current = 0
      this.cooldown = this.config.regenDelay
      this.draining = true
      return false
    }
    this.current -= amount
    this.cooldown = this.config.regenDelay
    this.draining = true
    return true
  }

  /** 查询是否有足够体力做某事，不扣减 */
  canAfford(amount: number): boolean {
    return this.current >= amount
  }

  update(dt: number): void {
    this.draining = false
    if (this.cooldown > 0) {
      this.cooldown -= dt
      return
    }
    if (this.current < this.config.max) {
      this.current = Math.min(this.config.max, this.current + this.config.regenRate * dt)
    }
  }

  refill(): void {
    this.current = this.config.max
    this.cooldown = 0
  }
}
