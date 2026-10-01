/**
 * 背包与地上的可拾取物。
 *
 * 物品定义用一张表（ItemDef）驱动，渲染、拾取、使用都从同一份定义读——
 * 加一种新物品只需要往表里加一行，不需要改三处逻辑。
 *
 * 拾取物用 InstancedMesh 渲染：地上可能同时有几十个果子，逐个建 Mesh
 * 会产生同样数量的 draw call，而它们其实是完全相同的几何体。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { Heightfield } from '../terrain/heightfield.ts'

export type ItemId =
  | 'berry'
  | 'sunfruit'
  | 'bone'
  | 'mushroom'
  | 'apple'
  | 'raw_meat'
  | 'roast_meat'
  | 'dish_skewer'
  | 'dish_meat_mushroom'
  | 'dish_fruit'
  | 'dish_sunny'
  | 'dish_mushroom'
  | 'dish_mixed'

export interface ItemDef {
  id: ItemId
  name: string
  /** 果实颜色 */
  color: number
  /** 食用后恢复的生命值 */
  heal: number
  /** 一句话说明，显示在背包里 */
  desc: string
  /** 能下锅的食材标记 */
  cookable?: boolean
  /** 料理标记：回血之外还可能带增益 */
  dish?: boolean
  /** 拾取物外形：果实带梗叶，肉是肉块 */
  shape?: 'fruit' | 'meat'
}

export const ITEM_DEFS: Record<ItemId, ItemDef> = {
  berry: {
    id: 'berry',
    name: '野莓',
    color: 0xd94a5a,
    heal: 1,
    cookable: true,
    desc: '随处可见的红色浆果，能恢复一点体力（1 颗心）',
  },
  sunfruit: {
    id: 'sunfruit',
    name: '向阳果',
    color: 0xe8a23c,
    heal: 2,
    cookable: true,
    desc: '长在向阳坡上的金色果实，恢复更多生命（2 颗心）',
  },
  bone: {
    id: 'bone',
    name: '骷髅骨',
    color: 0xe6dfcc,
    heal: 0,
    desc: '暗蚀爪牙的残骸。啃不动，但总有人愿意拿东西换',
  },
  mushroom: {
    id: 'mushroom',
    name: '野蘑菇',
    color: 0xb5654a,
    heal: 1,
    cookable: true,
    // 能吃，但主要用途是任务物品——这样玩家捡到它时不会直接吃掉
    desc: '林间的野蘑菇。生吃顶一顿，下锅更香，贤者还说它能熬药',
  },
  apple: {
    id: 'apple',
    name: '苹果',
    color: 0xe0483c,
    heal: 1,
    cookable: true,
    desc: '树上掉下来的苹果，又脆又甜（1 颗心）',
  },
  raw_meat: {
    id: 'raw_meat',
    name: '生肉',
    color: 0xc25a6a,
    heal: 1,
    cookable: true,
    shape: 'meat',
    desc: '猎来的兽肉。生吃勉强果腹，烤熟了才是正经食物',
  },
  roast_meat: {
    id: 'roast_meat',
    name: '烤肉',
    color: 0x8a5230,
    heal: 3,
    dish: true,
    shape: 'meat',
    desc: '篝火烤熟的肉，油汪汪的（3 颗心）',
  },
  dish_skewer: {
    id: 'dish_skewer',
    name: '烤肉串',
    color: 0x9a6238,
    heal: 4,
    dish: true,
    shape: 'meat',
    desc: '肉块串在签子上烤到冒油（4 颗心）',
  },
  dish_meat_mushroom: {
    id: 'dish_meat_mushroom',
    name: '鲜肉蘑菇串',
    color: 0xa06a44,
    heal: 5,
    dish: true,
    shape: 'meat',
    desc: '肉和蘑菇交替串起来，鲜味翻倍（5 颗心）',
  },
  dish_fruit: {
    id: 'dish_fruit',
    name: '水果拼盘',
    color: 0xe86a7a,
    heal: 3,
    dish: true,
    desc: '苹果和野莓切成果盘，清爽解腻（3 颗心）',
  },
  dish_sunny: {
    id: 'dish_sunny',
    name: '阳光炖菜',
    color: 0xf2c53d,
    heal: 99,
    dish: true,
    desc: '向阳果的精华炖进汤里，一口下去浑身是劲（完全恢复）',
  },
  dish_mushroom: {
    id: 'dish_mushroom',
    name: '烤蘑菇串',
    color: 0xb5854a,
    heal: 3,
    dish: true,
    desc: '蘑菇烤到微焦，山林的味道（3 颗心）',
  },
  dish_mixed: {
    id: 'dish_mixed',
    name: '大杂烩',
    color: 0x9a8a5a,
    heal: 4,
    dish: true,
    desc: '什么都往锅里扔的结果。能吃，而且意外得不错（4 颗心）',
  },
}

const MAX_PICKUPS = 96
/** 走到多近算自动拾取 */
const PICKUP_RADIUS = 1.6

export class Inventory {
  /** 导出为纯数据，供存档用 */
  toSave(): Partial<Record<ItemId, number>> {
    const out: Partial<Record<ItemId, number>> = {}
    for (const [id, n] of this.counts) {
      if (n > 0) out[id] = n
    }
    return out
  }

  /** 从存档恢复。先清空，避免残留上一次的进度 */
  restore(data: Partial<Record<ItemId, number>>): void {
    this.counts.clear()
    for (const [id, n] of Object.entries(data)) {
      if (typeof n === 'number' && n > 0) this.counts.set(id as ItemId, Math.floor(n))
    }
  }

  private readonly counts = new Map<ItemId, number>()
  /** 每次变动自增，供 UI 判断是否需要重绘 */
  version = 0

  add(id: ItemId, amount = 1): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + amount)
    this.version++
  }

  remove(id: ItemId, amount = 1): boolean {
    const have = this.counts.get(id) ?? 0
    if (have < amount) return false
    const left = have - amount
    if (left <= 0) this.counts.delete(id)
    else this.counts.set(id, left)
    this.version++
    return true
  }

  count(id: ItemId): number {
    return this.counts.get(id) ?? 0
  }

  get totalCount(): number {
    let n = 0
    for (const c of this.counts.values()) n += c
    return n
  }

  /** 按定义表的顺序返回持有物品，UI 的排列顺序因此是稳定的 */
  list(): Array<{ def: ItemDef; count: number }> {
    const out: Array<{ def: ItemDef; count: number }> = []
    for (const def of Object.values(ITEM_DEFS)) {
      const count = this.count(def.id)
      if (count > 0) out.push({ def, count })
    }
    return out
  }

  clear(): void {
    this.counts.clear()
    this.version++
  }
}

interface Pickup {
  id: ItemId
  position: Vector3
  /** 用于上下浮动动画的相位偏移，让果子不同步晃动 */
  phase: number
  collected: boolean
}

export class PickupManager {
  readonly group = new Group()

  /** 果形拾取物（果子/蘑菇/苹果）与肉形拾取物分开实例化：外形不同 */
  private readonly fruitMesh: InstancedMesh
  private readonly meatMesh: InstancedMesh
  private readonly material: MeshLambertMaterial
  private readonly fruitGeometry: BufferGeometry
  private readonly meatGeometry: BufferGeometry
  private readonly pickups: Pickup[] = []
  private elapsed = 0

  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly quaternion = new Quaternion()
  private readonly scale = new Vector3()
  private readonly color = new Color()

  constructor() {
    // 果实用白色，实际颜色交给 instanceColor；叶子是深绿，被实例色乘过
    // 之后会偏暗——正好和鲜亮的果实拉开对比，不必为它单独开一套材质
    this.fruitGeometry = createFruitGeometry(0xffffff, 0.22)
    this.meatGeometry = createMeatGeometry()
    this.material = new MeshLambertMaterial({ vertexColors: true, flatShading: true })
    // 果实自发光，草丛里也能一眼看到
    this.material.emissive = new Color(0xffffff).multiplyScalar(0.16)

    this.fruitMesh = new InstancedMesh(this.fruitGeometry, this.material, MAX_PICKUPS)
    this.fruitMesh.frustumCulled = false
    this.fruitMesh.castShadow = true
    this.meatMesh = new InstancedMesh(this.meatGeometry, this.material, MAX_PICKUPS)
    this.meatMesh.frustumCulled = false
    this.meatMesh.castShadow = true
    this.group.add(this.fruitMesh)
    this.group.add(this.meatMesh)
    this.group.name = 'pickups'
  }

  get remaining(): number {
    let n = 0
    for (const p of this.pickups) if (!p.collected) n++
    return n
  }

  /** 最近一个未拾取果子的世界坐标。供调试与验证脚本定位用。 */
  firstPickupPosition(): Vector3 | null {
    for (const p of this.pickups) {
      if (!p.collected) return p.position
    }
    return null
  }

  /**
   * 撒一批果子。
   * @param isSpawnable 由调用方决定哪里能放（避开水面、陡坡）
   */
  /**
   * 在指定位置放一个拾取物（敌人掉落用）。
   * 背包满了就丢弃——掉落不该因为场上果子太多而卡住
   */
  spawnAt(x: number, y: number, z: number, id: ItemId): boolean {
    if (this.pickups.length >= MAX_PICKUPS) return false
    this.pickups.push({
      id,
      position: new Vector3(x, y + 0.3, z),
      phase: Math.random() * Math.PI * 2,
      collected: false,
    })
    return true
  }

  scatter(
    terrain: Heightfield,
    count: number,
    center: Vector3,
    radius: number,
    isSpawnable: (x: number, z: number) => boolean,
    rng: () => number = Math.random,
  ): number {
    let placed = 0
    let attempts = 0
    const maxAttempts = count * 40

    while (placed < count && attempts < maxAttempts && this.pickups.length < MAX_PICKUPS) {
      attempts++
      const angle = rng() * Math.PI * 2
      const r = 8 + rng() * radius
      const x = center.x + Math.cos(angle) * r
      const z = center.z + Math.sin(angle) * r
      if (!isSpawnable(x, z)) continue

      // 按稀缺度分配：向阳果最少、蘑菇次之、野莓最常见，苹果介于
      // 野莓和蘑菇之间。蘑菇要够玩家完成贤者的支线，所以比向阳果多不少
      const roll = rng()
      const id: ItemId =
        roll < 0.15
          ? 'sunfruit'
          : roll < 0.5
            ? 'mushroom'
            : roll < 0.68
              ? 'apple'
              : 'berry'
      this.pickups.push({
        id,
        // 几何的原点现在在果实底部，抬高一点让它悬在草叶上方
        position: new Vector3(x, terrain.height(x, z) + 0.25, z),
        phase: rng() * Math.PI * 2,
        collected: false,
      })
      placed++
    }
    return placed
  }

  /**
   * @param onCollect 拾取到物品时的回调，由外部决定放进哪个背包
   */
  update(
    dt: number,
    playerPos: Vector3,
    terrain: Heightfield,
    onCollect: (id: ItemId) => void,
  ): void {
    this.elapsed += dt

    let fruitWrite = 0
    let meatWrite = 0
    for (const p of this.pickups) {
      if (p.collected) continue

      // 贴合地面：果子可能落在坡上
      const groundY = terrain.height(p.position.x, p.position.z) + 0.25

      // 上下浮动 + 自转，静止的球在草丛里不容易被注意到
      const bob = Math.sin(this.elapsed * 1.8 + p.phase) * 0.12

      const dx = p.position.x - playerPos.x
      const dz = p.position.z - playerPos.z
      const dy = p.position.y - playerPos.y
      // 只在水平距离够近、且高度差不大时拾取，
      // 否则站在悬崖正上方也会把下面的果子吸走
      if (Math.hypot(dx, dz) < PICKUP_RADIUS && Math.abs(dy) < 2.4) {
        p.collected = true
        onCollect(p.id)
        continue
      }

      const def = ITEM_DEFS[p.id]
      const mesh = def.shape === 'meat' ? this.meatMesh : this.fruitMesh

      this.position.set(p.position.x, groundY + bob, p.position.z)
      this.quaternion.setFromAxisAngle(UP, this.elapsed * 1.1 + p.phase)
      const pulse = 1 + Math.sin(this.elapsed * 3 + p.phase) * 0.07
      this.scale.setScalar(pulse)
      this.matrix.compose(this.position, this.quaternion, this.scale)

      if (def.shape === 'meat') {
        mesh.setMatrixAt(meatWrite, this.matrix)
        this.color.setHex(def.color)
        mesh.setColorAt(meatWrite, this.color)
        meatWrite++
      } else {
        mesh.setMatrixAt(fruitWrite, this.matrix)
        this.color.setHex(def.color)
        mesh.setColorAt(fruitWrite, this.color)
        fruitWrite++
      }
    }

    this.fruitMesh.count = fruitWrite
    this.fruitMesh.instanceMatrix.needsUpdate = true
    if (this.fruitMesh.instanceColor) this.fruitMesh.instanceColor.needsUpdate = true
    this.meatMesh.count = meatWrite
    this.meatMesh.instanceMatrix.needsUpdate = true
    if (this.meatMesh.instanceColor) this.meatMesh.instanceColor.needsUpdate = true

    // 清掉已拾取的，避免数组无限增长
    if (this.pickups.some((p) => p.collected)) {
      for (let i = this.pickups.length - 1; i >= 0; i--) {
        if (this.pickups[i].collected) this.pickups.splice(i, 1)
      }
    }
  }

  dispose(): void {
    this.fruitGeometry.dispose()
    this.meatGeometry.dispose()
    this.material.dispose()
    this.fruitMesh.dispose()
    this.meatMesh.dispose()
  }
}

const UP = new Vector3(0, 1, 0)

/**
 * 果实几何：略扁的果身 + 果梗 + 一片叶子。
 *
 * 全是纯球的话看起来像地上散落的塑料珠子；加上梗和叶之后，剪影上
 * 立刻能认出是"果实"。叶子用深绿顶点色，果实部分留白由实例色染色。
 */
function createFruitGeometry(bodyColor: number, bodyRadius: number): BufferGeometry {
  const parts: BufferGeometry[] = []

  const body = new SphereGeometry(bodyRadius, 9, 7)
  body.scale(1, 0.92, 1)
  body.translate(0, bodyRadius * 0.92, 0)
  paintGeometry(body, bodyColor)
  parts.push(body)

  const stem = new CylinderGeometry(0.02, 0.028, 0.13, 4)
  stem.translate(0, bodyRadius * 1.7, 0)
  paintGeometry(stem, 0x5c4326)
  parts.push(stem)

  const leaf = new SphereGeometry(bodyRadius * 0.42, 6, 4)
  leaf.scale(1.7, 0.22, 0.85)
  leaf.rotateZ(0.35)
  leaf.translate(bodyRadius * 0.55, bodyRadius * 1.78, 0)
  paintGeometry(leaf, 0x4f8f32)
  parts.push(leaf)

  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  return merged!
}

/**
 * 肉块几何：椭圆的肉身 + 穿过的一根骨头。
 * 骨头是乳白色的固定色，肉身留白由实例色染色——
 * 生肉偏红、烤肉偏棕，同一副骨架。
 */
function createMeatGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []

  const flesh = new SphereGeometry(0.2, 9, 7)
  flesh.scale(1.35, 0.8, 1)
  flesh.translate(0, 0.16, 0)
  paintGeometry(flesh, 0xffffff)
  parts.push(flesh)

  const bone = new CylinderGeometry(0.028, 0.028, 0.34, 5)
  bone.rotateZ(Math.PI / 2)
  bone.rotateY(0.4)
  bone.translate(0, 0.16, 0)
  paintGeometry(bone, 0xefe8d8)
  parts.push(bone)

  // 骨头两端的小球（关节头）
  for (const end of [-0.17, 0.17]) {
    const knob = new SphereGeometry(0.045, 5, 4)
    knob.translate(end * Math.cos(0.4), 0.16, -end * Math.sin(0.4))
    paintGeometry(knob, 0xefe8d8)
    parts.push(knob)
  }

  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  return merged!
}

function paintGeometry(geometry: BufferGeometry, color: number): void {
  const c = new Color(color)
  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
}
