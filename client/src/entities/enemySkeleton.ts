/**
 * 骷髅敌人：把 KayKit 的骨骼模型接到 Enemy 原有的程序化动画上。
 *
 * ── 为什么不是简单地播动画 ──
 *
 * KayKit 的骷髅自带 95 段动画，直接播当然最省事。但 Enemy 里那套动作
 * 已经和玩法绑死了：受击时侧倾、出招时双臂前扑、站着不动时呼吸起伏，
 * 都是按状态机实时算出来的。改用预录动画就得重写整套状态机，还得为
 * 「追到一半被打断」这种中间态找合适的过渡——不划算。
 *
 * 所以这里做的是**叠加**：骨架照常播 Idle（保证站姿自然，而不是
 * 摊成 T 字），Enemy 算出的摆动角再叠加上去。实现上给每根要驱动的
 * 骨头配一个空 pivot，Enemy 照旧写 `armL.rotation.x = swing`，
 * pivot 上的旋转每帧被乘进骨骼的局部旋转里。
 *
 * 一帧的顺序必须是：推进动画 → 记录基准旋转 → Enemy 设摆动 → 叠加。
 * 基准必须在动画之后采，否则叠加会把动画姿势整个盖掉。
 */

import {
  AnimationAction,
  AnimationMixer,
  LoopOnce,
  Box3,
  Group,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Bone,
  Vector3,
  type AnimationClip,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type SkinnedMesh,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import type { EnemyRig } from './enemyVisual.ts'

export interface SkeletonTemplate {
  /** 已完成等比缩放（脚底对齐 y=0）的模型根节点 */
  scene: Object3D
  clips: AnimationClip[]
}

/** 目标身高（米）。和手写版的体型接近，不会因为换模型而改变战斗距离感 */
const TARGET_HEIGHT = 1.55

/** 骨架里循环播放的基础动作。没有它骷髅会摊成 T 字 */
const BASE_CLIP = 'idle'

/**
 * 骨骼跨度 → 实际身高的换算系数。
 *
 * 骨骼只覆盖到头顶那一根（长在头骨中心），头骨本身还有大半截在上面，
 * 而这套素材的骷髅是 Q 版大脑袋，头骨占比比真人夸张得多——所以这个
 * 系数明显大于 1。
 *
 * 数值是拿渲染结果反推的，不是估的：缩放后骨骼跨度 1.136 米时，
 * 逐顶点量出来的实际可见高度是 1.99 米，比值 1.75。
 * 换骷髅模型的话这个数要重新标定。
 */
const BONE_TO_TOP = 1.75

/**
 * rig 上的关节名 → 骨架里的骨骼名。
 * KayKit 沿用了 Blender 的小写加点命名（`upperarm.l`）。
 */
const JOINT_BONES: Record<string, string> = {
  torso: 'chest',
  armL: 'upperarm.l',
  armR: 'upperarm.r',
  legL: 'upperleg.l',
  legR: 'upperleg.r',
}

/**
 * 归一化骨骼名后再比对。
 *
 * **GLTFLoader 会把名字里的点剥掉**：模型文件里写的是 `upperarm.l`，
 * 加载到场景里就成了 `upperarml`。按原名去找一根都匹配不上，而失败
 * 是静默的——drivers 数组空着，程序化的挥爪和摆腿全部变成空操作，
 * 表现是"骷髅只会平移"。玩家那边的蛙泳也栽在同一个坑里。
 */
export function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[._\-\s]/g, '')
}

interface JointDriver {
  /** Enemy 直接操作它的 rotation */
  pivot: Object3D
  bone: Object3D
  /** 骨骼的绑定姿势旋转。每帧复位到它，再让动画覆盖 */
  rest: Quaternion
  /** 本帧动画算出的骨骼局部旋转，摆动叠加在它之上 */
  base: Quaternion
}

/** 加载并归一化模板。失败返回 null，调用方回退到手写外观 */
export async function loadSkeletonTemplate(url: string): Promise<SkeletonTemplate | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(url)
    const scene = gltf.scene

    // 量身高有两个坑，都得绕开：
    //
    // 1. `Box3.setFromObject` 会把 41 根骨骼连同 IK 控制器一起算进去，
    //    量出来比模型本身高一截。
    // 2. 几何体包围盒量的是**绑定姿势**（T 字张开、手臂上举），也不是
    //    站在地上的样子——按它缩放，骷髅会矮一头。
    //
    // 所以先把基础动作推一帧让骨架摆成站姿，再逐顶点问 SkinnedMesh
    // 「蒙皮之后你在哪」，得到的才是真正会被渲染的体积。
    const mixer = new AnimationMixer(scene)
    const stand = gltf.animations.find((c) => c.name.toLowerCase() === BASE_CLIP)
    if (stand) {
      mixer.clipAction(stand).play()
      // 推一帧就够：Idle 是循环动作，第一帧已经是站姿
      mixer.update(1 / 30)
    }
    scene.updateMatrixWorld(true)
    // 还得手动刷新一次骨骼矩阵。Skeleton 的 boneMatrices 平时是渲染器在
    // 出图前算的，这里没有渲染，不刷的话 getVertexPosition 拿到的还是
    // 绑定姿势——量出来的身高和几何体包围盒一模一样，白量
    scene.traverse((child) => {
      const mesh = child as SkinnedMesh
      if (mesh.isSkinnedMesh) mesh.skeleton.update()
    })

    // 量身高用**骨骼的世界位置**：它是现算的，反映的就是当前姿势。
    //
    // 另外两条路都走过，都不通：
    //  - 几何体包围盒量的是绑定姿势（T 字张开）的体积，比站姿高出四分之一，
    //    按它缩放骷髅会矮一头。
    //  - getVertexPosition 依赖 Skeleton 的骨骼矩阵，而那套矩阵平时是渲染器
    //    出图前才刷新的；加载阶段拿到的是初始值，量出来和包围盒一模一样。
    const box = new Box3()
    const point = new Vector3()
    scene.traverse((child) => {
      if ((child as Bone).isBone) box.expandByPoint(child.getWorldPosition(point))
    })
    if (box.isEmpty()) return null

    // 头顶那根骨骼长在头骨中心，往上还有约三分之一骨骼跨度的余量才是真正的
    // 头顶。系数是拿渲染结果反推的（骨骼跨度 1.225 → 实际身高 1.654）
    const span = Math.max(0.001, box.max.y - box.min.y)
    const height = span * BONE_TO_TOP
    console.log(
      `[敌人] 骨架量体：骨骼跨度 ${span.toFixed(3)} → 身高 ${height.toFixed(3)}`,
    )
    const scale = TARGET_HEIGHT / height
    scene.scale.setScalar(scale)
    // 脚底对齐到原点：Enemy 直接把根节点放在地表高度上
    scene.position.y = -box.min.y * scale

    return { scene, clips: gltf.animations }
  } catch (err) {
    console.warn('[敌人] 骷髅模型加载失败，回退到手写外观：', err)
    return null
  }
}

/** 由模板实例化一个敌人外观 */
export function createSkeletonRig(template: SkeletonTemplate): EnemyRig {
  const instance = cloneSkeleton(template.scene)
  // 不做朝向补偿：KayKit 在 Blender 里做，导出后角色正面就是 +Z，
  // 和 enemy.ts 里 `yaw = atan2(dx, dz)` 的约定一致。原来加过一个 180°，
  // 结果骷髅和主角一样全程倒着走——退着追人，背对着挥爪
  const root = new Group()
  root.add(instance)

  // ── 材质：每个敌人一份 ──
  // 受击闪红改的是材质的 emissive，共享材质会让整场敌人一起闪
  const materials: MeshLambertMaterial[] = []
  const remap = new Map<Material, MeshLambertMaterial>()
  instance.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = false

    const source = mesh.material as MeshStandardMaterial
    let next = remap.get(source)
    if (!next) {
      next = new MeshLambertMaterial({
        color: source.color?.clone(),
        map: source.map ?? null,
        // 眼睛那层是自发光的，转成 Lambert 后 emissive 要显式带过来，
        // 否则骷髅会变成两只黑洞
        emissive: source.emissive?.clone(),
        emissiveMap: source.emissiveMap ?? null,
        emissiveIntensity: source.emissiveIntensity ?? 1,
      })
      remap.set(source, next)
      materials.push(next)
    }
    mesh.material = next
  })

  // ── 骨骼：给每根要驱动的骨头配一个 pivot ──
  const bones = new Map<string, Object3D>()
  instance.traverse((child) => {
    if (child.name) bones.set(normalizeBoneName(child.name), child)
  })

  const drivers: JointDriver[] = []
  const bind = (joint: string): Object3D => {
    const pivot = new Object3D()
    const bone = bones.get(normalizeBoneName(JOINT_BONES[joint]))
    if (bone) {
      const rest = bone.quaternion.clone()
      drivers.push({ pivot, bone, rest, base: rest.clone() })
    } else {
      console.warn(`[敌人] 骨架里找不到骨骼 ${JOINT_BONES[joint]}`)
    }
    return pivot
  }

  // ── 动画 ──
  // 走、跑用骨架自带的循环动作，不再靠程序化摆腿。
  //
  // 之前只播 Idle、靠腿骨前后摆动模拟走路，动静对不上：脚在原地划水，
  // 身体却整体向前平移，看起来像踩着滑板。骨架里有现成的 Walking_A /
  // Running_A，没有理由不用。
  const mixer = new AnimationMixer(instance)
  const actionOf = (name: string): AnimationAction | null => {
    const clip = template.clips.find((c) => c.name.toLowerCase() === name)
    return clip ? mixer.clipAction(clip) : null
  }
  const idleAction = actionOf(BASE_CLIP)
  const walkAction = actionOf('walking_a')
  const runAction = actionOf('running_a')
  // 攻击和死亡用一次性动作。骨架里这几段都有现成的，比程序化摆手臂
  // 自然得多——挥砍的起手、转腰、收招都在动画里
  const attackAction =
    actionOf('1h_melee_attack_chop') ?? actionOf('1h_melee_attack_slice_diagonal')
  const deathAction = actionOf('death_a')

  let current: AnimationAction | null = null
  /** 正在播的一次性动作，播完之前不让循环动作抢回去 */
  let oneShot: AnimationAction | null = null

  const switchTo = (action: AnimationAction | null, fade: number): void => {
    if (!action || action === current) return
    action.reset().setEffectiveWeight(1).fadeIn(fade).play()
    current?.fadeOut(fade)
    current = action
  }

  const playOnce = (action: AnimationAction | null, fade: number): boolean => {
    if (!action) return false
    if (oneShot) {
      const clip = oneShot.getClip()
      if (oneShot.isRunning() && oneShot.time < clip.duration - 1e-3) return true
      oneShot = null
    }
    action.reset()
    action.setLoop(LoopOnce, 1)
    // 停在最后一帧：死亡动作弹回第一帧会看到尸体站起来
    action.clampWhenFinished = true
    action.timeScale = 1
    action.fadeIn(fade).play()
    if (current && current !== action) current.fadeOut(fade)
    current = action
    oneShot = action
    return true
  }

  // 先摆出待机姿势，否则第一帧是绑定姿势（T 字）
  switchTo(idleAction, 0)

  /** 动作片段对应的设计速度（米/秒），用来算播放速率，避免脚滑 */
  const WALK_CLIP_SPEED = 1.6
  const RUN_CLIP_SPEED = 3.6

  return {
    root,
    torso: bind('torso'),
    armL: bind('armL'),
    armR: bind('armR'),
    legL: bind('legL'),
    legR: bind('legR'),
    materials,
    // 几何体由模板共享，实例只持有材质，所以这里留空避免被误释放
    geometries: [],
    update(dt: number, speed = 0) {
      // 先把被驱动的骨骼复位到绑定姿势，再让动画覆盖。
      //
      // 这一步不能省。动画只驱动了部分骨骼，chest、upperarm 这些在走路
      // 动作里未必有轨道——不复位的话，上一帧叠加出来的结果会被当成这一帧
      // 的基准，摆动角度于是逐帧累加，几秒钟后脑袋就甩到身体外面去了。
      for (const d of drivers) d.bone.quaternion.copy(d.rest)

      // 一次性动作在播时不要抢它的控制权
      const busy = oneShot !== null && oneShot.isRunning()
      if (!busy) {
        // 按速度挑循环动作。跑起来用 Running_A，走用 Walking_A，停下来回 Idle
        const running = speed > RUN_CLIP_SPEED * 0.75
        const moving = speed > 0.5
        switchTo(running ? runAction : moving ? walkAction : idleAction, 0.22)
      }

      // 播放速率跟着实际速度走：骷髅追人时速度是 3.6 m/s，
      // 如果动作按 1 倍速播，脚会明显地在地上划
      const running = speed > RUN_CLIP_SPEED * 0.75
      const moving = speed > 0.5
      if (current && moving && !busy) {
        const base = running ? RUN_CLIP_SPEED : WALK_CLIP_SPEED
        current.timeScale = Math.max(0.6, Math.min(1.7, speed / base))
      } else if (current && !busy) {
        current.timeScale = 1
      }

      mixer.update(dt)
      // 基准必须在推进动画之后采：先采就记的是复位前的姿势
      for (const d of drivers) d.base.copy(d.bone.quaternion)
    },
    syncPose() {
      for (const d of drivers) {
        d.bone.quaternion.copy(d.base).multiply(d.pivot.quaternion)
      }
    },
    playAttack() {
      playOnce(attackAction, 0.06)
    },
    playDeath() {
      playOnce(deathAction, 0.1)
    },
    dispose() {
      mixer.stopAllAction()
    },
  }
}
