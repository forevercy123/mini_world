/**
 * 武器系统。
 *
 * 塞尔达式武器循环的三根支柱：**捡、换、碎**。
 *
 * - 捡：武器散在地图各处（插在地上发光）、宝箱里、强敌掉落。
 *   玩家永远处于"手上的快碎了，下一把在哪"的轻度紧迫感里——
 *   这是驱动探索的心理钩子。
 * - 换：不同武器有不同的伤害/速度/范围权衡，数字键即时切换。
 *   匕首快而轻、双手斧慢而重，换武器就是换打法。
 * - 碎：耐久归零武器当场碎裂。武器因此是消耗品而不是收集品，
 *   玩家舍得用，也始终有理由捡下一把。
 *
 * 数据驱动的设计：所有武器都在 WEAPON_DEFS 一张表里，
 * 战斗、动画、UI、存档从同一份定义读，加武器只改这张表。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Mesh,
  MeshLambertMaterial,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export type WeaponId =
  | 'branch'
  | 'dagger'
  | 'sword1h'
  | 'axe1h'
  | 'sword2h'
  | 'axe2h'
  | 'crossbow'

/**
 * 招式组：决定用哪一套挥砍动画。
 *
 * 武器的外观和动画必须一致——单手剑配双手劈砍会看着像角色
 * 在和一把看不见的剑搏斗。stab 单独一组是因为突刺的预备姿势
 * 和挥砍完全不同。
 */
export type Moveset = '1h' | '2h' | 'stab' | 'shoot'

export interface WeaponDef {
  id: WeaponId
  name: string
  /** 模型文件。null 表示程序化生成（树枝不需要下载一个模型文件） */
  model: string | null
  moveset: Moveset
  damage: number
  /** 耐久：命中多少次后碎裂。不命中不耗——挥空不该惩罚玩家 */
  durability: number
  /** 一次出招的时长（秒）。重的武器慢，这是它们的代价 */
  duration: number
  /** 攻击距离（米）。长柄/双手武器够得远一点 */
  range: number
  knockback: number
  /** 稀有度决定拾取光柱的颜色，让玩家老远就能认出"那是好东西" */
  rarity: 'common' | 'rare' | 'epic'
  /** 一句话说明 */
  desc: string
}

export const WEAPON_DEFS: Record<WeaponId, WeaponDef> = {
  branch: {
    id: 'branch',
    name: '树枝',
    model: null,
    moveset: '1h',
    damage: 1,
    durability: 10,
    duration: 0.5,
    range: 2.2,
    knockback: 8,
    rarity: 'common',
    desc: '随手捡的树枝。聊胜于无，别指望它撑太久',
  },
  dagger: {
    id: 'dagger',
    name: '盗贼匕首',
    model: '/assets/weapons/dagger.gltf',
    moveset: 'stab',
    damage: 1,
    durability: 26,
    duration: 0.38,
    range: 2.0,
    knockback: 5,
    rarity: 'common',
    desc: '轻快的小刀。伤害不高，但出手快得让敌人还不了手',
  },
  sword1h: {
    id: 'sword1h',
    name: '旅人之剑',
    model: '/assets/weapons/sword_1handed.gltf',
    moveset: '1h',
    damage: 2,
    durability: 18,
    duration: 0.58,
    range: 2.6,
    knockback: 10,
    rarity: 'rare',
    desc: '旅人常用的单手剑，攻守均衡',
  },
  axe1h: {
    id: 'axe1h',
    name: '樵夫手斧',
    model: '/assets/weapons/axe_1handed.gltf',
    moveset: '1h',
    damage: 3,
    durability: 14,
    duration: 0.72,
    range: 2.4,
    knockback: 13,
    rarity: 'rare',
    desc: '劈柴的家伙什，劈骷髅一样好使',
  },
  sword2h: {
    id: 'sword2h',
    name: '骑士大剑',
    model: '/assets/weapons/sword_2handed.gltf',
    moveset: '2h',
    damage: 4,
    durability: 15,
    duration: 0.85,
    range: 3.0,
    knockback: 15,
    rarity: 'epic',
    desc: '要双手才抡得动的大剑，一剑下去地都在震',
  },
  axe2h: {
    id: 'axe2h',
    name: '狂战斧',
    model: '/assets/weapons/axe_2handed.gltf',
    moveset: '2h',
    damage: 5,
    durability: 12,
    duration: 0.95,
    range: 2.9,
    knockback: 18,
    rarity: 'epic',
    desc: '战场上的凶器。慢，但挨一下就是重伤',
  },
  crossbow: {
    id: 'crossbow',
    name: '猎手弩',
    model: '/assets/weapons/crossbow_1handed.gltf',
    moveset: 'shoot',
    damage: 2,
    durability: 24,
    duration: 0.62,
    range: 26,
    knockback: 6,
    rarity: 'rare',
    desc: '猎人的伙伴。远处的猎物与敌人都逃不过一箭',
  },
}

/** 空手格斗的参数。武器全碎时的兜底，永远可用 */
export const UNARMED = {
  name: '空手',
  moveset: 'unarmed' as const,
  damage: 1,
  duration: 0.42,
  range: 1.8,
  knockback: 6,
}

export interface WeaponSlot {
  id: WeaponId
  /** 剩余耐久 */
  durability: number
}

/** 身上最多带几把武器。格子有限，捡新武器才有"要不要扔"的抉择 */
export const WEAPON_SLOTS_MAX = 4

/**
 * 武器袋。
 *
 * 手上当前一把 + 备用若干。耐久跟着武器走（不是跟着格子），
 * 扔掉再捡回来的是另一把——所以存档里存的是每把武器自己的耐久。
 */
export class WeaponBag {
  private readonly slots: WeaponSlot[] = []
  private currentIndex = 0
  /** 箭矢弹药池：全部远程武器共用一个弹药数，和塞尔达的箭一样 */
  arrows = 0
  /** 每次变动自增，供 UI 判断是否需要重绘 */
  version = 0

  constructor() {
    // 开局一根树枝：塞尔达的第一件武器从来不是剑
    this.slots.push({ id: 'branch', durability: WEAPON_DEFS.branch.durability })
  }

  get current(): WeaponSlot | null {
    return this.slots[this.currentIndex] ?? null
  }

  get currentDef(): WeaponDef | null {
    const slot = this.current
    return slot ? WEAPON_DEFS[slot.id] : null
  }

  get all(): readonly WeaponSlot[] {
    return this.slots
  }

  get index(): number {
    return this.currentIndex
  }

  /** 捡到一把武器。袋满了就替换当前手上那把（旧的被丢在原地的概念） */
  add(id: WeaponId): { replaced: WeaponSlot | null } {
    const def = WEAPON_DEFS[id]
    let replaced: WeaponSlot | null = null
    if (this.slots.length >= WEAPON_SLOTS_MAX) {
      replaced = this.slots[this.currentIndex]
      this.slots[this.currentIndex] = { id, durability: def.durability }
    } else {
      this.slots.push({ id, durability: def.durability })
      // 自动切到新武器：刚捡到的东西玩家想立刻试试
      this.currentIndex = this.slots.length - 1
    }
    this.version++
    return { replaced }
  }

  /** 切到指定格子。越界或已在手上时返回 false */
  switchTo(index: number): boolean {
    if (index < 0 || index >= this.slots.length || index === this.currentIndex) return false
    this.currentIndex = index
    this.version++
    return true
  }

  /** 切换到下一把（循环） */
  cycle(): boolean {
    if (this.slots.length < 2) return false
    return this.switchTo((this.currentIndex + 1) % this.slots.length)
  }

  /**
   * 命中一次，消耗当前武器 1 点耐久。
   * 返回 'broken' 表示武器碎裂（调用方播碎裂特效并切走）。
   */
  consumeDurability(): 'ok' | 'broken' {
    const slot = this.current
    if (!slot) return 'ok'
    slot.durability--
    this.version++
    if (slot.durability > 0) return 'ok'
    // 碎掉的那把从袋里移除
    this.slots.splice(this.currentIndex, 1)
    if (this.currentIndex >= this.slots.length) this.currentIndex = 0
    this.version++
    return 'broken'
  }

  toSave(): { slots: WeaponSlot[]; current: number; arrows: number } {
    return {
      slots: this.slots.map((s) => ({ ...s })),
      current: this.currentIndex,
      arrows: this.arrows,
    }
  }

  restore(data: { slots?: WeaponSlot[]; current?: number; arrows?: number } | undefined): void {
    this.slots.length = 0
    if (data?.slots) {
      for (const s of data.slots) {
        if (!WEAPON_DEFS[s.id]) continue
        this.slots.push({ id: s.id, durability: Math.max(1, Math.floor(s.durability)) })
      }
    }
    if (this.slots.length === 0) {
      // 存档里没有武器数据（旧档）：给根树枝，不至于赤手空拳
      this.slots.push({ id: 'branch', durability: WEAPON_DEFS.branch.durability })
    }
    this.currentIndex = Math.min(data?.current ?? 0, this.slots.length - 1)
    this.arrows = Math.max(0, Math.floor(data?.arrows ?? 0))
    this.version++
  }
}

/**
 * 程序化树枝模型。
 *
 * 一段略有弯曲的粗木棍——用两段圆柱拼出折角，比直愣愣的一根
 * 更像从树上掰下来的。原点在握把处，和 KayKit 武器的约定一致，
 * 这样挂到手上时所有武器的朝向逻辑是同一套。
 */
export function createBranchMesh(): Mesh {
  const parts: BufferGeometry[] = []

  const lower = new CylinderGeometry(0.022, 0.032, 0.42, 5)
  lower.translate(0, 0.21, 0)
  paintGeometry(lower, 0x6d5137)
  parts.push(lower)

  const upper = new CylinderGeometry(0.014, 0.022, 0.34, 5)
  upper.translate(0, 0.17, 0)
  upper.rotateX(0.28)
  upper.translate(0, 0.42, 0)
  paintGeometry(upper, 0x7d5f42)
  parts.push(upper)

  // 末端一截分叉的小枝
  const twig = new CylinderGeometry(0.006, 0.011, 0.16, 4)
  twig.translate(0, 0.08, 0)
  twig.rotateZ(0.7)
  twig.translate(0, 0.55, 0.09)
  paintGeometry(twig, 0x6d5137)
  parts.push(twig)

  const merged = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  const mesh = new Mesh(merged, branchMaterial())
  mesh.castShadow = true
  return mesh
}

let cachedBranchMaterial: MeshLambertMaterial | null = null
function branchMaterial(): MeshLambertMaterial {
  if (!cachedBranchMaterial) {
    cachedBranchMaterial = new MeshLambertMaterial({ vertexColors: true })
  }
  return cachedBranchMaterial
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

/** 稀有度对应的光柱颜色（HDR 值，bloom 下会发光） */
export const RARITY_GLOW: Record<WeaponDef['rarity'], Color> = {
  common: new Color(0.9, 1.0, 0.9),
  rare: new Color(0.5, 1.6, 2.6),
  epic: new Color(2.4, 1.5, 0.6),
}
