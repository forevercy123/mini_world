/**
 * 基于 glTF 模型的主角外观。
 *
 * 用手写几何体拼角色的路子走到头了：一个球加几根柱子，无论再加多少
 * 零件，比例、关节过渡和面部都做不出来。换成现成的模型直接解决三件事
 * ——正确的解剖比例、面部、以及**骨骼动画**（后者才是"活起来"的关键，
 * 手写几何只能整体位移，没有肌肉和四肢的自然联动）。
 *
 * 与 PlayerAvatar 接口一致，可在运行时替换。
 *
 * 模型来源（均为可自由使用的授权）：
 *  - KhronosGroup/glTF-Sample-Models 的 CesiumMan（CC0 系，测试模型）
 *  - three.js 官方示例的 Soldier（CC0 系，含 idle/walk/run 三段动画）
 */

import {
  AnimationMixer,
  Euler,
  Quaternion,
  Box3,
  CanvasTexture,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  LoopOnce,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type AnimationAction,
  type Bone,
  type Object3D,
  type Texture,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { AvatarLike, AvatarState } from './playerAvatar.ts'
import { normalizeBoneName } from '../entities/enemySkeleton.ts'
import { addOutline, toonify } from '../render/toon.ts'

/**
 * 纹理换色规则。
 *
 * 素材是别人按自己的角色设计配好色的，直接拿来用就只能是「那个角色」。
 * 这一条规则把纹理里某个色块整体挪到另一个颜色——因为低多边形素材的
 * 贴图是纯色块图集，色块之间边界清晰，按颜色距离匹配不会糊掉。
 */
export interface RecolorRule {
  /** 原始颜色（sRGB） */
  from: number
  /** 目标颜色（sRGB） */
  to: number
  /** 颜色距离容差，默认 26。色块边界有插值过渡，给小了会留下花边 */
  tolerance?: number
}

/** 目标身高（米），与角色控制器的碰撞高度一致 */
const TARGET_HEIGHT = 1.75

interface SwimBone {
  bone: Object3D
  /** 动画算出来的基准旋转，划水叠加在它之上 */
  base: Quaternion
  isArm: boolean
  /** 右侧骨头的外展方向要镜像 */
  mirror: number
}

/** 复用的临时对象，避免每帧为四根骨头各 new 一次 */
const swimEuler = new Euler()
const swimQuat = new Quaternion()

/**
 * 攻击动作候选，按优先级排列。KayKit 有单手/双手/双持各一套，
 * 主角配的是单手剑，所以优先挑单手的劈砍。
 */
/**
 * 游泳时的俯仰角。接近水平——人趴在水面上。
 *
 * **必须是正值。** 绕 X 轴按右手定则转 θ，角色正面朝向从 (0,0,1) 变成
 * (0, -sinθ, cosθ)：θ 为正时 y 分量为负，也就是脸朝下（俯卧）；取负
 * 则脸朝上，那是仰泳。上一版写的 -1.15，结果人仰面朝天躺在水里、
 * 四肢在水面上划。
 */
const SWIM_TILT = 1.15

/**
 * 一次出招的默认时间（秒），必须与 playerCombat 的 `duration` 一致。
 *
 * KayKit 的攻击动画本身约一秒，而一次出招只有 0.58 秒——不压缩的话，
 * 招式还没挥到位就被切回待机，看起来像抽了一下。
 * 实际出招时长随武器走（setWeapon 传入），这里只是空手兜底值。
 */
const ATTACK_ANIM_SECONDS = 0.58

/**
 * 各招式组的挥砍动画，按连击段轮换。
 *
 * 拟人感的关键在于**不重复**：真人挥剑不会每一剑都从同一个角度
 * 劈下来。三段连击分别是下劈、斜削、横扫，最后一击横扫的判定
 * 帧更靠后，刚好让玩家感到"收尾这一下更重"。
 */
const MOVESET_CLIPS: Record<string, string[][]> = {
  // 每组第 4 段（index 3）是蓄力旋风斩：双手抡一整圈，任何武器通用
  '1h': [
    ['1h_melee_attack_chop'],
    ['1h_melee_attack_slice_diagonal'],
    ['1h_melee_attack_slice_horizontal'],
    ['2h_melee_attack_spin'],
  ],
  '2h': [
    ['2h_melee_attack_chop'],
    ['2h_melee_attack_slice'],
    ['2h_melee_attack_spin'],
    ['2h_melee_attack_spinning'],
  ],
  stab: [
    ['1h_melee_attack_stab'],
    ['dualwield_melee_attack_stab'],
    ['1h_melee_attack_slice_horizontal'],
    ['2h_melee_attack_spin'],
  ],
  unarmed: [
    ['unarmed_melee_attack_punch_a'],
    ['unarmed_melee_attack_punch_b'],
    ['unarmed_melee_attack_kick'],
    ['2h_melee_attack_spin'],
  ],
  // 远程：拉弦放箭。四段同一动作，连射不轮换——射箭的"连击"
  // 读不出差别，统一用最利落的一段
  shoot: [
    ['1h_ranged_shoot'],
    ['1h_ranged_shoot'],
    ['1h_ranged_shoot'],
    ['1h_ranged_shoot'],
  ],
}

/** 蓄力时的备战姿势：双手握持压低重心 */
const CHARGE_CLIPS = ['2h_melee_idle', 'blocking', 'idle']

const ATTACK_CLIPS = MOVESET_CLIPS['1h'][0]

/**
 * 闪避动作候选。骨架里有四个方向的翻滚，这里只用前滚——
 * 按相对方向挑动画当然更精细，但闪避只有 0.35 秒，玩家根本来不及
 * 分辨自己滚的是左前还是右前，统一用一个反而更利落
 */
const DODGE_CLIPS = ['dodge_forward', 'dodge_backward', 'dodge']

/**
 * 动画片段对应的「设计速度」（米/秒）。
 *
 * 角色的走跑动画是原地循环的，播放速率必须和实际位移挂钩，否则会出现
 * 脚在原地划水的滑步感。基准值取角色控制器里的 walkSpeed / runSpeed。
 */
const WALK_CLIP_SPEED = 4.2
const RUN_CLIP_SPEED = 7.2

export class ModelAvatar implements AvatarLike {
  readonly object = new Group()

  private mixer: AnimationMixer | null = null
  private actions: AnimationAction[] = []
  private currentAction: AnimationAction | null = null
  /** 正在播放的一次性动作（攻击），播完之前不切回循环动作 */
  private oneShot: AnimationAction | null = null
  private readonly meshes: Mesh[] = []

  private sinkOffset = 0
  /** 俯仰角（弧度），与 yaw 一起合成姿态 */
  private tilt = 0
  private wasAirborne = false

  /** 蛙泳要单独驱动的四根骨头 */
  /** 找到的四肢骨骼。空数组表示模型里没匹配上，蛙泳不会生效 */
  readonly swimBones: SwimBone[] = []
  private swimPhase = 0

  /** 蛙泳划水的累计调用次数与当前相位。调动作时用来确认逻辑真的在跑 */
  swimStrokeTicks = 0
  get currentSwimPhase(): number {
    return this.swimPhase
  }

  /** 滑翔伞。滑翔时展开，落地收起 */
  private glider: Mesh | null = null
  private gliderOpen = 0
  private gliderPhase = 0

  /** 模型自带的动画段数，用于启动日志确认加载是否完整 */
  get animationCount(): number {
    return this.actions.length
  }

  // ── 武器挂载 ──
  /** 角色的整体缩放。武器挂进骨骼时会继承它，预缩放时必须除掉 */
  private rootScale = 1
  /** 右手挂点骨骼。KayKit 角色约定武器挂这里，原点在握把 */
  private handSlot: Object3D | null = null
  /** 左手挂点：格挡时盾在这里 */
  private handSlotL: Object3D | null = null
  /** 胸椎骨：盾平时背在背后 */
  private chestBone: Object3D | null = null
  private shieldObject: Object3D | null = null
  private weaponObject: Object3D | null = null
  private moveset = 'unarmed'
  private attackDuration = ATTACK_ANIM_SECONDS
  /** 上一帧的攻击进度，用来识别"新一轮出招"从而切换连击动画 */
  private lastAttackProgress = 0

  /**
   * 换手上持有的武器。
   *
   * @param visual 已经按世界长度归一化好的武器外观（makeWeaponVisual）
   * @param moveset 招式组（1h/2h/stab/unarmed），决定挥砍用哪套动画
   * @param attackDuration 一次出招的秒数，动画会被压缩进这个时长
   */
  setWeapon(visual: Object3D | null, moveset: string, attackDuration: number): void {
    if (this.weaponObject) {
      this.weaponObject.removeFromParent()
      this.weaponObject = null
    }
    this.moveset = moveset
    this.attackDuration = attackDuration

    if (!visual) return
    if (!this.handSlot) {
      console.warn('[角色] 没找到手部挂点，武器装不上')
      return
    }
    // 挂进骨骼会继承角色的整体缩放：这里先除掉，武器拿在手里才是
    // 它在地上展示时的同一个尺寸。否则 0.9 倍身高的角色会把 1 米长的
    // 剑也缩成 0.9 米
    visual.scale.multiplyScalar(1 / this.rootScale)
    // 武器也描边——它是角色剪影的一部分，没有黑边的剑会显得"贴片"
    addOutline(visual)
    this.handSlot.add(visual)
    this.weaponObject = visual
  }

  private constructor(root: Object3D, animations: AnimationAction[], name: string) {
    // 名字必须可配置。
    //
    // 原来硬编码成 'player-model'，而 NPC 也用同一个类加载——于是场景里
    // 出现好几个同名节点，`getObjectByName('player-model')` 回来的可能是
    // 任何一个。这在游戏里看不出问题（每个模型自己动自己的），但任何
    // 按名字找角色的代码都会摸到一个 NPC，排查起来极难
    this.object.name = name
    this.object.add(root)
    this.actions = animations
  }

  /**
   * 加载并准备好可直接替换使用的角色。
   * @param onFallback 加载失败时的回调，调用方应保留原有外观
   */
  static async load(
    url: string,
    recolor?: readonly RecolorRule[],
    /** 场景节点名。默认给玩家用，NPC 要传自己的 */
    name = 'player-model',
    /** 主角专属的金色刘海颜色。不传则不加（NPC 没有刘海） */
    hairColor?: number,
  ): Promise<ModelAvatar | null> {
    try {
      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync(url)

      const root = gltf.scene as Object3D

      // 归一化尺寸与落脚点：不同来源的模型比例差很多，
      // 按包围盒缩放到统一身高，并把脚底对齐到原点
      const box = new Box3().setFromObject(root)
      const height = Math.max(0.001, box.max.y - box.min.y)
      const scale = TARGET_HEIGHT / height
      root.scale.setScalar(scale)
      root.position.y = -box.min.y * scale

      const avatar = new ModelAvatar(root, [], name)
      avatar.rootScale = scale
      avatar.prepareMaterials()
      avatar.collectSwimBones()
      avatar.collectHandSlot()
      avatar.buildGlider()
      if (hairColor !== undefined) avatar.buildHair(hairColor)
      if (recolor && recolor.length > 0) avatar.recolorTextures(recolor)
      avatar.setupAnimations(gltf.animations)
      // 卡通描边：跳过挂点下自带的隐藏武器网格（它们 visible=false，
      // 但描边壳会照样画黑边）
      addOutline(root, (mesh) => mesh.visible)
      return avatar
    } catch (err) {
      console.warn('[角色模型] 加载失败，回退到手写外观：', err)
      return null
    }
  }

  /**
   * 按规则重绘贴图。
   *
   * 在 canvas 上逐像素做，而不是给材质换个颜色——材质的 color 是乘在贴图
   * 之上的，改它只会让整块颜色变深变浅，没法只动其中一种色块。而低多边形
   * 素材的贴图本身就是色块图集，逐像素替换能精确改掉"皮肤"这一类，
   * 保留衣服和皮革的原有配色。
   */
  private recolorTextures(rules: readonly RecolorRule[]): void {
    // 直接拆 sRGB 字节，不要走 `new Color(hex)`：Three.js 的颜色管理会把它
    // 转成线性值，而画布里的像素是 sRGB 编码的，两边一比就永远匹配不上，
    // 改色会静默失效（配色的坑基本都出在这个转换上）。
    const bytes = (hex: number): [number, number, number] => [
      (hex >> 16) & 0xff,
      (hex >> 8) & 0xff,
      hex & 0xff,
    ]
    const prepared = rules.map((rule) => ({
      from: bytes(rule.from),
      to: bytes(rule.to),
      tolerance: rule.tolerance ?? 26,
    }))

    this.object.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return
      const material = mesh.material as MeshLambertMaterial
      const source = material.map
      const image = source?.image as CanvasImageSource & { width: number; height: number }
      if (!source || !image?.width) return

      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(image, 0, 0)

      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const data = pixels.data

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        for (const rule of prepared) {
          const dr = r - rule.from[0]
          const dg = g - rule.from[1]
          const db = b - rule.from[2]
          if (dr * dr + dg * dg + db * db > rule.tolerance * rule.tolerance) continue
          data[i] = rule.to[0]
          data[i + 1] = rule.to[1]
          data[i + 2] = rule.to[2]
          break
        }
      }
      ctx.putImageData(pixels, 0, 0)

      const next = new CanvasTexture(canvas)
      // GLTFLoader 载入的贴图 flipY 为 false，新建的画布贴图必须跟着关掉，
      // 否则整张 UV 会上下颠倒
      next.flipY = source.flipY
      next.colorSpace = SRGBColorSpace
      next.needsUpdate = true
      source.dispose()
      material.map = next
      material.needsUpdate = true
    })
  }

  /**
   * 金色刘海：兜帽前沿下露出来的一撮头发。
   *
   * 林克的标志性视觉之一就是帽子下漏出的金发。KayKit 的兜帽模型
   * 没有头发，这里用三个低多边形片补在中间与两侧——贴在兜帽内沿，
   * 跟着头骨骼动。粗看是"帽子里钻出一撮毛"，正是要的效果。
   */
  private buildHair(color = 0xe8c66a): void {
    const headRef: { current: Object3D | null } = { current: null }
    this.object.traverse((child) => {
      if (!headRef.current && normalizeBoneName(child.name) === 'head') headRef.current = child
    })
    const head = headRef.current
    if (!head) return

    const mat = new MeshLambertMaterial({ color })
    const hair = new Group()

    // 中间一撮：压扁的锥垂在额头正中，从帽沿下探出来
    const mid = new Mesh(new ConeGeometry(0.075, 0.26, 4), mat)
    mid.scale.set(1.7, 1, 0.62)
    mid.rotation.x = Math.PI - 0.22 // 尖朝下、略向前趴
    mid.position.set(0, -0.03, 0.19)
    hair.add(mid)

    // 两侧各一小片：略弯向外
    for (const side of [-1, 1]) {
      const lock = new Mesh(new ConeGeometry(0.055, 0.18, 4), mat)
      lock.scale.set(1.35, 1, 0.58)
      lock.rotation.x = Math.PI
      lock.rotation.z = side * 0.3
      lock.position.set(side * 0.11, 0.0, 0.175)
      hair.add(lock)
    }

    // 挂到头骨骼上，用局部坐标。缩放随骨骼链走，不用额外补偿
    head.add(hair)

    // 眼睛高光：纯黑的眼睛上点两粒白色高光，角色立刻"活"了。
    // 极小的白色球贴在眼珠表面，低多边形风格里这是眼神的全部来源
    const sparkleMat = new MeshBasicMaterial({ color: new Color(2.2, 2.2, 2.3) })
    for (const side of [-1, 1]) {
      const dot = new Mesh(new SphereGeometry(0.011, 6, 5), sparkleMat)
      dot.position.set(side * 0.058, 0.015, 0.152)
      head.add(dot)
    }
  }

  /**
   * 支起滑翔伞。一个压扁的四棱锥横着撑在头顶——四棱锥比圆锥更像布面，
   * 它的棱线能把伞面分成几块，风一吹有明暗变化。挂在角色根节点上，
   * 跟着身体一起前倾，不需要单独同步姿态。
   */
  private buildGlider(): void {
    const geometry = new ConeGeometry(1.62, 0.52, 4)
    const material = new MeshLambertMaterial({
      color: 0x3f8a4a,
      // 从下方抬头也要看得见伞面，单面材质在滑翔时会露出一片空洞
      side: DoubleSide,
    })
    const mesh = new Mesh(geometry, material)
    // 转 45°：棱角朝向四个斜方向，从任意角度看都有清晰的轮廓
    mesh.rotation.y = Math.PI / 4
    mesh.position.y = 2.18
    mesh.visible = false
    this.object.add(mesh)
    this.glider = mesh
  }

  /**
   * 找出蛙泳要驱动的那几根骨头。
   *
   * KayKit 的角色没有游泳动画（76 段里一段都没有），所以游泳只有"趴平"
   * 没有"划水"，看起来像漂在水面上的木板。这里用和敌人同一套办法补：
   * 给四肢的根骨骼各留一份基准旋转，每帧把划水的姿态乘上去。
   */
  private collectSwimBones(): void {
    // 名字要归一化后比：GLTFLoader 会把 `upperarm.l` 里的点剥掉，
    // 变成 `upperarml`。按带点的原名去找，一根都匹配不上，
    // 蛙泳就成了"姿势摆好但一动不动"
    const wanted = ['upperarml', 'upperarmr', 'upperlegl', 'upperlegr']
    this.object.traverse((child) => {
      const bone = child as Bone
      if (!bone.isBone) return
      const name = normalizeBoneName(bone.name)
      if (!wanted.includes(name)) return
      this.swimBones.push({
        bone,
        base: bone.quaternion.clone(),
        isArm: name.startsWith('upperarm'),
        mirror: name.endsWith('r') ? -1 : 1,
      })
    })
    if (this.swimBones.length === 0) {
      console.warn('[角色] 没找到游泳要驱动的骨骼，蛙泳动作不会生效')
    }
  }

  /**
   * 找右手的武器挂点。
   *
   * GLTFLoader 会剥掉骨骼名里的点号：`handslot.r` 加载后变成
   * `handslotr`。按原名找永远找不到——和游泳骨骼同一个坑。
   *
   * 挂点下面还藏着模型自带的一整套武器网格（Knife、1H_Crossbow、
   * Throwable……），KayKit 的角色是全武器通用的，靠显隐切换。
   * 我们有自己的武器系统，把它们全部藏起来。
   */
  private collectHandSlot(): void {
    this.object.traverse((child) => {
      const name = normalizeBoneName(child.name)
      if (!this.handSlot && name === 'handslotr') {
        this.handSlot = child
        for (const c of child.children) c.visible = false
      }
      // 左手挂点同理：背着弩和飞刀跑会很出戏
      if (name === 'handslotl') {
        this.handSlotL = child
        for (const c of child.children) c.visible = false
      }
      // 胸椎：盾牌平时背在这里
      if (name === 'chest') this.chestBone = child
    })
    if (!this.handSlot) console.warn('[角色] 没找到武器挂点 handslot.r')
  }

  /**
   * 给角色配盾。平时背在背后（塞尔达式的经典剪影），
   * 格挡时移到左手。盾牌网格由调用方加载好传进来。
   */
  setShield(mesh: Object3D | null): void {
    if (this.shieldObject) {
      this.shieldObject.removeFromParent()
      this.shieldObject = null
    }
    if (!mesh) return
    mesh.scale.multiplyScalar(1 / this.rootScale)
    this.shieldObject = mesh
    this.mountShield(false)
  }

  /** 盾在背上还是手上 */
  private mountShield(inHand: boolean): void {
    const shield = this.shieldObject
    if (!shield) return
    shield.removeFromParent()
    if (inHand && this.handSlotL) {
      // 挂在手部挂点：挂点朝向和武器同一约定，直接可用
      shield.position.set(0, 0, 0)
      shield.rotation.set(0, 0, 0)
      this.handSlotL.add(shield)
    } else if (this.chestBone) {
      // 背在胸椎后方：略沉、外移出背、立起来
      shield.position.set(0, 0.16, -0.24)
      shield.rotation.set(0, Math.PI, 0)
      this.chestBone.add(shield)
    }
  }

  /** 格挡状态切换：盾从背上到左手 */
  setShieldRaised(raised: boolean): void {
    if (this.shieldRaised === raised) return
    this.shieldRaised = raised
    this.mountShield(raised)
  }
  private shieldRaised = false

  /**
   * 蛙泳：手臂前伸外划，双腿反相蹬夹。
   *
   * 相位由实际速度驱动，慢游时慢慢划——固定节奏会在减速时变成"手在
   * 水里空划"。
   */
  private applySwimStroke(dt: number, speed: number): void {
    if (this.swimBones.length === 0) return
    this.swimStrokeTicks++
    this.swimPhase += dt * (1.5 + speed * 0.7)
    const p = this.swimPhase

    for (const b of this.swimBones) {
      // 手和腿反相：蛙泳是先划手再蹬腿，同相的话会像青蛙在抽搐
      const phase = b.isArm ? p : p + Math.PI
      const spread = Math.sin(phase) * (b.isArm ? 0.85 : 0.7)
      const sweep = Math.cos(phase) * (b.isArm ? 0.55 : 0.4)

      swimEuler.set(sweep, 0, spread * b.mirror, 'XYZ')
      swimQuat.setFromEuler(swimEuler)
      b.bone.quaternion.copy(b.base).multiply(swimQuat)
    }
  }

  /** 收集网格，统一换成卡通渲染材质（色阶 + 后续描边） */
  private prepareMaterials(): void {
    this.object.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return

      mesh.castShadow = true
      mesh.receiveShadow = false
      this.meshes.push(mesh)

      // 外部模型常带高光贴图与金属度，在低多边形场景里会显得油亮。
      // 统一换成三渲二色阶材质，只保留漫反射贴图
      const old = mesh.material as unknown as {
        color?: Color
        map?: Texture | null
      }
      mesh.material = toonify(
        new MeshLambertMaterial({
          color: old.color ? old.color.clone() : new Color(0xffffff),
          map: old.map ?? null,
        }),
      )
    })
  }

  private setupAnimations(clips: readonly { name: string }[]): void {
    if (clips.length === 0) return
    this.mixer = new AnimationMixer(this.object)

    const actions = clips.map((clip) => this.mixer!.clipAction(clip as never))
    this.actions = actions

    // 播放第一段，避免加载后角色僵在原地
    this.currentAction = actions[0]
    this.currentAction.play()
  }

  /**
   * 按名字匹配一段动画。
   *
   * 不能只做「包含」匹配：KayKit 的角色带 76 段动画，`idle` 会先撞上
   * `2H_Melee_Idle`（持械待机），角色就会双手空握摆出握剑姿势站桩。
   * 所以分三级——全等优先，其次选名字最短的包含匹配（`Idle` 比
   * `2H_Melee_Idle` 短，正是想要的），最后才退到任意包含。
   */
  private findAction(keywords: string[]): AnimationAction | null {
    const named = this.actions.map((a) => ({
      action: a,
      name: (a.getClip().name ?? '').toLowerCase(),
    }))

    for (const kw of keywords) {
      const exact = named.find((n) => n.name === kw)
      if (exact) return exact.action
    }

    for (const kw of keywords) {
      let best: AnimationAction | null = null
      let bestLength = Infinity
      for (const n of named) {
        if (!n.name.includes(kw)) continue
        if (n.name.length < bestLength) {
          bestLength = n.name.length
          best = n.action
        }
      }
      if (best) return best
    }

    return null
  }

  private play(action: AnimationAction | null): void {
    if (!action || action === this.currentAction) return
    action.reset()
    action.fadeIn(0.22).play()
    this.currentAction?.fadeOut(0.22)
    this.currentAction = action
  }

  update(position: Vector3, yaw: number, dt: number, state: AvatarState): void {
    // 游泳时不下沉。
    //
    // 控制器已经把 position.y 停在水面下 0.35 米处（那是角色的原点/脚底），
    // 这里再压 1.05 米就是重复计算——两次下沉叠起来，整个人沉到水面以下
    // 两米多，从岸上看只剩一团模糊的影子。放平之后靠姿态本身就够低了
    const targetSink = 0
    this.sinkOffset += (targetSink - this.sinkOffset) * Math.min(1, dt * 6)

    this.object.position.set(position.x, position.y + this.sinkOffset, position.z)

    // 姿态用 YXZ 顺序合成：**先绕自身 X 轴压出俯仰，再整体绕世界 Y 轴转到朝向**。
    //
    // 这不是随便挑的顺序。默认的 XYZ 会先转 yaw 再转 pitch，而 pitch 是绕
    // **世界** X 轴做的——角色朝东的时候，一个"前倾"会变成侧翻，整个人横着
    // 立在水里。之前游泳那个竖直漂在水里的姿势就是这么来的。
    const targetTilt =
      state.state === 'climb'
        ? 0.3
        : state.state === 'glide'
          ? -0.12
          : state.state === 'swim'
            ? SWIM_TILT
            : 0
    this.tilt += (targetTilt - this.tilt) * Math.min(1, dt * 4)

    // 朝向直接取 yaw，不做补偿。
    //
    // 这里原来加过一个 180°，理由是「glTF 约定朝 -Z」——那条约定对
    // 手工导出的模型成立，但 KayKit 这套是在 Blender 里做的，导出时
    // Blender 的 -Y（角色正面）映射到 glTF 的 +Z，正好和控制器里
    // `yaw = atan2(dirX, dirZ)` 的语义一致。多转那半圈的结果是角色
    // 全程倒着走：脸朝着身后，退着往前进方向挪。
    this.object.rotation.set(this.tilt, yaw, 0, 'YXZ')

    this.updateAnimation(state, dt)

    // 动画推进完之后再叠划水，否则会被 mixer 覆盖掉
    if (state.state === 'swim') this.applySwimStroke(dt, state.speed)

    this.updateGlider(dt, state.state === 'glide')
  }

  /**
   * 一次性动作（攻击）：播完之前不让循环动作抢回去。
   * 返回 true 表示这一帧仍然被它占据。
   */
  private playOneShot(keywords: string[], fade = 0.08): boolean {
    if (this.oneShot) {
      const clip = this.oneShot.getClip()
      // 循环动作被打断过就重新触发，否则让它播到自然结束
      if (this.oneShot.isRunning() && this.oneShot.time < clip.duration - 1e-3) return true
      this.oneShot = null
    }

    const action = this.findAction(keywords)
    if (!action) return false

    action.reset()
    action.setLoop(LoopOnce, 1)
    // 停在最后一帧而不是弹回第一帧：收招瞬间切回待机会有一个明显的抽搐
    action.clampWhenFinished = true
    // 把动画压进这次出招的时长里（时长随武器走：匕首快、大剑慢）。
    // 只加速不减速：动画比出招还短的话让它自然播完，拉长会变成慢动作
    const clipSeconds = action.getClip().duration || this.attackDuration
    action.timeScale = Math.max(0.85, clipSeconds / this.attackDuration)
    action.fadeIn(fade).play()
    if (this.currentAction && this.currentAction !== action) this.currentAction.fadeOut(fade)
    this.currentAction = action
    this.oneShot = action
    return true
  }

  private updateAnimation(state: AvatarState, dt: number): void {
    if (!this.mixer) return

    // 闪避优先于攻击：翻滚时被打断会卡在半路，位移和动画对不上
    if (state.dodging && this.playOneShot(DODGE_CLIPS, 0.05)) {
      this.mixer.update(dt)
      return
    }
    // 格挡姿势：盾举在身前。优先级低于攻击与闪避——那两件事情发生时
    // 说明玩家已经放弃格挡了
    if (state.blocking && !state.attacking && !state.dodging) {
      this.play(this.findAction(['blocking', 'block']) ?? this.actions[0])
      this.mixer.update(dt)
      return
    }
    // 蓄力姿势：按住攻击键时压低重心备战。优先级低于攻击本身——
    // 旋风斩放出去那一刻就不再是蓄力了
    if (state.charging && !state.attacking) {
      this.play(this.findAction(CHARGE_CLIPS) ?? this.actions[0])
      this.mixer.update(dt)
      return
    }
    // 攻击优先级次之：出招时不切动作，否则砍到一半会自己走起来
    if (state.attacking) {
      const progress = state.attackProgress ?? 0
      // 进度回落说明上一轮出招结束、新一轮（连击）开始。
      // 必须主动丢掉旧的一次性动作——它还停在收招帧上，不丢的话
      // 连击时第二剑会"用第一剑的结尾姿势砍出去"
      if (progress < this.lastAttackProgress - 0.01) this.oneShot = null
      this.lastAttackProgress = progress

      const combo = state.attackCombo ?? 0
      const table = MOVESET_CLIPS[this.moveset] ?? MOVESET_CLIPS['1h']
      const keywords = table[combo % table.length] ?? ATTACK_CLIPS
      if (this.playOneShot(keywords)) {
        this.mixer.update(dt)
        return
      }
    } else {
      this.lastAttackProgress = 0
    }

    const airborne = !state.grounded && state.state !== 'swim' && state.state !== 'climb'

    if (state.state === 'climb') {
      // 没有专门的攀爬动画，用待机顶上；攀爬的姿态靠整体前倾表达
      this.play(this.findAction(['idle', 'stand']) ?? this.actions[0])
    } else if (state.state === 'glide') {
      // 悬空动作比待机更像张开滑翔伞的姿势
      this.play(this.findAction(['jump_idle', 'idle']) ?? this.actions[0])
    } else if (state.state === 'swim') {
      // 基础动作用待机而不是走路：划水由骨骼单独驱动，再叠一套走路的
      // 摆腿会变成两套动作打架，腿看起来像在抽搐
      this.play(this.findAction(['swim', 'idle']) ?? this.actions[0])
    } else if (airborne) {
      // 刚离地放起跳动作，之后维持悬空姿势
      const jump = this.wasAirborne
        ? this.findAction(['jump_idle', 'jump_start'])
        : this.findAction(['jump_start', 'jump_idle'])
      this.play(jump ?? this.findAction(['idle']) ?? this.actions[0])
    } else if (state.speed > 6) {
      this.play(this.findAction(['running', 'walking']) ?? this.actions[0])
    } else if (state.speed > 0.5) {
      this.play(this.findAction(['walking', 'running']) ?? this.actions[0])
    } else {
      this.play(this.findAction(['idle', 'stand']) ?? this.actions[0])
    }

    this.wasAirborne = airborne

    // 播放速率跟着实际速度走，避免"跑得慢但腿摆得快"的脚滑感。
    // 基准速度取控制器里的 runSpeed/walkSpeed，动作才不会整体偏快或偏慢。
    if (this.currentAction && (state.speed > 0.5 || state.state === 'swim')) {
      const base = state.speed > 6 ? RUN_CLIP_SPEED : WALK_CLIP_SPEED
      this.currentAction.timeScale = Math.max(0.55, Math.min(1.9, state.speed / base))
    } else if (this.currentAction) {
      this.currentAction.timeScale = 1
    }

    this.mixer.update(dt)

    // 记录动画算出来的姿势。划水要叠加在它之上，而不是替换它——
    // 基准采早了会把这一帧的动画整个盖掉
    for (const b of this.swimBones) b.base.copy(b.bone.quaternion)
  }

  /** 滑翔伞的展开/收起。用连续变量而不是布尔量，开合才有过渡 */
  private updateGlider(dt: number, gliding: boolean): void {
    if (!this.glider) return
    const target = gliding ? 1 : 0
    this.gliderOpen += (target - this.gliderOpen) * Math.min(1, dt * 9)
    this.gliderPhase += dt

    const open = this.gliderOpen
    // 完全收起时直接隐藏，省掉一次绘制
    this.glider.visible = open > 0.02
    if (!this.glider.visible) return

    // 横向撑开、纵向略抬：布料鼓起来的过程
    const spread = 0.25 + open * 0.75
    this.glider.scale.set(spread, 0.35 + open * 0.65, spread)
    // 被风推着轻轻晃，静止滑翔时也不至于像根木棍钉在头上
    this.glider.rotation.z = Math.sin(this.gliderPhase * 1.6) * 0.055 * open
    this.glider.rotation.x = Math.sin(this.gliderPhase * 1.1 + 1.3) * 0.04 * open
  }

  dispose(): void {
    this.mixer?.stopAllAction()
    if (this.glider) {
      this.glider.geometry.dispose()
      const gm = this.glider.material
      if (Array.isArray(gm)) gm.forEach((m) => m.dispose())
      else gm.dispose()
    }
    this.object.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
  }
}
