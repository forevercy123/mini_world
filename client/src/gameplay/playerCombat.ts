/**
 * 玩家近战。
 *
 * 攻击做成一条时间轴（前摇 → 命中判定 → 后摇），而不是"按下即命中"。
 * 这样挥砍才有重量感，也给玩家留出预判空间——按下立刻造成伤害的
 * 战斗会退化成无脑连点。
 *
 * 命中判定是**水平面上的扇形**，只比较水平方向。带上高度差的话，
 * 站在斜坡下方砍不到坡上的敌人，玩家会觉得"明明够得着却打不中"。
 */

import { Vector3 } from 'three'
import type { Health } from './health.ts'

/**
 * 可被攻击的目标。用接口而不是直接依赖 Enemy 类，
 * 避免战斗模块与敌人模块互相引用，将来加可破坏物也能复用。
 */
export interface AttackTarget {
  readonly position: Vector3
  readonly health: Health
  /** 被命中时由目标自己处理扣血、击退与硬直 */
  onHit(damage: number, knockbackDir: Vector3, knockbackForce: number): void
}

export interface CombatConfig {
  /** 前摇：按下到出刀的时间 */
  windup: number
  /** 命中判定的时刻（相对攻击开始） */
  hitMoment: number
  /** 整个攻击动作的时长 */
  duration: number
  /** 动作结束后的冷却 */
  cooldown: number
  /** 攻击距离（米） */
  range: number
  /** 攻击扇形的总张角（弧度） */
  arcRadians: number
  damage: number
  knockbackForce: number
  /** 攻击期间的移动速度倍率，压低才有"出招时收不住脚"的感觉 */
  moveSpeedFactor: number
}

export const DEFAULT_COMBAT: CombatConfig = {
  // 前摇从 0.08 加长到 0.2 秒，总时长从 0.34 拉到 0.58。
  //
  // 原来的时间轴短得看不见：按下鼠标那一刻剑已经挥完了，玩家感受不到
  // "我在出招"，只看到敌人掉血。0.2 秒的举剑既让动作读得出来，又没有
  // 慢到影响手感——而且这点延迟正是"不能无脑连点"的来源。
  // 这三个数要和 ModelAvatar 里的 ATTACK_ANIM_SECONDS 对齐。
  windup: 0.2,
  hitMoment: 0.27,
  duration: 0.58,
  cooldown: 0.1,
  range: 2.6,
  arcRadians: (100 * Math.PI) / 180,
  damage: 1,
  // 从 7.5 提到 10：命中时敌人明显被推开，才读得出"这一下打实了"。
  // 再高会把敌人推出攻击范围，连招接不上
  knockbackForce: 10,
  moveSpeedFactor: 0.35,
}

export class PlayerCombat {
  readonly config: CombatConfig

  attacking = false
  /** 攻击进度 0–1，供动画层摆动武器 */
  progress = 0
  /** 本帧是否刚触发命中判定，供音效/特效使用 */
  justHit = false

  private timer = 0
  private hitApplied = false
  private cooldownTimer = 0
  private readonly hits: AttackTarget[] = []

  constructor(config: Partial<CombatConfig> = {}) {
    this.config = { ...DEFAULT_COMBAT, ...config }
  }

  get isCoolingDown(): boolean {
    return this.cooldownTimer > 0
  }

  /** 攻击中或冷却中，用于限制其他动作 */
  get isBusy(): boolean {
    return this.attacking || this.cooldownTimer > 0
  }

  /**
   * @param trigger 本帧是否按下了攻击
   * @returns 本次命中判定命中的目标列表（可能为空）
   */
  update(
    dt: number,
    attackerPos: Vector3,
    attackerYaw: number,
    trigger: boolean,
    targets: readonly AttackTarget[],
  ): readonly AttackTarget[] {
    if (this.cooldownTimer > 0) this.cooldownTimer -= dt

    this.justHit = false

    // 起手：必须不在攻击中且冷却结束。不做输入缓冲——
    // 连点时就该按不下去，否则会变成自动连招。
    if (!this.attacking && trigger && this.cooldownTimer <= 0) {
      this.attacking = true
      this.timer = 0
      this.hitApplied = false
      this.progress = 0
    }

    this.hits.length = 0

    if (!this.attacking) return this.hits

    this.timer += dt
    this.progress = Math.min(1, this.timer / this.config.duration)

    if (!this.hitApplied && this.timer >= this.config.hitMoment) {
      this.hitApplied = true
      this.performHit(attackerPos, attackerYaw, targets)
      this.justHit = this.hits.length > 0
    }

    if (this.timer >= this.config.duration) {
      this.attacking = false
      this.progress = 0
      this.cooldownTimer = this.config.cooldown
    }

    return this.hits
  }

  private performHit(
    pos: Vector3,
    yaw: number,
    targets: readonly AttackTarget[],
  ): void {
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const cosHalfArc = Math.cos(this.config.arcRadians / 2)

    for (const target of targets) {
      if (target.health.isDead) continue

      const dx = target.position.x - pos.x
      const dz = target.position.z - pos.z
      const dist = Math.hypot(dx, dz)
      if (dist > this.config.range || dist < 1e-4) continue

      const dot = (dx * fx + dz * fz) / dist
      if (dot < cosHalfArc) continue

      _knockback.set(dx / dist, 0, dz / dist)
      target.onHit(this.config.damage, _knockback, this.config.knockbackForce)
      this.hits.push(target)
    }
  }

  /** 移动速度倍率：出招时收脚 */
  get moveFactor(): number {
    return this.attacking ? this.config.moveSpeedFactor : 1
  }

  reset(): void {
    this.attacking = false
    this.timer = 0
    this.cooldownTimer = 0
    this.progress = 0
    this.hitApplied = false
  }
}

const _knockback = new Vector3()
