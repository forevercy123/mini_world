/**
 * 战斗的视觉反馈：命中火花与挥砍轨迹。
 *
 * 之前打完一场架，玩家只能从"敌人掉血了"推断自己打中了——没有任何
 * 即时的视听回馈。动作游戏的打击感有一大半来自**击中那一刻的反馈**，
 * 而不是伤害数字本身。
 *
 * 两件事：
 *  - **命中火花**：击中点的扩散圆环。玩家打中敌人、敌人打中玩家都触发
 *  - **挥砍轨迹**：剑扫过时的一道弧光，给攻击一个"体积"，让挥剑不再
 *    只是手臂转了个角度
 *
 * 全部预分配、循环复用。战斗一秒内可能触发好几次，运行时 new 对象
 * 是给 GC 找麻烦。
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three'

/** 同时存在的火花上限 */
const SPARK_COUNT = 10
/** 火花存活时间（秒） */
const SPARK_LIFE = 0.3

interface Spark {
  mesh: Mesh
  material: MeshBasicMaterial
  life: number
  /** 目标半径，决定这次火花多大 */
  size: number
}

export class HitSparks {
  readonly group = new Group()

  private readonly sparks: Spark[] = []
  private cursor = 0
  /** 环的几何在 XY 平面，要转到水平 */
  private readonly flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)

  constructor() {
    this.group.name = 'hit-sparks'
    const geometry = new RingGeometry(0.62, 1, 14, 1)
    for (let i = 0; i < SPARK_COUNT; i++) {
      const material = new MeshBasicMaterial({
        // HDR 白黄：走 ACES 色调映射后仍然亮得扎眼，普通白色会被压灰
        color: new Color(3.2, 2.6, 1.4),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // 叠加混合让火花在深色背景上"发光"，而不是糊一块白
        blending: AdditiveBlending,
        side: DoubleSide,
      })
      const mesh = new Mesh(geometry, material)
      mesh.quaternion.copy(this.flat)
      mesh.visible = false
      mesh.renderOrder = 20
      this.group.add(mesh)
      this.sparks.push({ mesh, material, life: 0, size: 1 })
    }
  }

  /**
   * 在命中点放一个火花。
   * @param big 重击（比如 Boss 的攻击）用更大的环
   */
  spawn(x: number, y: number, z: number, big = false): void {
    // 轮流取一个空闲的；全都在用就覆盖最早的那个
    let target = this.sparks[this.cursor]
    for (let i = 0; i < SPARK_COUNT; i++) {
      const s = this.sparks[(this.cursor + i) % SPARK_COUNT]
      if (s.life <= 0) {
        target = s
        this.cursor = (this.cursor + i + 1) % SPARK_COUNT
        break
      }
    }

    target.life = SPARK_LIFE
    target.size = big ? 1.5 : 0.85
    target.mesh.visible = true
    target.mesh.position.set(x, y, z)
    target.mesh.scale.setScalar(target.size * 0.35)
    target.material.opacity = 1
  }

  update(dt: number): void {
    for (const s of this.sparks) {
      if (s.life <= 0) continue
      s.life -= dt
      if (s.life <= 0) {
        s.mesh.visible = false
        continue
      }
      const t = 1 - s.life / SPARK_LIFE
      // 快速张开、缓慢淡出：前 30% 就把环撑到最大，剩下的时间用来消失。
      // 均匀扩散会显得软绵绵的，没有"击打"的锐利感
      const spread = Math.min(1, t / 0.3)
      s.mesh.scale.setScalar(s.size * (0.35 + spread * 0.9))
      s.material.opacity = (1 - t) * (1 - t)
    }
  }

  clear(): void {
    for (const s of this.sparks) {
      s.life = 0
      s.mesh.visible = false
    }
  }

  dispose(): void {
    for (const s of this.sparks) s.material.dispose()
    this.sparks[0]?.mesh.geometry.dispose()
    this.sparks.length = 0
  }
}

/**
 * 挥砍轨迹：剑扫过的一道弧光。
 *
 * 做成从一侧扫向另一侧的扇形，而不是整块同时亮起——同时亮起看起来
 * 像贴了张纸片，扫过去才有"刀锋划过"的动势。
 */
export class SlashTrail {
  readonly object: Mesh

  private readonly material: MeshBasicMaterial
  private life = 0
  /** 这一刀朝向哪边（左右手交替会更有节奏，这里用攻击序号决定） */
  private flip = 1

  /** 轨迹存活时间（秒），与一次出招的时长接近 */
  private static readonly LIFE = 0.34

  constructor() {
    // 扇形：内径 0.55、外径 1.9、张角 150°
    const geometry = new RingGeometry(0.55, 1.9, 16, 1, -Math.PI * 0.42, Math.PI * 0.84)
    this.material = new MeshBasicMaterial({
      color: new Color(2.6, 2.9, 3.2),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    })
    this.object = new Mesh(geometry, this.material)
    this.object.visible = false
    this.object.renderOrder = 18
    // 摊平到水平面，并抬到胸口高度
    this.object.rotation.x = -Math.PI / 2
    this.object.position.y = 1.05
  }

  /** 出招时调用。alternate 为 true 时左右交替挥砍 */
  start(x: number, z: number, yaw: number, alternate: boolean): void {
    this.life = SlashTrail.LIFE
    this.object.visible = true
    this.object.position.set(x, this.object.position.y, z)
    // 让弧线沿着角色朝向展开：几何的 0° 在 +X，角色正面是 +Z
    this.object.rotation.z = -yaw - Math.PI / 2
    if (alternate) this.flip = -this.flip
  }

  /** 每帧跟随角色位置（挥砍时人还在动） */
  update(dt: number, x: number, z: number): void {
    if (this.life <= 0) return
    this.life -= dt
    if (this.life <= 0) {
      this.object.visible = false
      return
    }
    this.object.position.x = x
    this.object.position.z = z

    const t = 1 - this.life / SlashTrail.LIFE
    // 弧光扫过：整体缩放从 0.75 张到 1.15，透明度先冲高再收
    this.object.scale.setScalar(0.75 + t * 0.4)
    this.material.opacity = Math.sin(Math.min(1, t * 1.35) * Math.PI) * 0.5
    // 绕自身旋转一点，模拟手腕的翻转让刀刃划出弧线
    this.object.rotation.y = this.flip * (t - 0.5) * 1.1
  }

  get isActive(): boolean {
    return this.life > 0
  }

  dispose(): void {
    this.object.geometry.dispose()
    this.material.dispose()
  }
}


/**
 * 电击环：贴在水面上向四周扩散的一圈电弧。
 *
 * 单独做而不是复用命中火花：电击的范围是十二米，火花那点尺寸完全读不出
 * "电流铺开了"这件事；颜色也要区分开——火是橙、冰是青、电用冷白偏紫，
 * 玩家一眼就能分辨自己在应对哪种元素。
 */
export class ShockRing {
  readonly object: Mesh

  private readonly material: MeshBasicMaterial
  private life = 0

  private static readonly LIFE = 0.55

  constructor() {
    const geometry = new RingGeometry(0.86, 1, 40, 1)
    this.material = new MeshBasicMaterial({
      color: new Color(2.4, 3.2, 4.4),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    })
    this.object = new Mesh(geometry, this.material)
    this.object.rotation.x = -Math.PI / 2
    this.object.visible = false
    this.object.renderOrder = 19
  }

  /**
   * @param radius 最大半径（米）
   * @param color 环的颜色。电是冷白偏紫，风用近乎纯白——两者形状一样，
   *   靠颜色区分玩家才能一眼看出自己刚放的是哪个
   */
  fire(x: number, y: number, z: number, radius: number, color?: Color): void {
    this.life = ShockRing.LIFE
    this.object.visible = true
    this.object.position.set(x, y + 0.08, z)
    this.maxRadius = radius
    if (color) this.material.color.copy(color)
  }

  private maxRadius = 10

  update(dt: number): void {
    if (this.life <= 0) return
    this.life -= dt
    if (this.life <= 0) {
      this.object.visible = false
      return
    }
    const t = 1 - this.life / ShockRing.LIFE
    // 扩张得很快、熄灭得也快，像一道瞬时电流而不是涟漪
    this.object.scale.setScalar(this.maxRadius * (0.15 + t * 0.95))
    this.material.opacity = (1 - t) * (1 - t) * 0.9
  }

  dispose(): void {
    this.object.geometry.dispose()
    this.material.dispose()
  }
}
