/**
 * 生命值与无敌帧。
 *
 * 玩家和敌人共用这一套：差别只在数值。无敌帧不是可选项——没有它，
 * 一次接触会在连续几帧里反复结算伤害，玩家瞬间暴毙。塞尔达里被击中后
 * 会有短暂闪烁并短暂免疫，这个时长决定了战斗的容错感。
 */

export class Health {
  readonly max: number
  current: number

  private invulnTimer = 0
  /** 最近一次受伤后经过的时间，供表现层做闪红/闪烁 */
  sinceDamage = Number.POSITIVE_INFINITY

  constructor(max: number) {
    this.max = max
    this.current = max
  }

  get isDead(): boolean {
    return this.current <= 0
  }

  get isInvulnerable(): boolean {
    return this.invulnTimer > 0
  }

  get ratio(): number {
    return this.max > 0 ? this.current / this.max : 0
  }

  /**
   * 扣血。处于无敌帧或已死亡时返回 false 且不生效——
   * 调用方据此判断"这一击是否真的打中了"。
   */
  damage(amount: number, invulnDuration = 0.9): boolean {
    if (this.isDead || this.isInvulnerable) return false
    this.current = Math.max(0, this.current - amount)
    this.invulnTimer = invulnDuration
    this.sinceDamage = 0
    return true
  }

  heal(amount: number): void {
    if (this.isDead) return
    this.current = Math.min(this.max, this.current + amount)
  }

  /** 读档时直接设定当前值。会夹到 [0, max] 之内 */
  set(value: number): void {
    this.current = Math.max(0, Math.min(this.max, Math.round(value)))
    this.sinceDamage = Number.POSITIVE_INFINITY
  }

  refill(): void {
    this.current = this.max
    this.invulnTimer = 0
    this.sinceDamage = Number.POSITIVE_INFINITY
  }

  update(dt: number): void {
    if (this.invulnTimer > 0) this.invulnTimer = Math.max(0, this.invulnTimer - dt)
    if (this.sinceDamage < Number.POSITIVE_INFINITY) this.sinceDamage += dt
  }
}
