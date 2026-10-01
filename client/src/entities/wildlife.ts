/**
 * 野生动物：可打猎的鹿、狐狸、狼，加上程序化的野猪和兔子。
 *
 * 为什么要分两类实现：
 * Quaternius 的四种动物自带完整骨骼动画（吃草/疾跑/攻击/死亡），
 * 直接用 mixer 驱动即可；野猪和兔子没有现成素材，用低多边形
 * 几何拼出来、四根腿骨程序化摆动——动物只要"跑起来腿在动"，
 * 玩家就不会深究步态是否标准。
 *
 * 行为是一台小状态机：
 *   graze ──玩家靠近──▶ alert（抬头看一眼）──更近/被打──▶ flee
 *   狼与野猪是例外：它们朝玩家来（aggro），近身就撞。
 *
 * 猎杀的意义在锅里：野兽掉生肉，生肉是烹饪系统的核心食材。
 */

import {
  AnimationMixer,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LoopOnce,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'
import type { AttackTarget } from '../gameplay/playerCombat.ts'
import { Health } from '../gameplay/health.ts'

export type AnimalKind = 'deer' | 'stag' | 'fox' | 'wolf' | 'boar' | 'rabbit'

export interface AnimalDef {
  kind: AnimalKind
  name: string
  /** glTF 模型路径；null = 程序化拼装 */
  model: string | null
  /** 归一化后的肩高（米） */
  height: number
  health: number
  /** 逃跑速度。鹿比玩家冲刺慢一点——追得上，但要花点体力 */
  fleeSpeed: number
  /** 主动攻击的种类：伤害与追击速度。0 = 纯逃跑 */
  damage: number
  aggroSpeed: number
  /** 玩家靠多近开始警觉 */
  alertRange: number
  /** 警觉后再近一点就逃/反击 */
  fleeRange: number
  /** 掉几块生肉 */
  meat: number
}

export const ANIMAL_DEFS: Record<AnimalKind, AnimalDef> = {
  deer: {
    kind: 'deer', name: '鹿', model: '/assets/animals/Deer.gltf', height: 1.35,
    health: 2, fleeSpeed: 8.2, damage: 0, aggroSpeed: 0,
    alertRange: 15, fleeRange: 9, meat: 1,
  },
  stag: {
    kind: 'stag', name: '雄鹿', model: '/assets/animals/Stag.gltf', height: 1.55,
    health: 3, fleeSpeed: 7.8, damage: 0, aggroSpeed: 0,
    alertRange: 14, fleeRange: 8, meat: 2,
  },
  fox: {
    kind: 'fox', name: '狐狸', model: '/assets/animals/Fox.gltf', height: 0.62,
    health: 1, fleeSpeed: 8.8, damage: 0, aggroSpeed: 0,
    alertRange: 16, fleeRange: 10, meat: 1,
  },
  wolf: {
    kind: 'wolf', name: '狼', model: '/assets/animals/Wolf.gltf', height: 1.05,
    health: 3, fleeSpeed: 8.5, damage: 1, aggroSpeed: 7.0,
    alertRange: 18, fleeRange: 12, meat: 2,
  },
  boar: {
    kind: 'boar', name: '野猪', model: null, height: 0.9,
    // 野猪的脾气：被打后掉头撞回来，伤害不高但会把人顶开
    health: 4, fleeSpeed: 6.5, damage: 1, aggroSpeed: 6.8,
    alertRange: 12, fleeRange: 7, meat: 2,
  },
  rabbit: {
    kind: 'rabbit', name: '兔子', model: null, height: 0.42,
    health: 1, fleeSpeed: 9.2, damage: 0, aggroSpeed: 0,
    alertRange: 14, fleeRange: 9, meat: 1,
  },
}

type AnimalState = 'graze' | 'alert' | 'flee' | 'aggro' | 'attack' | 'dead'

/** 攻击后逃跑多久再回头吃草（秒） */
const FLEE_DURATION = 5
/** 尸体停留时间（秒） */
const CORPSE_SECONDS = 2.6
/** 攻击动作时长与命中时刻 */
const ATTACK_DURATION = 0.7
const ATTACK_HIT_AT = 0.4
/** 狼/野猪的攻击距离与冷却 */
const ATTACK_RANGE = 1.9
const ATTACK_COOLDOWN = 1.4

/** 每种动物的视觉驱动器接口 */
interface AnimalRig {
  readonly object: Group
  /** 每帧驱动。speed 用于步频，state 决定播哪段 */
  update(dt: number, speed: number, state: AnimalState): void
  dispose(): void
}

// ════════════════════════════════════════════════════════════════
//  glTF 动物（鹿/雄鹿/狐狸/狼）
// ════════════════════════════════════════════════════════════════

interface AnimalTemplate {
  scene: Object3D
  animations: AnimationClip[]
}

const templateCache = new Map<string, Promise<AnimalTemplate | null>>()

function loadTemplate(url: string): Promise<AnimalTemplate | null> {
  let p = templateCache.get(url)
  if (!p) {
    p = (async () => {
      try {
        const gltf = await new GLTFLoader().loadAsync(url)
        return { scene: gltf.scene, animations: gltf.animations }
      } catch (err) {
        console.warn('[野兽] 模型加载失败：', url, err)
        return null
      }
    })()
    templateCache.set(url, p)
  }
  return p
}

class GltfAnimalRig implements AnimalRig {
  readonly object = new Group()
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, AnimationAction>()
  private current: AnimationAction | null = null

  constructor(tpl: AnimalTemplate, height: number) {
    // SkeletonUtils.clone 才是骨骼模型的正确克隆方式——普通 clone()
    // 会让所有副本共享同一副骨架，一只鹿跑起来全场的鹿跟着跑
    const inner = cloneSkinned(tpl.scene)
    const box = measureObject(inner)
    const rawH = Math.max(0.001, box.max.y - box.min.y)
    const s = height / rawH
    inner.scale.setScalar(s)
    inner.position.y = -box.min.y * s

    inner.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.frustumCulled = false
      // 与场景统一质感：Lambert + 保留顶点色
      const old = mesh.material as { color?: Color; vertexColors?: boolean }
      mesh.material = new MeshLambertMaterial({
        color: old.color ? old.color.clone() : new Color(0xffffff),
        vertexColors: old.vertexColors ?? true,
      })
    })
    this.object.add(inner)

    this.mixer = new AnimationMixer(inner)
    for (const clip of tpl.animations) {
      this.actions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip))
    }
    this.play('idle', 0)
  }

  private play(name: string, fade = 0.25): void {
    const next = this.actions.get(name) ?? this.actions.get('idle')
    if (!next || next === this.current) return
    next.reset().fadeIn(fade).play()
    this.current?.fadeOut(fade)
    this.current = next
  }

  private playOnce(name: string): void {
    const action = this.actions.get(name)
    if (!action) return
    action.reset()
    action.setLoop(LoopOnce, 1)
    action.clampWhenFinished = true
    action.fadeIn(0.08).play()
    this.current?.fadeOut(0.08)
    this.current = action
  }

  update(dt: number, speed: number, state: AnimalState): void {
    switch (state) {
      case 'graze':
        // 站着吃草与慢走切换由速度表达：在吃就低头，在走就迈步
        this.play(speed > 0.4 ? 'walk' : 'eating')
        break
      case 'alert':
        this.play('idle', 0.15)
        break
      case 'flee':
      case 'aggro':
        this.play('gallop', 0.12)
        break
      case 'attack':
        this.playOnce('attack_headbutt')
        break
      case 'dead':
        this.playOnce('death')
        break
    }
    if (this.current && (state === 'flee' || state === 'aggro')) {
      // 步频跟上实际速度，逃跑时四蹄翻飞而不是慢悠悠
      this.current.timeScale = Math.max(0.8, Math.min(1.6, speed / 7))
    }
    this.mixer.update(dt)
  }

  dispose(): void {
    this.mixer.stopAllAction()
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

/** 骨骼模型克隆：three 官方工具，深拷贝骨架并保持蒙皮绑定 */
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'

// ════════════════════════════════════════════════════════════════
//  程序化动物（野猪/兔子）
// ════════════════════════════════════════════════════════════════

class ProceduralAnimalRig implements AnimalRig {
  readonly object = new Group()
  private readonly legs: Mesh[] = []
  private readonly ears: Mesh[] = []
  private phase = Math.random() * Math.PI * 2
  private deathT = 0

  constructor(kind: 'boar' | 'rabbit') {
    if (kind === 'boar') this.buildBoar()
    else this.buildRabbit()
    this.object.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.isMesh) mesh.castShadow = true
    })
  }

  /**
   * 野猪：椭圆身子 + 方脑袋 + 两根獠牙 + 背上鬃毛。
   * 低多边形动物的画法是剪影优先——獠牙和鬃毛一加上，
   * 不用贴图也知道这是野猪。
   */
  private buildBoar(): void {
    const body = mat(0x6b4f38)
    const dark = mat(0x4c3826)

    const torso = new Mesh(new SphereGeometry(0.52, 10, 8), body)
    torso.scale.set(1.45, 1, 1)
    torso.position.y = 0.55
    this.object.add(torso)

    // 鬃毛：背脊上一排压扁的锥
    for (let i = 0; i < 4; i++) {
      const bristle = new Mesh(new ConeGeometry(0.09, 0.22, 4), dark)
      bristle.position.set(-0.3 + i * 0.2, 1.02 - Math.abs(i - 1.5) * 0.05, 0)
      this.object.add(bristle)
    }

    const head = new Mesh(new BoxGeometry(0.42, 0.4, 0.44), body)
    head.position.set(0.82, 0.52, 0)
    this.object.add(head)
    const snout = new Mesh(new CylinderGeometry(0.1, 0.13, 0.18, 6), dark)
    snout.rotation.z = Math.PI / 2
    snout.position.set(1.06, 0.46, 0)
    this.object.add(snout)

    // 獠牙：嘴两侧上翘的白锥
    const tuskMat = mat(0xe8e0cc)
    for (const side of [-1, 1]) {
      const tusk = new Mesh(new ConeGeometry(0.035, 0.2, 5), tuskMat)
      tusk.position.set(1.0, 0.38, side * 0.17)
      tusk.rotation.set(side * 0.5, 0, -0.5)
      this.object.add(tusk)
    }

    for (const sx of [-0.42, 0.42]) {
      for (const sz of [-0.26, 0.26]) {
        const leg = new Mesh(new CylinderGeometry(0.07, 0.06, 0.44, 5), dark)
        // 腿的原点在髋部：摆腿是绕髋转，不是绕腿中心
        leg.geometry.translate(0, -0.22, 0)
        leg.position.set(sx, 0.44, sz)
        this.legs.push(leg)
        this.object.add(leg)
      }
    }
  }

  /** 兔子：圆身 + 长耳朵。耳朵是兔子的全部辨识度 */
  private buildRabbit(): void {
    const fur = mat(0xb9a08a)
    const body = new Mesh(new SphereGeometry(0.22, 9, 7), fur)
    body.scale.set(1.35, 1, 1)
    body.position.y = 0.2
    this.object.add(body)

    const head = new Mesh(new SphereGeometry(0.14, 8, 6), fur)
    head.position.set(0.28, 0.32, 0)
    this.object.add(head)

    for (const side of [-1, 1]) {
      const ear = new Mesh(new ConeGeometry(0.045, 0.3, 5), fur)
      ear.geometry.translate(0, 0.15, 0)
      ear.position.set(0.24, 0.42, side * 0.06)
      ear.rotation.x = side * 0.12
      this.ears.push(ear)
      this.object.add(ear)
    }

    const tail = new Mesh(new SphereGeometry(0.07, 6, 5), mat(0xe8e0d8))
    tail.position.set(-0.3, 0.24, 0)
    this.object.add(tail)

    for (const sx of [-0.12, 0.14]) {
      for (const sz of [-0.09, 0.09]) {
        const leg = new Mesh(new CylinderGeometry(0.032, 0.028, 0.16, 4), fur)
        leg.geometry.translate(0, -0.08, 0)
        leg.position.set(sx, 0.16, sz)
        this.legs.push(leg)
        this.object.add(leg)
      }
    }
  }

  update(dt: number, speed: number, state: AnimalState): void {
    this.phase += dt * (2 + speed * 2.4)

    if (state === 'dead') {
      // 侧倒下去。没有死亡动画可用，倒下的剪影同样读得懂
      this.deathT = Math.min(1, this.deathT + dt * 3)
      this.object.rotation.z = this.deathT * 1.45
      this.object.position.y += (this.deathT * 0.1)
      return
    }

    // 腿：对角两两同相（左前+右后 / 右前+左后），这是四足动物的
    // 基本步态；同侧同相会像木偶被横着拖
    const amp = Math.min(0.7, 0.15 + speed * 0.09)
    for (let i = 0; i < this.legs.length; i++) {
      const phaseOffset = i % 2 === 0 ? 0 : Math.PI
      this.legs[i].rotation.z = Math.sin(this.phase + phaseOffset) * amp
    }
    // 耳朵跑动时向后贴，警觉时竖起来
    const earBack = state === 'flee' || state === 'aggro' ? -0.55 : 0
    for (const ear of this.ears) {
      ear.rotation.z += (earBack - ear.rotation.z) * Math.min(1, dt * 6)
    }
    // 警觉时猛地抬头（身子前倾）
    const pitch = state === 'alert' ? -0.18 : 0
    this.object.rotation.z += (pitch - this.object.rotation.z) * Math.min(1, dt * 8)
  }

  dispose(): void {
    this.object.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.isMesh) mesh.geometry.dispose()
    })
  }
}

let cachedFurMaterials = new Map<number, MeshLambertMaterial>()
function mat(color: number): MeshLambertMaterial {
  let m = cachedFurMaterials.get(color)
  if (!m) {
    m = new MeshLambertMaterial({ color })
    cachedFurMaterials.set(color, m)
  }
  return m
}

// ════════════════════════════════════════════════════════════════
//  个体与种群
// ════════════════════════════════════════════════════════════════

export class Animal implements AttackTarget {
  readonly group = new Group()
  readonly health: Health
  readonly def: AnimalDef

  readonly position = new Vector3()
  yaw = 0
  state: AnimalState = 'graze'
  /** 尸体停留计时，供外部决定何时移除 */
  deadFor = 0

  private readonly rig: AnimalRig
  private stateTimer = 0
  private attackTimer = 0
  private attackCooldown = 0
  private attackHitDone = false
  /** 闲逛目标点 */
  private wanderX = 0
  private wanderZ = 0
  private speed = 0

  constructor(def: AnimalDef, rig: AnimalRig) {
    this.def = def
    this.health = new Health(def.health)
    this.rig = rig
    this.group.add(rig.object)
  }

  spawnAt(x: number, z: number, terrain: Heightfield): void {
    this.position.set(x, terrain.height(x, z), z)
    this.wanderX = x
    this.wanderZ = z
    this.yaw = Math.random() * Math.PI * 2
  }

  /** 挨打：掉血、记仇（狼/野猪转反击）或逃跑 */
  onHit(damage: number, knockbackDir: Vector3, knockbackForce: number): void {
    if (this.health.isDead) return
    this.health.damage(damage, 0)
    if (this.health.isDead) {
      this.state = 'dead'
      this.deadFor = 0
      return
    }
    this.position.x += knockbackDir.x * knockbackForce * 0.04
    this.position.z += knockbackDir.z * knockbackForce * 0.04
    // 温顺的动物挨一下就跑；狼和野猪被激怒反过来追
    this.state = this.def.damage > 0 ? 'aggro' : 'flee'
    this.stateTimer = 0
  }

  update(
    dt: number,
    playerPos: Vector3,
    terrain: Heightfield,
    onAttackPlayer: (damage: number, fromPos: Vector3) => void,
  ): void {
    if (this.state === 'dead') {
      this.deadFor += dt
      this.rig.update(dt, 0, 'dead')
      this.syncVisual()
      return
    }

    const dx = playerPos.x - this.position.x
    const dz = playerPos.z - this.position.z
    const dist = Math.hypot(dx, dz)

    this.stateTimer += dt
    this.attackCooldown = Math.max(0, this.attackCooldown - dt)

    let targetSpeed = 0
    let moveYaw = this.yaw

    switch (this.state) {
      case 'graze': {
        // 吃一会儿草，换个地方再吃。没有目的地的动物看起来像在站桩
        if (this.stateTimer > 2.5 + Math.random() * 3) {
          this.stateTimer = 0
          if (Math.random() < 0.55) {
            const a = Math.random() * Math.PI * 2
            const r = 3 + Math.random() * 7
            this.wanderX = this.position.x + Math.cos(a) * r
            this.wanderZ = this.position.z + Math.sin(a) * r
          }
        }
        const wx = this.wanderX - this.position.x
        const wz = this.wanderZ - this.position.z
        if (Math.hypot(wx, wz) > 0.6) {
          moveYaw = Math.atan2(wx, wz)
          targetSpeed = 1.6
        }
        if (dist < this.def.alertRange) {
          this.state = 'alert'
          this.stateTimer = 0
        }
        break
      }

      case 'alert': {
        // 抬头盯着玩家看一会儿。这一下停顿很关键：动物瞬间逃跑
        // 会显得神经质，先警觉再逃才像活物
        moveYaw = Math.atan2(dx, dz)
        if (dist < this.def.fleeRange) {
          this.state = this.def.damage > 0 && this.def.kind === 'wolf' ? 'aggro' : 'flee'
          this.stateTimer = 0
        } else if (dist > this.def.alertRange * 1.4 || this.stateTimer > 2.2) {
          this.state = 'graze'
          this.stateTimer = 0
        }
        break
      }

      case 'flee': {
        moveYaw = Math.atan2(-dx, -dz)
        targetSpeed = this.def.fleeSpeed
        if (dist > 34 || this.stateTimer > FLEE_DURATION) {
          this.state = 'graze'
          this.stateTimer = 0
        }
        break
      }

      case 'aggro': {
        moveYaw = Math.atan2(dx, dz)
        if (dist > 30) {
          // 追出太远就放弃：动物也有领地概念，不会追到天边
          this.state = 'graze'
          this.stateTimer = 0
          break
        }
        if (dist < ATTACK_RANGE && this.attackCooldown <= 0) {
          this.state = 'attack'
          this.attackTimer = 0
          this.attackHitDone = false
          break
        }
        targetSpeed = this.def.aggroSpeed
        break
      }

      case 'attack': {
        moveYaw = Math.atan2(dx, dz)
        this.attackTimer += dt
        // 向前扑的位移：头顶过去要有"撞上"的感觉
        if (this.attackTimer > 0.15 && this.attackTimer < 0.5) {
          targetSpeed = 3.2
        }
        if (!this.attackHitDone && this.attackTimer >= ATTACK_HIT_AT) {
          this.attackHitDone = true
          if (dist < ATTACK_RANGE + 0.6) onAttackPlayer(this.def.damage, this.position)
        }
        if (this.attackTimer >= ATTACK_DURATION) {
          this.state = 'aggro'
          this.attackCooldown = ATTACK_COOLDOWN
        }
        break
      }
    }

    // 移动与转向。转身限速：瞬间掉头是玩具，不是动物
    if (targetSpeed > 0) {
      let dy = moveYaw - this.yaw
      while (dy > Math.PI) dy -= Math.PI * 2
      while (dy < -Math.PI) dy += Math.PI * 2
      this.yaw += dy * Math.min(1, dt * 7)
      this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 5)
      const nx = this.position.x + Math.sin(this.yaw) * this.speed * dt
      const nz = this.position.z + Math.cos(this.yaw) * this.speed * dt
      // 不下水：动物到水边会沿着岸跑
      if (terrain.height(nx, nz) > WATER_LEVEL - 0.2) {
        this.position.x = nx
        this.position.z = nz
      } else {
        // 撞水转向：沿岸边偏转 90°
        this.yaw += Math.PI / 2
      }
      this.position.y = terrain.height(this.position.x, this.position.z)
    } else {
      this.speed *= Math.max(0, 1 - dt * 6)
    }

    this.rig.update(dt, this.speed, this.state)
    this.syncVisual()
  }

  private syncVisual(): void {
    this.group.position.copy(this.position)
    // glTF 动物正面朝 +Z（Quaternius 约定），与 yaw 一致
    this.group.rotation.y = this.yaw
  }

  dispose(): void {
    this.rig.dispose()
  }
}

/** 一个地区最多同时存在的野兽数量。再多性能与"稀有感"都会掉 */
const HERD_SIZES: Partial<Record<AnimalKind, [number, number]>> = {
  deer: [2, 3], // 鹿成群
  rabbit: [1, 2],
  wolf: [1, 2],
  boar: [2, 3], // 野猪也是群居
  fox: [1, 2],
  stag: [1, 2],
}

export class WildlifeManager {
  readonly group = new Group()
  private readonly animals: Animal[] = []

  constructor() {
    this.group.name = 'wildlife'
  }

  get alive(): readonly Animal[] {
    return this.animals
  }

  /**
   * 撒出一片野兽。按种类分簇：每种找一个窝点，在它周围放一小群。
   * 均匀撒的话全图都是稀稀拉拉的一两只，不成生态。
   */
  async populate(
    terrain: Heightfield,
    center: Vector3,
    plan: ReadonlyArray<{ kind: AnimalKind; count: number }>,
  ): Promise<number> {
    let total = 0
    for (const entry of plan) {
      const def = ANIMAL_DEFS[entry.kind]
      let tpl: AnimalTemplate | null = null
      if (def.model) {
        tpl = await loadTemplate(def.model)
        if (!tpl) continue
      }

      // 找一个窝点：草地、不陡、离出生点有点距离（开场不该被狼咬）
      const den = findDen(terrain, center)
      if (!den) continue

      const [minN, maxN] = HERD_SIZES[entry.kind] ?? [1, 1]
      const herd = Math.min(entry.count, minN + Math.floor(Math.random() * (maxN - minN + 1)))
      for (let i = 0; i < herd; i++) {
        const rig =
          def.model === null
            ? new ProceduralAnimalRig(def.kind as 'boar' | 'rabbit')
            : new GltfAnimalRig(tpl!, def.height)
        const animal = new Animal(def, rig)
        const a = Math.random() * Math.PI * 2
        const r = Math.random() * 9
        animal.spawnAt(den.x + Math.cos(a) * r, den.z + Math.sin(a) * r, terrain)
        this.animals.push(animal)
        this.group.add(animal.group)
        total++
      }
    }
    return total
  }

  update(
    dt: number,
    playerPos: Vector3,
    terrain: Heightfield,
    onAttackPlayer: (damage: number, fromPos: Vector3) => void,
  ): void {
    for (const animal of this.animals) {
      // 离玩家太远的动物冻结：看不见的地方不需要生态。
      // 但尸体是例外——腐烂化成肉是后台过程，玩家打完猎跑远再回来，
      // 肉应该已经在那里等着，而不是尸体被冻结在半空
      const d = Math.hypot(animal.position.x - playerPos.x, animal.position.z - playerPos.z)
      if (d > 120) {
        if (animal.state === 'dead') animal.deadFor += dt
        continue
      }
      animal.update(dt, playerPos, terrain, onAttackPlayer)
    }
  }

  /** 捡走尸体：返回掉肉的位置列表，由外部生成拾取物并移除尸体 */
  collectCorpses(): Animal[] {
    const out: Animal[] = []
    for (let i = this.animals.length - 1; i >= 0; i--) {
      const a = this.animals[i]
      if (a.state !== 'dead' || a.deadFor < CORPSE_SECONDS) continue
      out.push(a)
      this.group.remove(a.group)
      a.dispose()
      this.animals.splice(i, 1)
    }
    return out
  }

  get livingCount(): number {
    let n = 0
    for (const a of this.animals) if (!a.health.isDead) n++
    return n
  }
}

/** 找一个野兽窝点：草原带、平缓、离出生点 30m 开外 */
function findDen(terrain: Heightfield, center: Vector3): { x: number; z: number } | null {
  for (let tries = 0; tries < 60; tries++) {
    const a = Math.random() * Math.PI * 2
    const r = 30 + Math.random() * 130
    const x = center.x + Math.cos(a) * r
    const z = center.z + Math.sin(a) * r
    const h = terrain.height(x, z)
    if (h < WATER_LEVEL + 2.5 || h > 48) continue
    if (terrain.slopeAngle(x, z) > 0.5) continue
    return { x, z }
  }
  return null
}

function measureObject(obj: Object3D): { min: Vector3; max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  obj.updateMatrixWorld(true)
  const v = new Vector3()
  obj.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    const geo = mesh.geometry as BufferGeometry
    if (!geo.boundingBox) geo.computeBoundingBox()
    const bb = geo.boundingBox!
    for (const cx of [bb.min.x, bb.max.x])
      for (const cy of [bb.min.y, bb.max.y])
        for (const cz of [bb.min.z, bb.max.z]) {
          v.set(cx, cy, cz).applyMatrix4(mesh.matrixWorld)
          min.min(v)
          max.max(v)
        }
  })
  return { min, max }
}
