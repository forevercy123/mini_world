/**
 * 玩家角色的视觉表现。
 *
 * 结构上分成「关节枢轴 + 部件」两层：肩、髋各是一个 Group，部件挂在
 * 枢轴下面。这样摆动手臂/腿只要旋转枢轴，不用重算位置——走路动画因此
 * 只是一行 sin 赋值。第一版把角色做成一个胶囊加一个球，问题就出在没有
 * 关节，任何动作都只能整体位移，看起来像个会滑动的棋子。
 *
 * 尺寸按总高约 1.75 米安排，与角色控制器的碰撞高度一致：
 *   脚 0 → 髋 0.85 → 肩 1.38 → 头顶 1.77
 *
 * 朝向约定：模型默认朝 +Z，因此 `object.rotation.y = yaw` 与控制器里
 * `yaw = atan2(dirX, dirZ)` 的定义天然对齐，不需要额外补偿。
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three'
import type { MoveState } from './characterController.ts'

/**
 * 角色外观的统一接口。手写几何版（PlayerAvatar）与 glTF 模型版
 * （ModelAvatar）都实现它，运行时可以互换而不影响调用方。
 */
export interface AvatarLike {
  readonly object: Group
  update(position: Vector3, yaw: number, dt: number, state: AvatarState): void
  dispose(): void
  /** 换手上持有的武器。null 表示空手。手写几何版不支持，glTF 版才有 */
  setWeapon?(weapon: Object3D | null, moveset: string, attackDuration: number): void
}

export interface AvatarState {
  grounded: boolean
  /** 水平速度（米/秒），用于驱动跑动起伏 */
  speed: number
  /** 运动状态，决定姿态与装备显示 */
  state: MoveState
  /** 攻击动作进度 0–1，0 表示没有在攻击 */
  attackProgress?: number
  /** 是否正在出招。glTF 模型靠它触发一次性的挥砍动作 */
  attacking?: boolean
  /** 连击段数（0 起）。连续出招时轮换不同的挥砍动画 */
  attackCombo?: number
  /** 是否正在闪避。触发一次性的翻滚动作 */
  dodging?: boolean
  /** 无敌帧剩余比例 1→0，用于受击闪烁 */
  invulnRatio?: number
}

/** 关节高度，与上面注释里的比例一致 */
const HIP_Y = 0.85
const SHOULDER_Y = 1.38
const HEAD_Y = 1.58

export class PlayerAvatar implements AvatarLike {
  readonly object = new Group()

  private readonly materials: MeshLambertMaterial[] = []
  private readonly geometries: BufferGeometry[] = []

  private readonly rig: Group
  private readonly torso: Mesh
  private readonly glider: Mesh
  private readonly swordPivot: Group

  private readonly armL: Group
  private readonly armR: Group
  private readonly legL: Group
  private readonly legR: Group
  private readonly headGroup: Group

  private readonly clothMaterial: MeshLambertMaterial
  private readonly clothBaseEmissive: Color
  private readonly skinMaterial: MeshLambertMaterial
  private readonly skinBaseEmissive: Color

  private walkPhase = 0
  private bobPhase = 0
  private sinkOffset = 0

  constructor() {
    const cloth = this.makeMaterial(0x3f7d4a, 0.1)
    const clothDark = this.makeMaterial(0x2f5f38, 0.08)
    const skin = this.makeMaterial(0xd9a97e, 0.09)
    const hair = this.makeMaterial(0x4a3424, 0.06)
    const leather = this.makeMaterial(0x6b5138, 0.07)
    const metal = this.makeMaterial(0xc8d4e2, 0.2)
    const sailCloth = this.makeMaterial(0xd2703f, 0.22)

    this.clothMaterial = cloth
    this.clothBaseEmissive = cloth.emissive.clone()
    this.skinMaterial = skin
    this.skinBaseEmissive = skin.emissive.clone()

    this.rig = new Group()
    this.object.add(this.rig)

    // ── 躯干：上窄下宽的六棱柱，像一件束腰外衣 ──
    const torsoGeo = new CylinderGeometry(0.17, 0.23, 0.54, 6)
    this.torso = new Mesh(torsoGeo, cloth)
    this.torso.position.y = HIP_Y + 0.27
    this.torso.castShadow = true
    this.rig.add(this.torso)
    this.track(torsoGeo, cloth)

    // 下摆：束腰外衣的标志性剪影。比腰宽一圈的短裙边，
    // 没有它的话躯干就是一根直筒，看着像木桩而不是穿了衣服的人。
    const hemGeo = new CylinderGeometry(0.25, 0.35, 0.24, 6)
    const hem = new Mesh(hemGeo, cloth)
    hem.position.y = HIP_Y - 0.06
    hem.castShadow = true
    this.rig.add(hem)
    this.track(hemGeo, cloth)

    // 腰带：把上下身分开，剪影上更接近"人"而不是一根柱子
    const beltGeo = new BoxGeometry(0.36, 0.07, 0.28)
    const belt = new Mesh(beltGeo, leather)
    belt.position.y = HIP_Y + 0.04
    belt.castShadow = true
    this.rig.add(belt)
    this.track(beltGeo, leather)

    // 带扣：一个浅色小方块，给腰部一个视觉焦点
    const buckleGeo = new BoxGeometry(0.09, 0.09, 0.03)
    const buckleMat = this.makeMaterial(0xd8c88a, 0.16)
    const buckle = new Mesh(buckleGeo, buckleMat)
    buckle.position.set(0, HIP_Y + 0.04, 0.15)
    this.rig.add(buckle)
    this.track(buckleGeo, buckleMat)

    // 衣领：颈部的深色一圈，让头和身体之间有过渡
    const collarGeo = new CylinderGeometry(0.185, 0.165, 0.08, 6)
    const collar = new Mesh(collarGeo, clothDark)
    collar.position.y = SHOULDER_Y - 0.02
    this.rig.add(collar)
    this.track(collarGeo, clothDark)

    // ── 头 ──
    this.headGroup = new Group()
    this.headGroup.position.y = HEAD_Y
    this.rig.add(this.headGroup)

    const headGeo = new SphereGeometry(0.185, 10, 8)
    const head = new Mesh(headGeo, skin)
    head.castShadow = true
    this.headGroup.add(head)
    this.track(headGeo, skin)

    // 头发：压扁的球体盖住颅顶。压得比较扁（0.7）是有意的——
    // 圆球会包成"头盔"把脸挡掉，扁一点才像头发，也露出侧脸的轮廓。
    const hairGeo = new SphereGeometry(0.2, 9, 7)
    const hairMesh = new Mesh(hairGeo, hair)
    hairMesh.position.set(0, 0.062, -0.028)
    hairMesh.scale.set(1.02, 0.7, 1.06)
    this.headGroup.add(hairMesh)
    this.track(hairGeo, hair)

    // 刘海：额前压扁的一片。只有头顶一顶"帽子"的话，正面看还是光头。
    const bangGeo = new SphereGeometry(0.17, 9, 6)
    const bangs = new Mesh(bangGeo, hair)
    bangs.position.set(0, 0.075, 0.055)
    bangs.scale.set(1.05, 0.42, 0.85)
    this.headGroup.add(bangs)
    this.track(bangGeo, hair)

    // 尖耳朵，塞尔达式角色的标志性剪影
    const earGeo = new ConeGeometry(0.045, 0.15, 4)
    for (const side of [-1, 1]) {
      const ear = new Mesh(earGeo, skin)
      ear.position.set(0.175 * side, -0.01, -0.03)
      ear.rotation.z = (-Math.PI / 2) * side
      ear.rotation.x = -0.25
      this.headGroup.add(ear)
    }
    this.track(earGeo, skin)

    // 朝向标记：鼻尖。低多边形脸没有五官时，这个小突起是分辨正反面的关键。
    const noseGeo = new ConeGeometry(0.035, 0.09, 4)
    const nose = new Mesh(noseGeo, skin)
    nose.rotation.x = Math.PI / 2
    nose.position.set(0, -0.015, 0.185)
    this.headGroup.add(nose)
    this.track(noseGeo, skin)

    // 眼睛。只有两个小球，但有没有它完全是两回事——没有眼睛时正面
    // 就是一张空白的脸，角色像个人偶而不是"人"。
    const eyeGeo = new SphereGeometry(0.028, 7, 6)
    const eyeMat = this.makeMaterial(0x16161c, 0.02)
    for (const side of [-1, 1]) {
      const eye = new Mesh(eyeGeo, eyeMat)
      // 贴在头部表面偏前的法线方向上，太低会跑到下巴，太高会顶到头发
      eye.position.set(0.072 * side, 0.012, 0.168)
      eye.scale.set(1, 1.15, 0.6)
      this.headGroup.add(eye)
    }
    this.track(eyeGeo, eyeMat)

    // ── 四肢 ──
    // 手臂用稍深一号的绿：和外衣同色时从正面看会糊成一片，
    // 剪影上看不出有手臂
    this.armL = this.makeArm(-1, clothDark, skin)
    this.armR = this.makeArm(1, clothDark, skin)
    this.legL = this.makeLeg(-1, clothDark, leather)
    this.legR = this.makeLeg(1, clothDark, leather)
    this.rig.add(this.armL, this.armR, this.legL, this.legR)

    // ── 剑：挂在**右手枢轴之下**，而不是挂在 rig 上。
    //     之前挂在 rig 上、位置写死，手臂摆动时剑纹丝不动，看起来像
    //     悬在身体旁边硬跟着平移。挂进 armR 之后，手臂一动剑就跟着动，
    //     挥砍也完全由手臂驱动，不再需要单独给剑编一套轨迹。
    const bladeGeo = new BoxGeometry(0.05, 0.05, 0.78)
    const guardGeo = new BoxGeometry(0.22, 0.05, 0.055)
    this.swordPivot = new Group()
    // armR 的局部坐标里手掌在 y = -0.46
    this.swordPivot.position.set(0, -0.44, 0.02)
    this.swordPivot.rotation.x = HILT_ANGLE
    this.armR.add(this.swordPivot)

    const blade = new Mesh(bladeGeo, metal)
    // 沿 +Z 伸出；经过 HILT_ANGLE 的旋转后，剑身斜指下方
    blade.position.set(0, 0, 0.46)
    blade.castShadow = true
    this.swordPivot.add(blade)

    const guard = new Mesh(guardGeo, leather)
    guard.position.set(0, 0, 0.06)
    this.swordPivot.add(guard)
    this.track(bladeGeo, metal)
    this.track(guardGeo, leather)

    // 剑柄与剑首。只有一块方板的时候，剑看起来像贴在手上的铁片；
    // 补上握柄和末端的配重球，才有"一把剑"的完整轮廓。
    const gripGeo = new CylinderGeometry(0.027, 0.03, 0.17, 5)
    const gripMat = this.makeMaterial(0x4a3a2c, 0.08)
    const grip = new Mesh(gripGeo, gripMat)
    grip.rotation.x = Math.PI / 2
    grip.position.set(0, 0, -0.04)
    this.swordPivot.add(grip)

    const pommelGeo = new SphereGeometry(0.045, 6, 5)
    const pommel = new Mesh(pommelGeo, metal)
    pommel.position.set(0, 0, -0.14)
    this.swordPivot.add(pommel)
    this.track(gripGeo, gripMat)
    this.track(pommelGeo, metal)

    // ── 滑翔伞：压扁的四棱锥，滑翔时展开 ──
    const gliderGeo = new ConeGeometry(1.75, 0.55, 4)
    this.glider = new Mesh(gliderGeo, sailCloth)
    this.glider.rotation.y = Math.PI / 4
    this.glider.position.y = 2.75
    this.glider.visible = false
    this.rig.add(this.glider)
    this.track(gliderGeo, sailCloth)

    this.object.name = 'player'
    this.object.scale.setScalar(1)
  }

  /** 手臂：枢轴在肩，部件向下延伸，旋转枢轴即可摆动整条手臂 */
  private makeArm(side: number, sleeve: MeshLambertMaterial, skin: MeshLambertMaterial): Group {
    const pivot = new Group()
    pivot.position.set(0.225 * side, SHOULDER_Y, 0)

    const upperGeo = new CylinderGeometry(0.062, 0.055, 0.42, 5)
    const upper = new Mesh(upperGeo, sleeve)
    upper.position.y = -0.21
    upper.castShadow = true
    pivot.add(upper)

    // 手：略扁的方块而不是球。方块有棱角，剪影上更像戴了手套的手，
    // 圆球则像长了个肉瘤
    const handGeo = new BoxGeometry(0.1, 0.12, 0.1)
    const hand = new Mesh(handGeo, skin)
    hand.position.y = -0.46
    hand.castShadow = true
    pivot.add(hand)

    // 手臂略微外展。贴着身体的话从正面看不出有手臂，剪影会退化成一根柱子。
    pivot.rotation.z = -0.17 * side
    this.track(upperGeo, sleeve)
    this.track(handGeo, skin)
    return pivot
  }

  /** 腿：枢轴在髋，含裤腿与靴子 */
  private makeLeg(side: number, pants: MeshLambertMaterial, boot: MeshLambertMaterial): Group {
    const pivot = new Group()
    pivot.position.set(0.105 * side, HIP_Y, 0)

    const thighGeo = new CylinderGeometry(0.082, 0.07, 0.7, 5)
    const thigh = new Mesh(thighGeo, pants)
    thigh.position.y = -0.35
    thigh.castShadow = true
    pivot.add(thigh)

    // 靴筒：小腿下半截的棕色圆筒。没有它的话靴子就是"脚上贴了块砖"，
    // 有了靴筒才有靴子的轮廓
    const shaftGeo = new CylinderGeometry(0.088, 0.095, 0.3, 5)
    const shaft = new Mesh(shaftGeo, boot)
    shaft.position.y = -0.6
    shaft.castShadow = true
    pivot.add(shaft)

    const bootGeo = new BoxGeometry(0.155, 0.12, 0.24)
    const bootMesh = new Mesh(bootGeo, boot)
    // 靴子略向前伸，侧面看才像脚而不是柱子的末端
    bootMesh.position.set(0, -0.78, 0.04)
    bootMesh.castShadow = true
    pivot.add(bootMesh)

    this.track(thighGeo, pants)
    this.track(shaftGeo, boot)
    this.track(bootGeo, boot)
    return pivot
  }

  private track(geo: BufferGeometry, mat: MeshLambertMaterial): void {
    this.geometries.push(geo)
    if (!this.materials.includes(mat)) this.materials.push(mat)
  }

  private makeMaterial(color: number, emissiveIntensity: number): MeshLambertMaterial {
    const mat = new MeshLambertMaterial({ color, flatShading: true })
    // 用同色自发光替代环境光补偿，避免影响场景整体亮度
    mat.emissive = new Color(color).multiplyScalar(emissiveIntensity)
    return mat
  }

  update(position: Vector3, yaw: number, dt: number, state: AvatarState): void {
    const isSwim = state.state === 'swim'
    const isClimb = state.state === 'climb'
    const isGlide = state.state === 'glide'

    // 游泳时整体下沉，只露出上半身；过渡平滑，出入水不会突跳
    const targetSink = isSwim ? -0.75 : 0
    this.sinkOffset += (targetSink - this.sinkOffset) * Math.min(1, dt * 6)

    this.object.position.set(position.x, position.y + this.sinkOffset, position.z)
    this.object.rotation.y = yaw

    // ── 走路：四肢交替摆动 ──
    const moving = state.grounded && state.speed > 0.4
    if (moving) {
      // 步频随速度提高。乘 2.6 是让 4 m/s 的步行约每秒 1.7 步
      this.walkPhase += dt * state.speed * 2.6
    } else {
      // 停下时相位回落到 0，四肢自然归位而不是僵在半步上
      this.walkPhase += dt * 2
    }
    const amplitude = moving ? Math.min(0.72, state.speed * 0.1) : 0
    const swing = Math.sin(this.walkPhase) * amplitude

    this.legL.rotation.x = swing
    this.legR.rotation.x = -swing
    // 手臂与同侧腿反向摆，这是走路看起来自然的关键
    this.armL.rotation.x = -swing * 0.72
    this.armR.rotation.x = swing * 0.72

    // ── 上身起伏 ──
    if (moving) {
      this.bobPhase += dt * state.speed * 2.6
    } else {
      this.bobPhase += dt * 1.2
    }
    const bobAmplitude = state.grounded ? Math.min(0.05, state.speed * 0.011) : 0
    // 每步一个起伏，所以用 2 倍频率（一个步态周期含左右两步）
    const bob = Math.abs(Math.sin(this.bobPhase)) * bobAmplitude
    this.torso.position.y = HIP_Y + 0.27 + bob
    this.headGroup.position.y = HEAD_Y + bob * 0.8

    // 攀爬时身体前倾贴向崖面，避免看起来"悬空贴在墙上"
    const targetTilt = isClimb ? 0.32 : isSwim ? -0.5 : 0
    this.rig.rotation.x += (targetTilt - this.rig.rotation.x) * Math.min(1, dt * 5)

    // 攀爬时四肢张开抓握
    if (isClimb) {
      const grab = Math.sin(this.walkPhase * 1.6) * 0.22
      this.armL.rotation.x = -1.5 + grab
      this.armR.rotation.x = -1.5 - grab
      this.legL.rotation.x = 0.35 + grab * 0.5
      this.legR.rotation.x = 0.35 - grab * 0.5
    }

    // 滑翔时双臂上举抓伞
    if (isGlide) {
      const k = Math.min(1, dt * 7)
      this.armL.rotation.x += (-2.35 - this.armL.rotation.x) * k
      this.armR.rotation.x += (-2.35 - this.armR.rotation.x) * k
      this.legL.rotation.x += (0.25 - this.legL.rotation.x) * k
      this.legR.rotation.x += (0.25 - this.legR.rotation.x) * k
    }

    this.glider.visible = isGlide
    if (isGlide) {
      // 伞面随移动轻微摆动，静止时也有"被风吹着"的感觉
      this.glider.rotation.z = Math.sin(this.bobPhase * 0.8) * 0.09
    }

    // ── 挥砍：水平横扫。节奏刻意做成不对称——前 40% 快速挥出、
    //     后 60% 缓慢收回。用正弦曲线会让收招和出招一样快，显得发软。
    const attack = state.attackProgress ?? 0
    const swingCurve =
      attack > 0 ? (attack < 0.4 ? attack / 0.4 : 1 - ((attack - 0.4) / 0.6) * 0.72) : 0
    if (attack > 0) {
      // 挥砍完全由手臂驱动，剑只调整握持角（斜垂 → 接近水平），
      // 这样剑是随手臂划弧，而不是自己绕着手转
      this.swordPivot.rotation.x = HILT_ANGLE - swingCurve * 0.85
      this.armR.rotation.x = -0.35 - swingCurve * 0.5
      this.armR.rotation.y = -0.75 + swingCurve * 1.4
    } else {
      const k = Math.min(1, dt * 6)
      this.swordPivot.rotation.x += (HILT_ANGLE - this.swordPivot.rotation.x) * k
      // 手臂回位交给下面的走路/攀爬/滑翔分支，这里只清掉挥砍留下的偏转
      this.armR.rotation.y += (0 - this.armR.rotation.y) * k
    }
    // 挥砍时上半身跟着转体，比只有手在动更有力
    const twist = attack > 0 ? -swingCurve * 0.34 : 0
    this.rig.rotation.y += (twist - this.rig.rotation.y) * Math.min(1, dt * 12)

    // ── 受击闪烁：无敌帧期间身体在本色与红色之间脉动 ──
    const invuln = state.invulnRatio ?? 0
    const pulse = invuln > 0 ? Math.abs(Math.sin(invuln * Math.PI * 9)) : 0
    this.clothMaterial.emissive.copy(this.clothBaseEmissive)
    this.skinMaterial.emissive.copy(this.skinBaseEmissive)
    if (pulse > 0) {
      this.clothMaterial.emissive.lerp(HIT_COLOR, pulse * 0.75)
      this.skinMaterial.emissive.lerp(HIT_COLOR, pulse * 0.6)
    }

    // 腾空时整体稍微收一下，给跳跃一点视觉反馈
    const targetScale = state.state === 'air' ? 0.94 : 1
    const s = this.object.scale.x
    this.object.scale.setScalar(s + (targetScale - s) * Math.min(1, dt * 8))
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
  }
}

const HIT_COLOR = new Color(0xff3b30)

/**
 * 持剑的静止握角（弧度）。剑在 armR 坐标系里沿 +Z 伸出，绕 X 轴转约 72°
 * 后就斜指下方——手臂自然垂下时，剑尖不会水平戳出去。
 */
const HILT_ANGLE = 1.25
