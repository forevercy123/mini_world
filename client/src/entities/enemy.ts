/**
 * 敌人：低多边形小怪 + 行为状态机。
 *
 * 状态流转：
 *   idle ──玩家进入警戒范围──▶ chase ──进入攻击距离──▶ attack
 *     ▲                          │                      │
 *     └────────玩家跑远───────────┘◀─────出招结束────────┘
 *                  │
 *              被击中 ──▶ hurt ──▶ chase
 *
 * 几个刻意的设计：
 *  - 追击有"脱战距离"，比警戒距离远。否则玩家在边界徘徊时，敌人会
 *    一步一停地抖动。
 *  - 受击进入短暂硬直，且硬直期间仍保留击退惯性。没有硬直的话，
 *    连续攻击无法压制敌人，战斗会变成互相对拼血量。
 *  - 死亡不是立刻消失，而是下沉缩小——瞬间消失会让玩家怀疑"打死没打死"。
 */

import { Group, Vector3 } from 'three'
import { buildEnemyRig, type EnemyRig } from './enemyVisual.ts'
import { EnemyHealthBar } from './enemyHealthBar.ts'
import { ENEMY_KINDS, type EnemyKind } from './enemyKind.ts'
import { createSkeletonRig, type SkeletonTemplate } from './enemySkeleton.ts'
import { Health } from '../gameplay/health.ts'
import type { AttackTarget } from '../gameplay/playerCombat.ts'
import type { Heightfield } from '../terrain/heightfield.ts'
import type { ItemId } from '../gameplay/inventory.ts'

export type EnemyState = 'idle' | 'chase' | 'attack' | 'hurt' | 'dead'

export interface EnemyConfig {
  maxHealth: number
  /** 进入警戒的距离 */
  aggroRange: number
  /** 脱战距离，必须大于警戒距离 */
  leashRange: number
  /** 进入攻击的距离 */
  attackRange: number
  moveSpeed: number
  damage: number
  /** 一次攻击动作的总时长 */
  attackDuration: number
  /** 出招后多久结算伤害 */
  attackHitTime: number
  /** 两次攻击之间的间隔 */
  attackCooldown: number
  hurtDuration: number
  knockbackDamping: number
}

export const DEFAULT_ENEMY: EnemyConfig = {
  maxHealth: 3,
  aggroRange: 18,
  leashRange: 30,
  attackRange: 2.2,
  moveSpeed: 3.4,
  damage: 1,
  attackDuration: 0.72,
  attackHitTime: 0.34,
  attackCooldown: 1.15,
  hurtDuration: 0.34,
  knockbackDamping: 7,
}

const FLASH_DURATION = 0.16
/** 攻击能够到的高度差（米）。超过这个高度差就够不着，爪子是横扫的 */
const ATTACK_HEIGHT_REACH = 2.0

const DEATH_DURATION = 0.85
/** 骨架的倒地动作约 1.9 秒，得等它播完再移除，否则尸体会在半途消失 */
const DEATH_DURATION_ANIMATED = 2.1

export class Enemy implements AttackTarget {
  readonly position = new Vector3()
  readonly velocity = new Vector3()
  readonly health: Health
  readonly config: EnemyConfig
  readonly object = new Group()

  yaw = 0
  state: EnemyState = 'idle'
  /**
   * 死亡后要等多久才能移除。
   * 骨架自带倒地动作时等它播完（约 1.9 秒），否则用短时长——
   * 手写版没有动画，留太久只会看到一具缩小的模型杵在那
   */
  /** 这个敌人该掉什么 */
  get loot(): readonly ItemId[] {
    return ENEMY_KINDS[this.kind].loot
  }

  private get deathHold(): number {
    return this.rig.playDeath ? DEATH_DURATION_ANIMATED : DEATH_DURATION
  }

  /** 死亡动画播完，可以从场景移除 */
  get expired(): boolean {
    return this.state === 'dead' && this.deathTimer >= this.deathHold
  }

  /**
   * 头顶血条。注意它**不挂在 object 下面**——object 会跟着 yaw 旋转，
   * 血条挂进去就永远正对不了镜头。由 EnemyManager 挂到自己的场景节点上，
   * 每帧按敌人的世界坐标摆放
   */
  readonly healthBar = new EnemyHealthBar()

  /**
   * 还没结算掉落。由外部在检测到死亡时消费一次——
   * 放在外部而不是在这里调 pickups，是为了不让敌人模块依赖背包系统
   */
  lootPending = true

  /** 种类。生成时写入，掉落和提示都读它 */
  kind: EnemyKind = 'minion'

  private readonly rig: EnemyRig

  private hurtTimer = 0
  private attackTimer = 0
  private attackCooldown = 0
  private damageApplied = false
  private flashTimer = 0
  private deathTimer = 0
  private animTime = 0
  private walkPhase = 0

  /**
   * @param skeleton 骷髅模型模板。传了就长成骷髅，没传则回退到手写外观
   *   （模型加载失败时也不会让敌人消失）
   */
  constructor(config: Partial<EnemyConfig> = {}, skeleton?: SkeletonTemplate | null) {
    this.config = { ...DEFAULT_ENEMY, ...config }
    this.health = new Health(this.config.maxHealth)

    this.rig = skeleton ? createSkeletonRig(skeleton) : buildEnemyRig()
    this.object.add(this.rig.root)
    this.object.name = 'enemy'
    this.walkPhase = Math.random() * Math.PI * 2
  }

  /** 放置到指定位置（生成时用） */
  spawnAt(x: number, z: number, terrain: Heightfield): void {
    this.position.set(x, terrain.height(x, z), z)
    this.velocity.set(0, 0, 0)
    this.object.position.copy(this.position)
  }

  onHit(damage: number, knockbackDir: Vector3, knockbackForce: number): void {
    if (this.health.isDead) return
    if (!this.health.damage(damage)) return

    this.velocity.x = knockbackDir.x * knockbackForce
    this.velocity.z = knockbackDir.z * knockbackForce
    this.flashTimer = FLASH_DURATION

    if (this.health.isDead) {
      this.state = 'dead'
      this.deathTimer = 0
      this.rig.torso.rotation.z = 0
      this.rig.playDeath?.()
      return
    }

    this.state = 'hurt'
    this.hurtTimer = this.config.hurtDuration
    // 挨打才亮血条：一直挂着会变成血条展览，也失去"这一下疼不疼"的反馈
    this.healthBar.setRatio(this.health.current / this.health.max)
    this.healthBar.flash()
  }

  /**
   * @param onDamagePlayer 命中玩家时回调。带上自身位置，让外部能算出
   *   击退方向——只传伤害数值的话，玩家被打了却不知道从哪边挨的。
   */
  update(
    dt: number,
    playerPos: Vector3,
    terrain: Heightfield,
    onDamagePlayer: (amount: number, fromPos: Vector3) => void,
  ): void {
    this.health.update(dt)
    this.animTime += dt

    if (this.state === 'dead') {
      this.deathTimer += dt
      this.integrateKnockback(dt, terrain)
      this.updateVisual(dt)
      return
    }

    if (this.attackCooldown > 0) this.attackCooldown -= dt

    const dx = playerPos.x - this.position.x
    const dz = playerPos.z - this.position.z
    const dist = Math.hypot(dx, dz)

    switch (this.state) {
      case 'idle':
        if (dist < this.config.aggroRange) this.state = 'chase'
        break

      case 'chase':
        if (dist > this.config.leashRange) {
          this.state = 'idle'
        } else if (dist < this.config.attackRange && this.attackCooldown <= 0) {
          this.state = 'attack'
          this.attackTimer = 0
          this.damageApplied = false
          // 触发骨架自带的挥砍动作。它的起手就是前摇，比程序化摆手自然
          this.rig.playAttack?.()
        } else if (dist > this.config.attackRange * 0.85) {
          this.moveToward(dx, dz, dist, dt, terrain)
        } else {
          // 已经在攻击距离内、只是还在冷却：站定转身，别再往前挤。
          //
          // 少了这一支，冷却那 1.15 秒里敌人会继续朝玩家推进，一路贴到
          // 角色身上叠成一个——看起来像穿模，实际是"没有停步距离"。
          this.faceToward(dx, dz, dist, dt)
        }
        break

      case 'attack':
        this.attackTimer += dt
        this.faceToward(dx, dz, dist, dt)
        if (!this.damageApplied && this.attackTimer >= this.config.attackHitTime) {
          this.damageApplied = true
          // 出招后玩家可能已经闪开，命中要重新判定距离与高度。
          //
          // 高度差这一项不能省：爪子是横扫的，够不到头顶两米以上的人。
          // 少了它，玩家爬上树、站在石头上都会被树下的怪隔空挠到，
          // 而画面上完全看不出自己为什么掉血
          const heightGap = Math.abs(this.position.y - playerPos.y)
          if (dist < this.config.attackRange + 0.6 && heightGap < ATTACK_HEIGHT_REACH) {
            onDamagePlayer(this.config.damage, this.position)
          }
        }
        if (this.attackTimer >= this.config.attackDuration) {
          this.state = 'chase'
          this.attackCooldown = this.config.attackCooldown
        }
        break

      case 'hurt':
        this.hurtTimer -= dt
        this.integrateKnockback(dt, terrain)
        if (this.hurtTimer <= 0) this.state = 'chase'
        break
    }

    this.updateVisual(dt)
  }

  private moveToward(dx: number, dz: number, dist: number, dt: number, terrain: Heightfield): void {
    if (dist < 1e-4) return
    const nx = dx / dist
    const nz = dz / dist

    this.position.x += nx * this.config.moveSpeed * dt
    this.position.z += nz * this.config.moveSpeed * dt
    this.position.y = terrain.height(this.position.x, this.position.z)

    this.faceToward(dx, dz, dist, dt)
  }

  /** 击退惯性：指数衰减，比线性衰减更自然 */
  private integrateKnockback(dt: number, terrain: Heightfield): void {
    const damp = Math.exp(-this.config.knockbackDamping * dt)
    this.velocity.x *= damp
    this.velocity.z *= damp

    this.position.x += this.velocity.x * dt
    this.position.z += this.velocity.z * dt
    this.position.y = terrain.height(this.position.x, this.position.z)
  }

  private faceToward(dx: number, dz: number, dist: number, dt: number): void {
    if (dist < 1e-4) return
    const target = Math.atan2(dx, dz)
    let delta = target - this.yaw
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta <= -Math.PI) delta += Math.PI * 2
    const maxTurn = 9 * dt
    this.yaw += Math.abs(delta) < maxTurn ? delta : Math.sign(delta) * maxTurn
  }

  private updateVisual(dt: number): void {
    // 骨骼版敌人要先把基础动画推进到本帧并记下基准旋转；手写版没有这个
    // 钩子，是空操作。必须在写摆动之前调，否则基准记的是上一帧的姿势。
    //
    // 把追击速度喂进去，骨架才知道该播走还是该播跑
    const moveSpeed = this.state === 'chase' || this.state === 'attack' ? this.config.moveSpeed : 0
    this.rig.update?.(dt, moveSpeed)

    // 骨骼版自带走路动画，程序化摆腿只留两成做"步伐的摇晃感"。
    // 手写版没有动画，全靠这一项，所以保持原幅度
    const procedural = this.rig.syncPose ? 0.2 : 1

    this.object.position.copy(this.position)
    this.object.rotation.y = this.yaw

    // 受击闪白。
    //
    // 原来是闪红，但暗红在绿草地上看着像"敌人身上着了火"，而不是"我打中
    // 它了"。白色是纯粹的受击信号，且亮到能压过它本身的贴图颜色。
    // 数值给到 2 以上是 HDR：走 ACES 色调映射后仍然扎眼，普通白色会被压灰。
    const mat = this.rig.materials[0]
    if (this.flashTimer > 0) {
      this.flashTimer -= dt
      const t = Math.max(0, this.flashTimer / FLASH_DURATION)
      mat.emissive.setRGB(t * 2.6, t * 2.5, t * 2.3)
    } else {
      mat.emissive.setRGB(0, 0, 0)
    }

    if (this.state === 'dead') {
      // 骨架自带倒地动作时，什么都别叠加。
      //
      // 原来那套"缩小 + 下沉"是没有动画时的替代方案，套在真实倒地动画上
      // 就成了双重表现——人会一边侧倒一边缩进地里，看起来像陷进地面。
      if (!this.rig.playDeath) {
        const t = Math.min(1, this.deathTimer / DEATH_DURATION)
        this.object.scale.setScalar(1 - t * 0.55)
        this.rig.torso.rotation.z = t * 1.4
        this.object.position.y -= t * 0.5
      }
    } else {
      // ── 走路：追击时腿交替摆动，站定时归位 ──
      const moving = this.state === 'chase'
      this.walkPhase += dt * (moving ? 8.5 : 2)
      const swing = moving ? Math.sin(this.walkPhase) * 0.72 * procedural : 0
      this.rig.legL.rotation.x = swing
      this.rig.legR.rotation.x = -swing
      this.rig.armL.rotation.x = -swing * 0.6

      // ── 挥爪：先蓄力后劈出 ──
      //
      // 原来是 `sin(t·π)`，一条平滑的抬起-放下曲线，第一帧就在动。
      // 玩家看到的是一只爪子匀速划过去，没有"要打你了"的预告。
      // 改成两段：前 45% 把手往后收（负角度），之后快速劈出到最大伸展。
      // 命中判定落在 47% 处，正好是收手转劈出的那一刻。
      if (this.state === 'attack') {
        const t = Math.min(1, this.attackTimer / this.config.attackDuration)
        const windupEnd = 0.45
        const lunge =
          t < windupEnd
            ? -0.45 * (t / windupEnd)
            : -0.45 + 1.45 * ((t - windupEnd) / (1 - windupEnd))
        // 攻击用完整幅度，不能乘 procedural。
        // 那个系数是留给走路的（骨骼版有走路动画，程序化摆腿只留两成做
        // 摇晃感），把它一起套在攻击上，前摇就从 44° 缩到 9°，等于没有
        this.rig.armL.rotation.x = -1.7 * lunge
        this.rig.armR.rotation.x = -1.7 * lunge
        this.rig.torso.rotation.x = 0.34 * Math.max(0, lunge)
      } else {
        this.rig.armR.rotation.x = swing * 0.6
        const lean = moving ? 0.16 : 0
        this.rig.torso.rotation.x += (lean - this.rig.torso.rotation.x) * Math.min(1, dt * 7)
      }

      // 呼吸起伏：站着不动时也有生气。骨骼版靠缩放 torso 表达不出来
      //（pivot 只同步旋转），所以改成整体轻微起伏
      const breath = Math.sin(this.animTime * 2.6) * 0.04
      this.rig.torso.scale.set(1 + breath, 1 - breath, 1 + breath)
    }

    // 摆动写完了，叠加到骨骼上
    this.rig.syncPose?.()
  }

  dispose(): void {
    this.healthBar.dispose()
    this.rig.dispose?.()
    for (const g of this.rig.geometries) g.dispose()
    for (const m of this.rig.materials) m.dispose()
  }
}
