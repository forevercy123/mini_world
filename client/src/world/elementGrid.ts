/**
 * 元素格子：火在草地上的燃烧与蔓延。
 *
 * 设计要点：
 *
 * 1. **按固定 tick（4 Hz）推进，不是每帧**。蔓延要为每个燃烧格子查询
 *    邻居，每帧跑一遍在燃烧面积大时会吃掉整个帧预算。4 Hz 的传播在观感上
 *    完全够用（火本来就是慢慢烧的），代价却降到 1/15。
 *
 * 2. **格子是稀疏的**。世界很大，用 Map 只存真正被点燃过的格子，
 *    不预分配整张网格。
 *
 * 3. **可燃性由地形决定**：草地可燃，水面、沙滩、裸岩、雪线以上不可燃。
 *    这让火势自然地被地形约束，玩家能通过"往水边跑"来切断火线——
 *    这是规则驱动玩法的一个小例子。
 *
 * 4. **风向影响蔓延**。顺风的邻居更容易被点燃，火线会拉成椭圆而不是正圆。
 */

import { Vector2 } from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'

/** 格子边长（米）。太小则格子数量爆炸，太大则火线看起来是方块状。 */
export const CELL_SIZE = 4

/** 蔓延推进的间隔（秒），即 4 Hz */
const TICK_INTERVAL = 0.25

/** 每秒烧掉的燃料比例。1.0 燃料约烧 8 秒 */
const BURN_RATE = 0.125

/** 每个燃烧格子每 tick 点燃单个邻居的基础概率 */
const BASE_SPREAD = 0.22

/** 顺风方向的蔓延加成 */
const WIND_BONUS = 1.6

/** 湿度对蔓延的抑制：湿透的格子几乎点不着 */
const WET_SUPPRESSION = 0.85

export interface FireCell {
  /** 格子中心的世界坐标 */
  x: number
  z: number
  /** 剩余燃料 0–1 */
  fuel: number
  /** 已燃烧时长（秒），供渲染做火焰动画 */
  age: number
}

function cellKey(cx: number, cz: number): number {
  // 坐标范围限定在 ±50000 格（±200 公里），足够覆盖任何实际游玩范围
  return (cx + 50000) * 100000 + (cz + 50000)
}

export class ElementGrid {
  private readonly burning = new Map<number, FireCell>()
  private readonly scorched = new Set<number>()
  private readonly wet = new Map<number, number>()
  /** 已冻结的格子（水面变成可站立的冰面） */
  private readonly ice = new Set<number>()

  private tickAccum = 0
  private readonly rng: () => number

  /** 统计：累计烧过的格子数，供调试与验证脚本读取 */
  totalIgnited = 0

  constructor(seed = 20260930) {
    this.rng = mulberry32(seed)
  }

  /** 当前正在燃烧的格子，供渲染层使用 */
  get cells(): IterableIterator<FireCell> {
    return this.burning.values()
  }

  get burningCount(): number {
    return this.burning.size
  }

  /**
   * 点燃世界坐标处的格子。
   * @returns 是否真的点着了（不可燃、已烧过、已湿透都会失败）
   */
  ignite(x: number, z: number, terrain: Heightfield): boolean {
    const cx = Math.floor(x / CELL_SIZE)
    const cz = Math.floor(z / CELL_SIZE)
    const key = cellKey(cx, cz)

    if (this.burning.has(key)) return false
    if (this.scorched.has(key)) return false
    if (!this.isFlammable(x, z, terrain)) return false

    const wetness = this.wet.get(key) ?? 0
    if (wetness > 0.6) return false
    // 湿度是概率性抑制，不是硬性阻挡——湿草地也能烧，只是很难
    if (this.rng() < wetness * WET_SUPPRESSION) return false

    this.burning.set(key, {
      x: (cx + 0.5) * CELL_SIZE,
      z: (cz + 0.5) * CELL_SIZE,
      fuel: 1,
      age: 0,
    })
    this.totalIgnited++
    return true
  }

  /** 浇灭某点附近的火并打湿地面 */
  douse(x: number, z: number, radius = 6): number {
    const cx = Math.floor(x / CELL_SIZE)
    const cz = Math.floor(z / CELL_SIZE)
    const r = Math.ceil(radius / CELL_SIZE)
    let putOut = 0

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const key = cellKey(cx + dx, cz + dz)
        if (this.burning.delete(key)) putOut++
        this.wet.set(key, 1)
      }
    }
    return putOut
  }

  /**
   * 草地才可燃。水面附近、沙滩、裸岩、雪线以上都点不着，
   * 火势因此会被地形自然切断。
   */
  isFlammable(x: number, z: number, terrain: Heightfield): boolean {
    const h = terrain.height(x, z)
    const rel = h - WATER_LEVEL
    // 水面与湿沙滩
    if (rel < 4) return false
    // 高海拔的裸岩与雪
    if (rel > 42) return false
    // 陡坡露岩，无草可烧
    if (terrain.slopeAngle(x, z) > 0.72) return false
    return true
  }

  isBurning(x: number, z: number): boolean {
    const key = cellKey(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE))
    return this.burning.has(key)
  }

  /**
   * 某点受到的上升气流强度 0–1。
   *
   * 这是元素引擎与滑翔系统的接点：火堆上方有上升气流，展开滑翔伞
   * 就能借势爬升——"点火 → 气流 → 飞得更高"是规划里写明要成立的组合。
   */
  updraftAt(x: number, z: number): number {
    const cx = Math.floor(x / CELL_SIZE)
    const cz = Math.floor(z / CELL_SIZE)
    let strength = 0

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.burning.has(cellKey(cx + dx, cz + dz))) continue
        const d = Math.hypot(dx, dz)
        strength += Math.max(0, 1 - d / 2)
      }
    }
    return Math.min(1, strength / 3)
  }

  /** 按 tick 推进燃烧与蔓延 */
  update(dt: number, terrain: Heightfield, windDir: Vector2 | null): void {
    // 燃烧动画的 age 每帧推进，蔓延判定才走 tick
    for (const cell of this.burning.values()) cell.age += dt

    this.tickAccum += dt
    if (this.tickAccum < TICK_INTERVAL) return
    const step = this.tickAccum
    this.tickAccum = 0

    // ── 1. 烧掉燃料，烧尽后变成焦土 ──
    for (const [key, cell] of this.burning) {
      cell.fuel -= BURN_RATE * step
      if (cell.fuel <= 0) {
        this.burning.delete(key)
        this.scorched.add(key)
      }
    }

    // ── 2. 蔓延到邻居 ──
    // 先收集再统一点燃：直接在被遍历的 Map 上增删会破坏迭代
    const spread: Array<{ x: number; z: number; chance: number }> = []
    for (const cell of this.burning.values()) {
      for (const [dx, dz] of NEIGHBORS) {
        const nx = cell.x + dx * CELL_SIZE
        const nz = cell.z + dz * CELL_SIZE
        if (!this.isFlammable(nx, nz, terrain)) continue

        // 顺风加权：风向与蔓延方向对齐时概率更高，火线拉成椭圆
        let chance = BASE_SPREAD
        if (windDir) {
          const len = Math.hypot(dx, dz)
          const align = (dx * windDir.x + dz * windDir.y) / len
          chance *= 1 + align * WIND_BONUS
        }
        spread.push({ x: nx, z: nz, chance })
      }
    }

    for (const s of spread) {
      // 概率按 tick 步长缩放，保证火势速度与帧率、tick 频率无关
      if (this.rng() < s.chance * step) {
        this.ignite(s.x, s.z, terrain)
      }
    }

    // ── 3. 火烤化邻近的冰。这是元素之间的第一条克制关系：
    //     冰能搭桥过河，火能把桥拆掉。 ──
    if (this.ice.size > 0 && this.burning.size > 0) {
      const melting: number[] = []
      for (const key of this.ice) {
        const world = ElementGrid.keyToWorld(key)
        const cx = Math.floor(world.x / CELL_SIZE)
        const cz = Math.floor(world.z / CELL_SIZE)
        for (const [dx, dz] of NEIGHBORS) {
          if (this.burning.has(cellKey(cx + dx, cz + dz))) {
            melting.push(key)
            break
          }
        }
      }
      for (const key of melting) this.ice.delete(key)
    }
  }

  // ─────────────────────────── 冰 ───────────────────────────

  /**
   * 冻结水面。只在"地形低于水位"的格子上生效——陆地上没有水可冻。
   *
   * 火场附近的格子冻不上：正在燃烧或刚烧过的地面不会结冰。
   * 这条规则让"先放火再冻水"成为无效操作，也算一种元素克制。
   */
  freeze(x: number, z: number, terrain: Heightfield, radius = 7): number {
    const cx = Math.floor(x / CELL_SIZE)
    const cz = Math.floor(z / CELL_SIZE)
    const r = Math.ceil(radius / CELL_SIZE)
    let frozen = 0

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx
        const gz = cz + dz
        const wx = (gx + 0.5) * CELL_SIZE
        const wz = (gz + 0.5) * CELL_SIZE
        if (Math.hypot(wx - x, wz - z) > radius) continue

        // 必须有水可冻
        if (terrain.height(wx, wz) > WATER_LEVEL - 0.4) continue

        const key = cellKey(gx, gz)
        if (this.ice.has(key)) continue
        if (this.burning.has(key)) continue

        this.ice.add(key)
        frozen++
      }
    }
    return frozen
  }

  /** 融化冰面。火焰烘烤、或玩家主动破冰时调用。 */
  melt(x: number, z: number, radius = 7): number {
    const cx = Math.floor(x / CELL_SIZE)
    const cz = Math.floor(z / CELL_SIZE)
    const r = Math.ceil(radius / CELL_SIZE)
    let melted = 0

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx
        const gz = cz + dz
        const wx = (gx + 0.5) * CELL_SIZE
        const wz = (gz + 0.5) * CELL_SIZE
        if (Math.hypot(wx - x, wz - z) > radius) continue
        if (this.ice.delete(cellKey(gx, gz))) melted++
      }
    }
    return melted
  }

  /**
   * 该点的冰面高度。没有冰时返回 null。
   * 角色控制器用它判断"脚下是不是多了一层可以站的表面"。
   */
  iceHeightAt(x: number, z: number): number | null {
    const key = cellKey(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE))
    return this.ice.has(key) ? WATER_LEVEL : null
  }

  get iceCount(): number {
    return this.ice.size
  }

  get iceCells(): IterableIterator<number> {
    return this.ice.values()
  }

  /** 把格子 key 还原成世界坐标（渲染层需要知道冰面画在哪） */
  static keyToWorld(key: number): { x: number; z: number } {
    const cz = (key % 100000) - 50000
    const cx = Math.floor(key / 100000) - 50000
    return { x: (cx + 0.5) * CELL_SIZE, z: (cz + 0.5) * CELL_SIZE }
  }

  /** 打湿一片区域（下雨、水边）。湿度会随时间自然衰减。 */
  wetArea(x: number, z: number, radius: number): void {
    const cx = Math.floor(x / CELL_SIZE)
    const cz = Math.floor(z / CELL_SIZE)
    const r = Math.ceil(radius / CELL_SIZE)
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        this.wet.set(cellKey(cx + dx, cz + dz), 1)
      }
    }
  }

  reset(): void {
    this.burning.clear()
    this.scorched.clear()
    this.wet.clear()
    this.ice.clear()
    this.totalIgnited = 0
  }
}

/** 八个邻居方向（含斜向），火线因此不会只沿轴向呈十字扩散 */
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/** 确定性伪随机：让火势可复现，验证脚本的断言才稳定 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
