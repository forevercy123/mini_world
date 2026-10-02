/**
 * 角色运动控制器（状态机版）。
 *
 * 用高度场做碰撞，不引入物理引擎——塞尔达式的角色移动需要的是
 * **可预测的手感**而不是真实的刚体行为，自己算反而更好调。
 *
 * 状态机：
 *
 *      ┌──────────┐  按下跳跃   ┌────────┐
 *      │  ground  │────────────▶│  air   │
 *      └────┬─────┘             └───┬────┘
 *           │ 遇陡坡且体力足          │ 空中再按跳跃
 *           ▼                       ▼
 *      ┌──────────┐            ┌──────────┐
 *      │  climb   │            │  glide   │
 *      └──────────┘            └──────────┘
 *           │ 任意状态进入水中        │
 *           ▼                       ▼
 *      ┌─────────────────────────────────┐
 *      │             swim                │
 *      └─────────────────────────────────┘
 *
 * 手感上的关键点（改参数前先理解这些为什么存在）：
 *  1. **陡坡沿等高线滑行**：体力不足时撞上陡坡不是硬停住，而是顺着山坡
 *     侧滑。硬停会让玩家觉得"撞到了看不见的墙"。
 *  2. **地面吸附**：下坡时若只靠重力下落，角色会一级级"弹"下去。
 *  3. **土狼时间 / 跳跃缓冲**：边缘起跳与落地前按跳跃的宽容处理。
 *  4. **跳跃与开伞共用空格**：靠"离地时间"区分——起跳瞬间是跳跃，
 *     空中再按才是开伞。没有这个延迟，起跳会立刻变成滑翔。
 */

import { Vector2, Vector3 } from 'three'
import type { Heightfield } from '../terrain/heightfield.ts'
import { Stamina, type StaminaConfig } from './stamina.ts'

export type MoveState = 'ground' | 'air' | 'climb' | 'glide' | 'swim'

export interface MoveInput {
  forward: number
  right: number
  jump: boolean
  sprint: boolean
}

export const EMPTY_INPUT: MoveInput = { forward: 0, right: 0, jump: false, sprint: false }

export interface CharacterConfig {
  walkSpeed: number
  runSpeed: number
  groundAccel: number
  groundDecel: number
  airAccel: number
  gravity: number
  jumpSpeed: number
  /** 可行走的最大坡度（弧度），超过则攀爬或侧滑 */
  maxSlopeAngle: number
  turnSpeed: number
  snapDistance: number
  coyoteTime: number

  // ── 闪避 ──
  /** 一次闪避持续多久 */
  dodgeDuration: number
  /** 闪避的初速，会随时间衰减到 0 */
  dodgeSpeed: number
  /** 闪避消耗的体力 */
  dodgeStamina: number
  /** 闪避的无敌时长（从起手算起） */
  dodgeInvuln: number
  jumpBufferTime: number
  radius: number
  height: number

  // ── 攀爬 ──
  climbSpeed: number
  /** 脱离攀爬的坡度阈值（比进入阈值低，避免在临界点上反复切换） */
  climbExitSlopeFactor: number

  // ── 滑翔 ──
  /** 滑翔时的恒定下落速度，远小于自由落体 */
  glideFallSpeed: number
  glideMoveSpeed: number
  /** 起跳后多久才允许开伞，避免跳跃瞬间误触 */
  glideArmDelay: number

  // ── 游泳 ──
  swimSpeed: number
  swimUpSpeed: number
  /** 体力耗尽时的下沉深度（不会沉到水底淹死，保持宽容） */
  drownDepth: number

  // ── 上升气流 ──
  /** 上升气流的最大托举速度（米/秒），足够强时滑翔会净爬升 */
  updraftLift: number

  /** 水面高度，与地形的水位常量必须一致 */
  waterLevel: number
}

export const DEFAULT_CHARACTER_CONFIG: CharacterConfig = {
  walkSpeed: 4.2,
  runSpeed: 7.2,
  groundAccel: 42,
  groundDecel: 52,
  airAccel: 12,
  gravity: 22,
  jumpSpeed: 8.6,
  maxSlopeAngle: (48 * Math.PI) / 180,
  turnSpeed: 13,
  snapDistance: 0.5,
  coyoteTime: 0.12,

  // 闪避：位移约 3.7 米、0.35 秒结束，无敌只覆盖前半段——
  // 全程无敌会让玩家把它当免费位移用，而不是"看准了再躲"。
  //
  // 速度值要按"位移 = 速度 × 时长 / 3"倒推（二次衰减的积分是 1/3）。
  // 直接给 13 只能是 1.5 米，还不够躲开一次攻击的前摇
  dodgeDuration: 0.35,
  dodgeSpeed: 32,
  dodgeStamina: 16,
  dodgeInvuln: 0.22,
  jumpBufferTime: 0.16,
  radius: 0.35,
  height: 1.7,

  climbSpeed: 2.1,
  climbExitSlopeFactor: 0.82,

  glideFallSpeed: 2.2,
  glideMoveSpeed: 8.6,
  glideArmDelay: 0.28,

  swimSpeed: 2.9,
  swimUpSpeed: 3.6,
  drownDepth: 2.4,

  updraftLift: 7.5,

  waterLevel: 11,
}

/**
 * 上升气流来源（火堆等）。用接口而不是直接引用 ElementGrid，
 * 免得角色控制器反过来依赖元素系统。
 */
export interface UpdraftSource {
  updraftAt(x: number, z: number): number
}

export class CharacterController {
  readonly position = new Vector3()
  readonly velocity = new Vector3()
  readonly config: CharacterConfig
  readonly stamina: Stamina

  yaw = 0
  grounded = false
  /** 当前运动状态 */
  state: MoveState = 'air'
  /** 本帧发生了状态切换，供视觉层播放过渡 */
  stateChanged = false
  justJumped = false
  justLanded = false
  /** 离地时长（秒），用于判断能否开伞 */
  airTime = 0
  /** 是否正在冲刺 */
  sprinting = false
  /**
   * 外部施加的移动速度倍率。出招时由战斗系统压低，制造"收不住脚"的手感。
   * 放在控制器外部控制，是为了不让移动逻辑反过来依赖战斗模块。
   */
  speedMultiplier = 1

  /** 上升气流来源（火堆等）。为 null 时滑翔按正常速度下落。 */
  updraftSource: UpdraftSource | null = null
  /** 本帧受到的上升气流强度 0–1，供 HUD 提示"正在被托起" */
  currentUpdraft = 0

  /**
   * 额外高程来源（冰面等）。返回 null 表示该处没有额外表面。
   *
   * 冰面结在水位高度、而其下的地形更低，只查地形高度的话角色会继续
   * 在水里游泳。叠上这一层，"站到冰上"就自然成立了——不需要在状态机
   * 里加任何特例。
   */
  extraSurfaceAt: ((x: number, z: number, feetY: number) => number | null) | null = null

  /**
   * 障碍物索引（树干等）。设置后角色移动会被推出障碍物，不再穿模。
   * 传 null 表示不做这项检查。
   */
  obstacles:
    | {
        resolve: (x: number, z: number, r: number, feetY: number) => { x: number; z: number }
        surfaceAt: (x: number, z: number, feetY: number, r: number) => number | null
        climbableAt: (
          x: number,
          z: number,
          r: number,
          reach?: number,
        ) => { x: number; z: number; radius: number; topY?: number; climbHeight?: number } | null
      }
    | null = null

  /**
   * 正在攀爬的柱子（树干、石柱）。null 表示在爬地形坡面。
   * 两者的移动逻辑完全不同：坡面按梯度走，柱子是按垂直方向上下
   */
  private climbPost: {
    x: number
    z: number
    radius: number
    topY?: number
    climbHeight?: number
  } | null = null

  private coyote = 0
  /** 剩余闪避时间，> 0 表示正在闪避 */
  private dodgeTimer = 0
  private dodgeElapsed = 0
  private readonly dodgeDir = new Vector2()
  /** 剩余无敌时间。闪避和受击无敌共用这一个计时器 */
  private dodgeInvulnTimer = 0
  private jumpBuffer = 0
  private prevJump = false
  private readonly gradient = new Vector2()

  constructor(config: Partial<CharacterConfig> = {}, staminaConfig: Partial<StaminaConfig> = {}) {
    this.config = { ...DEFAULT_CHARACTER_CONFIG, ...config }
    this.stamina = new Stamina(staminaConfig)
  }

  teleportTo(x: number, z: number, terrain: Heightfield): void {
    this.position.set(x, terrain.height(x, z), z)
    this.velocity.set(0, 0, 0)
    this.grounded = true
    this.state = 'ground'
    this.stateChanged = true
    this.coyote = this.config.coyoteTime
    this.jumpBuffer = 0
    this.airTime = 0
    this.dodgeTimer = 0
    this.dodgeInvulnTimer = 0
    this.stamina.refill()
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z)
  }

  /** 是否正在闪避。动画层据此播闪避动作 */
  get isDodging(): boolean {
    return this.dodgeTimer > 0
  }

  /** 闪避的无敌帧。玩家受伤判定读它 */
  get isInvulnerable(): boolean {
    return this.dodgeInvulnTimer > 0
  }

  /**
   * 朝指定方向闪避一次。
   * @returns 是否真的闪出去了（冷却中、离地、体力不够、没给方向都会失败）
   */
  dodge(dirX: number, dirZ: number): boolean {
    const cfg = this.config
    if (this.dodgeTimer > 0) return false
    // 只在地面闪。空中闪避会让跳跃的读秒失去意义——玩家可以一路闪现过悬崖
    if (!this.grounded) return false
    if (!this.stamina.canAfford(cfg.dodgeStamina)) return false

    const len = Math.hypot(dirX, dirZ)
    // 没给方向就朝正面闪，这是玩家的直觉预期
    if (len < 1e-4) {
      dirX = Math.sin(this.yaw)
      dirZ = Math.cos(this.yaw)
    } else {
      dirX /= len
      dirZ /= len
    }

    this.stamina.consume(cfg.dodgeStamina)
    this.dodgeDir.set(dirX, dirZ)
    this.dodgeTimer = cfg.dodgeDuration
    this.dodgeElapsed = 0
    this.dodgeInvulnTimer = cfg.dodgeInvuln
    this.yaw = Math.atan2(dirX, dirZ)
    return true
  }

  /** 攀爬、游泳、滑翔都不是"站在地上"的状态 */
  get isAirborne(): boolean {
    return this.state === 'air' || this.state === 'glide'
  }

  /**
   * 本帧是否被障碍物顶住了去路。由 updateWalk 的碰撞推出记录，
   * 是"对着柱子走"攀爬触发的前置条件——没被挡住就谈不上"抱住柱子"
   */
  blockedByObstacle = false

  update(
    dt: number,
    input: MoveInput,
    camForward: Vector3,
    camRight: Vector3,
    terrain: Heightfield,
  ): void {
    this.justJumped = false
    this.justLanded = false
    this.stateChanged = false
    // 无敌帧只跟真实时间走
    if (this.dodgeInvulnTimer > 0) this.dodgeInvulnTimer = Math.max(0, this.dodgeInvulnTimer - dt)

    // 按键边沿：跳跃与开伞共用空格，必须区分"刚按下"和"一直按着"
    const jumpPressed = input.jump && !this.prevJump
    this.prevJump = input.jump

    const groundH = this.groundHeight(terrain, this.position.x, this.position.z)
    const inWater = this.position.y < this.config.waterLevel - 0.15

    this.updateStateTransitions(jumpPressed, terrain, groundH, inWater)
    const switched = this.stateChanged

    // 对着树干或石头一直走 → 抱住它开始往上爬。
    //
    // 这是塞尔达式垂直移动的核心：地图上每根柱子都是潜在的路。判定放在
    // 状态切换之后，这样它只在"这一帧确实是地面状态"时才生效，不会把
    // 刚跳起来的人吸到树上。
    //
    // 触发前提是**这一帧真的被障碍物挡住了**（updateWalk 里碰撞推出
    // 把位移顶了回来）。少了这一条，从两棵树中间穿过、或者贴着树
    // 擦过去时，只要朝向夹角小于 60° 就会被"吸"到树上——玩家在
    // 空地上走得好好的，突然开始爬空气
    if (!switched && this.state === 'ground' && input.forward > 0.25 && this.blockedByObstacle) {
      // 判定裕量只给 0.1 米：必须真的贴住柱子。
      //
      // 碰撞推出会把角色停在 `障碍半径 + 身体半径` 处，所以只要裕量是正的
      // 就够触发；给大了就变成"离树还有半米就被吸住开始爬"，玩家感受到的是
      // 一堵看不见的墙
      const post = this.obstacles?.climbableAt?.(
        this.position.x,
        this.position.z,
        this.config.radius,
        0.1,
      )
      // 还得确实朝着它。收到 41° 锥以内：侧面擦过的树不算
      const facing = post
        ? (() => {
            const toX = post.x - this.position.x
            const toZ = post.z - this.position.z
            const len = Math.hypot(toX, toZ) || 1
            return Math.sin(this.yaw) * (toX / len) + Math.cos(this.yaw) * (toZ / len)
          })()
        : 0

      if (post && facing > 0.75) {
        this.state = 'climb'
        this.stateChanged = true
        this.climbPost = post
        this.grounded = false
        this.velocity.set(0, 0, 0)
        // 先把人抬离地面一点。
        //
        // 不抬的话，这一帧刚进 climb，下一帧的"爬到地面了"判定立刻成立，
        // 状态被退回 ground——两个状态每帧来回抖，速度反复清零，表现是
        // 角色抱着树一动不动。这一小段抬升就是让状态站住的那一步
        this.position.y += 0.12
        // 面朝柱子，爬的时候背对镜头看它
        this.yaw = Math.atan2(post.x - this.position.x, post.z - this.position.z)
      }
    }

    switch (this.state) {
      case 'climb':
        this.updateClimb(dt, input, terrain)
        break
      case 'glide':
        this.updateGlide(dt, input, camForward, camRight, terrain)
        break
      case 'swim':
        this.updateSwim(dt, input, camForward, camRight, terrain)
        break
      default:
        // 本帧刚切入攀爬时不再跑行走逻辑，避免同帧两套位移叠加
        if (!switched || this.state === 'ground' || this.state === 'air') {
          this.updateWalk(dt, input, camForward, camRight, terrain)
        }
    }

    if (this.state === 'ground') {
      this.airTime = 0
    } else {
      this.airTime += dt
    }

    this.stamina.update(dt)
  }

  // ─────────────────────────── 状态转换 ───────────────────────────

  private updateStateTransitions(
    jumpPressed: boolean,
    terrain: Heightfield,
    groundH: number,
    inWater: boolean,
  ): void {
    const cfg = this.config

    // 入水优先于一切（滑翔入水、攀爬入水都要切换）
    if (inWater && this.state !== 'swim') {
      this.state = 'swim'
      this.stateChanged = true
      this.velocity.y = Math.min(this.velocity.y, 0)
      return
    }

    if (this.state === 'swim') {
      // 上岸的判据是"脚下的地形本身高于水面"，即真的走到了陆地。
      // 早期版本用的是「位置高于脚下地形」，结果向上一浮出水面就会被
      // 判成上岸、切回地面状态再被重力拽回水里，在两个状态间反复横跳。
      const landAboveWater = groundH > cfg.waterLevel - 0.3
      if (!inWater && landAboveWater) {
        this.state = 'ground'
        this.stateChanged = true
        this.grounded = true
      }
      return
    }

    if (this.state === 'climb') {
      // 爬地形坡面时的到顶判定（爬柱子的情况在 updateClimb 里单独处理）
      if (this.climbPost) return
      // 爬到顶：坡度变缓到可以行走。
      // 必须用 slopeAngle()（弧度）而**不是** slope()（0–1 的归一化值）——
      // 后者与 maxSlopeAngle 量纲不同，比较结果恒为真，角色会刚进入攀爬
      // 就被判定爬到顶，在 ground/climb 之间反复横跳。
      const exitAngle = cfg.maxSlopeAngle * cfg.climbExitSlopeFactor
      if (terrain.slopeAngle(this.position.x, this.position.z) < exitAngle) {
        this.state = 'ground'
        this.stateChanged = true
        this.grounded = true
        return
      }
      // 按跳跃蹬离崖面
      if (jumpPressed) {
        this.state = 'air'
        this.stateChanged = true
        this.velocity.set(0, cfg.jumpSpeed * 0.8, 0)
        this.airTime = 0
      }
      return
    }

    if (this.state === 'glide') {
      // 再按一次空格收伞
      if (jumpPressed && this.airTime > cfg.glideArmDelay) {
        this.state = 'air'
        this.stateChanged = true
      }
      return
    }

    // 空中按跳跃 → 开伞
    if (this.state === 'air' && jumpPressed && this.airTime > cfg.glideArmDelay) {
      if (this.stamina.canAfford(2)) {
        this.state = 'glide'
        this.stateChanged = true
      }
    }
  }

  // ─────────────────────────── 地面 / 空中 ───────────────────────────

  private updateWalk(
    dt: number,
    input: MoveInput,
    camForward: Vector3,
    camRight: Vector3,
    terrain: Heightfield,
  ): void {
    const cfg = this.config

    let dirX = camForward.x * input.forward + camRight.x * input.right
    let dirZ = camForward.z * input.forward + camRight.z * input.right
    const inputLen = Math.hypot(dirX, dirZ)
    if (inputLen > 1e-4) {
      dirX /= inputLen
      dirZ /= inputLen
    }

    const wantsMove = inputLen > 0.08
    const strength = Math.min(1, inputLen)

    // 冲刺：仅在地面、正在移动、且有体力时生效
    this.sprinting = input.sprint && this.grounded && wantsMove && this.stamina.canAfford(1)
    if (this.sprinting) {
      this.stamina.drainContinuous(dt, this.stamina.config.sprintDrain)
    }

    // ── 闪避：位移由曲线决定，完全接管这一帧的水平速度 ──
    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt
      this.dodgeElapsed += dt
      const k = Math.max(0, this.dodgeTimer / cfg.dodgeDuration)
      // 二次衰减：起步就是最快，然后迅速收住。线性衰减的尾巴太长，
      // 看起来像"滑出去"而不是"闪一下"
      const speed = cfg.dodgeSpeed * k * k
      // 直接赋值而不是 approach：闪避要的是瞬时爆发，走加速度曲线会软掉
      this.velocity.x = this.dodgeDir.x * speed
      this.velocity.z = this.dodgeDir.y * speed
      this.sprinting = false
    } else {
      const targetSpeed = (this.sprinting ? cfg.runSpeed : cfg.walkSpeed) * strength * this.speedMultiplier
      const accel = this.grounded ? (wantsMove ? cfg.groundAccel : cfg.groundDecel) : cfg.airAccel
      const maxDelta = accel * dt
      this.velocity.x = approach(this.velocity.x, dirX * targetSpeed, maxDelta)
      this.velocity.z = approach(this.velocity.z, dirZ * targetSpeed, maxDelta)
    }

    // 跳跃。不消耗体力——塞尔达里跳跃是免费的，否则体力见底时连跳都跳不了，
    // 玩家会以为是按键失灵。体力的约束作用留给攀爬、游泳、冲刺、滑翔。
    this.coyote = this.grounded ? cfg.coyoteTime : Math.max(0, this.coyote - dt)
    this.jumpBuffer = input.jump ? cfg.jumpBufferTime : Math.max(0, this.jumpBuffer - dt)
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.velocity.y = cfg.jumpSpeed
      this.grounded = false
      this.state = 'air'
      this.stateChanged = true
      this.coyote = 0
      this.jumpBuffer = 0
      this.airTime = 0
      this.justJumped = true
      return
    }

    // 水平位移与坡度约束
    const stepLen = Math.hypot(this.velocity.x, this.velocity.z) * dt
    if (stepLen > 1e-5) {
      const fromH = this.groundHeight(terrain, this.position.x, this.position.z)
      const toX = this.position.x + this.velocity.x * dt
      const toZ = this.position.z + this.velocity.z * dt
      const toH = this.groundHeight(terrain, toX, toZ)
      const climbTan = (toH - fromH) / stepLen

      if (climbTan > Math.tan(cfg.maxSlopeAngle)) {
        // 坡度超出可行走范围：体力够就转攀爬，否则沿等高线侧滑
        if (wantsMove && this.grounded && this.stamina.canAfford(3)) {
          this.state = 'climb'
          this.stateChanged = true
          this.velocity.set(0, 0, 0)
          return
        }
        terrain.gradient(this.position.x, this.position.z, this.gradient)
        const gLen = this.gradient.length()
        if (gLen > 1e-5) {
          const tanX = -this.gradient.y / gLen
          const tanZ = this.gradient.x / gLen
          const along = this.velocity.x * tanX + this.velocity.z * tanZ
          this.velocity.x = tanX * along
          this.velocity.z = tanZ * along
        } else {
          this.velocity.x = 0
          this.velocity.z = 0
        }
      }
      this.position.x += this.velocity.x * dt
      this.position.z += this.velocity.z * dt

      // 推出障碍物。放在水平位移之后、垂直处理之前——
      // 如果先算垂直，角色会被塞进树里再修正，视觉上会闪一下。
      if (this.obstacles) {
        const beforeX = this.position.x
        const beforeZ = this.position.z
        const fixed = this.obstacles.resolve(
          this.position.x,
          this.position.z,
          cfg.radius,
          this.position.y,
        )
        this.position.x = fixed.x
        this.position.z = fixed.z
        // 本帧是否真的被障碍顶住了（期望位移与实际位移的差）。
        // 攀爬只在这种"想走走不动"的时刻才允许触发
        const pushed = Math.hypot(fixed.x - beforeX, fixed.z - beforeZ)
        this.blockedByObstacle = pushed > 0.01
      }
    }

    // 垂直位移与地面碰撞
    this.velocity.y -= cfg.gravity * dt
    this.position.y += this.velocity.y * dt

    const groundH = this.groundHeight(terrain, this.position.x, this.position.z)
    const wasGrounded = this.grounded

    if (this.position.y <= groundH) {
      this.position.y = groundH
      if (this.velocity.y < 0) this.velocity.y = 0
      this.grounded = true
      this.state = 'ground'
    } else if (this.velocity.y <= 0 && this.position.y <= groundH + cfg.snapDistance) {
      this.position.y = groundH
      this.velocity.y = 0
      this.grounded = true
      this.state = 'ground'
    } else {
      this.grounded = false
      this.state = 'air'
    }

    if (this.grounded && !wasGrounded) {
      this.justLanded = true
    }

    if (wantsMove) {
      this.turnTowards(Math.atan2(dirX, dirZ), dt)
    }
  }

  // ─────────────────────────── 攀爬 ───────────────────────────

  /**
   * 攀爬时用的是**坡面参考系**而不是相机参考系：W 沿梯度向上、A/D 沿等高线
   * 横向移动。用相机参考系会让玩家在仰视崖壁时按 W 却往水平方向走。
   */
  private updateClimb(dt: number, input: MoveInput, terrain: Heightfield): void {
    const cfg = this.config

    // ── 爬柱子（树干、石柱） ──
    if (this.climbPost) {
      const post = this.climbPost
      const groundY = terrain.height(this.position.x, this.position.z)
      const topY = post.topY ?? groundY + (post.climbHeight ?? 3.5)

      if (!this.stamina.drainContinuous(dt, this.stamina.config.climbDrain)) {
        this.climbPost = null
        this.state = 'air'
        this.stateChanged = true
        this.velocity.set(0, 0, 0)
        this.airTime = 0
        return
      }

      // W 向上、S 向下
      this.position.y += input.forward * cfg.climbSpeed * dt

      // 爬上顶：能站的（石头）就翻上去站住，不能站的（树）停在顶部
      if (this.position.y >= topY) {
        if (post.topY !== undefined) {
          this.position.y = post.topY
          this.state = 'ground'
          this.stateChanged = true
          this.grounded = true
        } else {
          this.position.y = topY
        }
        this.climbPost = null
        // 从顶面位置再确认一次，避免双脚悬空
        this.position.y = Math.max(this.position.y, this.groundHeight(terrain, this.position.x, this.position.z))
        return
      }

      // 爬回地面：只有主动往下爬时才判定。
      //
      // 不能只看高度——刚抱住树时人就在地面高度，那样会立刻掉回 ground，
      // 变成两个状态每帧抖动
      if (input.forward < -0.1 && this.position.y <= groundY + 0.05) {
        this.position.y = groundY
        this.state = 'ground'
        this.stateChanged = true
        this.grounded = true
        this.climbPost = null
        return
      }

      // 蹬开柱子
      if (input.jump) {
        this.climbPost = null
        this.state = 'air'
        this.stateChanged = true
        this.velocity.set(0, cfg.jumpSpeed * 0.75, 0)
        this.airTime = 0
        return
      }

      // 保持贴附：把角色吸附到柱子表面。少了这一步，碰撞推出会把人推离
      // 柱子，下一帧就够不着了，攀爬会一进入就掉出来
      const dx = this.position.x - post.x
      const dz = this.position.z - post.z
      const dist = Math.hypot(dx, dz) || 1e-4
      // 吸附距离与碰撞推出的距离保持一致。比它近的话，攀爬时角色会
      // 略微陷进树干，而碰撞系统又想把人物推出去——两者每帧对着拉
      const want = post.radius + cfg.radius
      this.position.x = post.x + (dx / dist) * want
      this.position.z = post.z + (dz / dist) * want
      return
    }

    if (!this.stamina.drainContinuous(dt, this.stamina.config.climbDrain)) {
      // 体力耗尽，脱手下落
      this.state = 'air'
      this.stateChanged = true
      this.velocity.set(0, 0, 0)
      this.airTime = 0
      return
    }

    terrain.gradient(this.position.x, this.position.z, this.gradient)
    const gLen = this.gradient.length()

    let moveX = 0
    let moveZ = 0
    if (gLen > 1e-4) {
      const upX = this.gradient.x / gLen
      const upZ = this.gradient.y / gLen
      const sideX = -upZ
      const sideZ = upX
      moveX = upX * input.forward + sideX * input.right
      moveZ = upZ * input.forward + sideZ * input.right
    }

    const len = Math.hypot(moveX, moveZ)
    if (len > 0.01) {
      moveX /= len
      moveZ /= len
      this.position.x += moveX * cfg.climbSpeed * dt
      this.position.z += moveZ * cfg.climbSpeed * dt
      this.turnTowards(Math.atan2(moveX, moveZ), dt)
    }

    // 始终吸附在崖面上
    this.position.y = this.groundHeight(terrain, this.position.x, this.position.z)
    this.velocity.set(0, 0, 0)
    this.grounded = false
  }

  // ─────────────────────────── 滑翔 ───────────────────────────

  private updateGlide(
    dt: number,
    input: MoveInput,
    camForward: Vector3,
    camRight: Vector3,
    terrain: Heightfield,
  ): void {
    const cfg = this.config

    if (!this.stamina.drainContinuous(dt, this.stamina.config.glideDrain)) {
      this.state = 'air'
      this.stateChanged = true
      return
    }

    let dirX = camForward.x * input.forward + camRight.x * input.right
    let dirZ = camForward.z * input.forward + camRight.z * input.right
    const len = Math.hypot(dirX, dirZ)
    if (len > 1e-4) {
      dirX /= len
      dirZ /= len
    }

    // 水平速度平滑趋近，给滑翔一点惯性，转向不会太生硬
    const k = Math.min(1, dt * 2.6)
    this.velocity.x += (dirX * cfg.glideMoveSpeed - this.velocity.x) * k
    this.velocity.z += (dirZ * cfg.glideMoveSpeed - this.velocity.z) * k
    // 下降速度。滑翔的常态是恒定缓降；但若下方有火堆，上升气流会托住
    // 甚至抬升——"点火 → 气流 → 飞得更高"是元素引擎与滑翔的接点。
    let fallSpeed = -cfg.glideFallSpeed
    this.currentUpdraft = this.updraftSource
      ? this.updraftSource.updraftAt(this.position.x, this.position.z)
      : 0
    if (this.currentUpdraft > 0) {
      fallSpeed += this.currentUpdraft * cfg.updraftLift
    }
    this.velocity.y = fallSpeed

    this.position.x += this.velocity.x * dt
    this.position.y += this.velocity.y * dt
    this.position.z += this.velocity.z * dt

    const groundH = this.groundHeight(terrain, this.position.x, this.position.z)
    if (this.position.y <= groundH) {
      this.position.y = groundH
      this.velocity.y = 0
      this.stateChanged = true
      this.justLanded = true
      this.state = this.position.y < cfg.waterLevel - 0.15 ? 'swim' : 'ground'
      this.grounded = this.state === 'ground'
    }

    if (len > 0.08) {
      this.turnTowards(Math.atan2(dirX, dirZ), dt)
    }
  }

  // ─────────────────────────── 游泳 ───────────────────────────

  private updateSwim(
    dt: number,
    input: MoveInput,
    camForward: Vector3,
    camRight: Vector3,
    terrain: Heightfield,
  ): void {
    const cfg = this.config

    const hasStamina = this.stamina.drainContinuous(dt, this.stamina.config.swimDrain)

    let dirX = camForward.x * input.forward + camRight.x * input.right
    let dirZ = camForward.z * input.forward + camRight.z * input.right
    const len = Math.hypot(dirX, dirZ)
    if (len > 1e-4) {
      dirX /= len
      dirZ /= len
    }

    const k = Math.min(1, dt * 3.2)
    this.velocity.x += (dirX * cfg.swimSpeed - this.velocity.x) * k
    this.velocity.z += (dirZ * cfg.swimSpeed - this.velocity.z) * k

    // 垂直：按跳跃上浮，否则被浮力拉向水面。
    // 体力耗尽时目标深度下沉，制造压迫感，但不会真的淹死——
    // 沉到 drownDepth 就停住并缓慢回复，避免"游一半必死"的挫败。
    if (hasStamina && input.jump) {
      this.velocity.y = cfg.swimUpSpeed
    } else {
      const targetY = hasStamina
        ? cfg.waterLevel - 0.35
        : cfg.waterLevel - cfg.drownDepth
      this.velocity.y += (targetY - this.position.y) * 5.0 * dt
      this.velocity.y *= 0.86
    }

    this.position.x += this.velocity.x * dt
    this.position.y += this.velocity.y * dt
    this.position.z += this.velocity.z * dt

    // 不能穿过水底地形
    const groundH = this.groundHeight(terrain, this.position.x, this.position.z)
    if (this.position.y < groundH) {
      this.position.y = groundH
      this.velocity.y = Math.max(0, this.velocity.y)
    }

    this.grounded = false

    if (len > 0.08) {
      this.turnTowards(Math.atan2(dirX, dirZ), dt)
    }
  }

  // ─────────────────────────── 工具 ───────────────────────────

  /**
   * 脚下的实际可站立高度：地形高度，或其上的额外表面（冰面、石头顶面）。
   *
   * 额外表面必须接受脚底高度这个参数，且**只接受不高于脚底的表面**——
   * 否则角色走到石头旁边就会被自动抬到石头顶上，等于隔空爬石头。
   * 跳跃时脚底升到石头之上，下一次查询它才成立，于是"跳上去"是跳出来的。
   */
  private groundHeight(terrain: Heightfield, x: number, z: number): number {
    let h = terrain.height(x, z)
    if (this.extraSurfaceAt) {
      const extra = this.extraSurfaceAt(x, z, this.position.y)
      if (extra !== null && extra > h) h = extra
    }
    return h
  }

  private turnTowards(targetYaw: number, dt: number): void {
    const delta = angleDelta(this.yaw, targetYaw)
    const maxTurn = this.config.turnSpeed * dt
    this.yaw += Math.abs(delta) < maxTurn ? delta : Math.sign(delta) * maxTurn
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current
  if (Math.abs(diff) <= maxDelta) return target
  return current + Math.sign(diff) * maxDelta
}

function angleDelta(from: number, to: number): number {
  let d = to - from
  while (d > Math.PI) d -= Math.PI * 2
  while (d <= -Math.PI) d += Math.PI * 2
  return d
}
