/**
 * 障碍物的空间索引与碰撞推出。
 *
 * 树干、石头这类物体在水平面上都是圆柱，所以碰撞检测可以简化成
 * 「圆与圆的重叠」，不需要完整的物理引擎。
 *
 * 用均匀网格索引而不是遍历全部障碍物：树有一千多棵，角色每帧都查一遍
 * 是一千多次距离计算；分格之后只需检查周围 3×3 格，通常不到十个。
 */

export interface Obstacle {
  x: number
  z: number
  radius: number
  /**
   * 可以站上去的顶面世界高度。没有这一项表示纯粹是墙，
   * 只能绕着走（树干就是这样）。
   */
  topY?: number
  /**
   * 可以攀爬。树干、石头都标这一项——对着它一直走会开始往上爬，
   * 这是塞尔达式的垂直移动：地图上的每根柱子都是潜在的路。
   */
  climbable?: boolean
  /**
   * 攀爬的高度上限（米，相对地面）。
   * 有 topY 的（石头）爬到顶就能站上去；没有的（树）爬到这儿就停住。
   */
  climbHeight?: number
}

export class ObstacleGrid {
  private readonly cellSize: number
  private readonly cells = new Map<number, Obstacle[]>()
  private total = 0

  constructor(cellSize = 8) {
    this.cellSize = cellSize
  }

  get count(): number {
    return this.total
  }

  /**
   * @param topY 可站立的顶面高度。传了就说明这块石头/树桩能踩上去，
   *   不传则是纯墙（树干、石柱）
   */
  insert(
    x: number,
    z: number,
    radius: number,
    topY?: number,
    climbable?: boolean,
    climbHeight?: number,
  ): void {
    const key = this.keyFor(x, z)
    let list = this.cells.get(key)
    if (!list) {
      list = []
      this.cells.set(key, list)
    }
    list.push({ x, z, radius, topY, climbable, climbHeight })
    this.total++
  }

  /**
   * 查 (x,z) 处贴着哪根可攀爬的柱子，返回最近的一个。
   *
   * `reach` 是判定裕量：角色贴到半径外这个距离之内就算"抱住"了，
   * 给太小会因为碰撞推出而永远够不着。
   */
  climbableAt(
    x: number,
    z: number,
    bodyRadius: number,
    reach = 0.45,
  ): Obstacle | null {
    if (this.total === 0) return null

    let best: Obstacle | null = null
    let bestDist = Infinity
    const cx = Math.floor(x / this.cellSize)
    const cz = Math.floor(z / this.cellSize)

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.keyFromCell(cx + dx, cz + dz))
        if (!list) continue

        for (let i = 0; i < list.length; i++) {
          const o = list[i]
          if (!o.climbable) continue
          const d = Math.hypot(x - o.x, z - o.z)
          if (d > o.radius + bodyRadius + reach) continue
          if (d < bestDist) {
            bestDist = d
            best = o
          }
        }
      }
    }

    return best
  }

  /**
   * 查 (x,z) 处有没有可以踩上去的顶面，返回最高的那个。
   *
   * `feetY` 是角色当前脚底高度，只接受**不高于脚底太多**的顶面——玩家得
   * 先跳上去，而不是走过去就被自动抬到石头顶上。容差给 0.35 米，够跨上
   * 一块及膝的石头。
   */
  surfaceAt(x: number, z: number, feetY: number, bodyRadius: number): number | null {
    if (this.total === 0) return null

    let best: number | null = null
    const cx = Math.floor(x / this.cellSize)
    const cz = Math.floor(z / this.cellSize)

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.keyFromCell(cx + dx, cz + dz))
        if (!list) continue

        for (let i = 0; i < list.length; i++) {
          const o = list[i]
          if (o.topY === undefined) continue
          // 脚得落在它上面：把身体半径往内收一点，避免"擦着边就算站上"
          if (Math.hypot(x - o.x, z - o.z) > o.radius + bodyRadius * 0.4) continue
          if (o.topY > feetY + 0.35) continue
          if (best === null || o.topY > best) best = o.topY
        }
      }
    }

    return best
  }

  /**
   * 把坐标推出所有重叠的障碍物，返回修正后的位置。
   *
   * 迭代两轮：一轮解决大部分情况，第二轮处理"被两个障碍夹住"时
   * 第一轮推出后又撞上另一个的边角情形。
   *
   * @param feetY 角色脚底高度。**已经站在其顶面上的障碍物会被跳过**，
   *   否则角色一踩上石头就会被自己的碰撞体推下去
   */
  resolve(x: number, z: number, movingRadius: number, feetY = -Infinity): { x: number; z: number } {
    if (this.total === 0) return { x, z }

    let px = x
    let pz = z

    for (let pass = 0; pass < 2; pass++) {
      let moved = false
      const cx = Math.floor(px / this.cellSize)
      const cz = Math.floor(pz / this.cellSize)

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = this.cells.get(this.keyFromCell(cx + dx, cz + dz))
          if (!list) continue

          for (let i = 0; i < list.length; i++) {
            const o = list[i]
            // 脚已经不低于顶面，说明站上去了，它不再挡路
            if (o.topY !== undefined && feetY >= o.topY - 0.05) continue
            const ox = px - o.x
            const oz = pz - o.z
            const dist = Math.hypot(ox, oz)
            const minDist = o.radius + movingRadius
            if (dist >= minDist) continue

            if (dist < 1e-5) {
              // 正好重合：随便挑个方向推开，否则会除以零
              px += minDist
              pz += minDist
            } else {
              const push = (minDist - dist) / dist
              px += ox * push
              pz += oz * push
            }
            moved = true
          }
        }
      }

      if (!moved) break
    }

    return { x: px, z: pz }
  }

  clear(): void {
    this.cells.clear()
    this.total = 0
  }

  private keyFor(x: number, z: number): number {
    return this.keyFromCell(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize))
  }

  private keyFromCell(cx: number, cz: number): number {
    return (cx + 50000) * 100000 + (cz + 50000)
  }
}
