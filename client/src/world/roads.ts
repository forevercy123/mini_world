/**
 * 道路网络。
 *
 * 没有路的开放世界是"一盘散沙上撒满兴趣点"，玩家每一步都在问
 * "我该往哪走"。塞尔达的路不只是装饰——它是设计师留给玩家的
 * 隐性引导：沿着路走，总会遇到点什么。
 *
 * 这里的做法：营地连接三座祭坛、封印之门和各座神庙，两点之间
 * 生成贴着地形走的折线路径。道路本身不改地形高度（爬坡过坎
 * 顺其自然），只做三件事：
 *   地面染成土色（chunkedTerrain 顶点色里混入）
 *   草长得稀（grassField 密度衰减）
 *   树不挡路（scatter 里避开）
 *
 * 所有读取方共用同一个 `distance()`，路的形状在全系统里只有一份。
 */

export interface RoadSegment {
  ax: number
  az: number
  bx: number
  bz: number
}

/** 土路染色半径（米）：距离路中心线这么远以内地面泛黄 */
export const ROAD_WIDTH = 2.3
/** 路边清树半径（米） */
export const ROAD_CLEAR = 3.8

export class RoadNetwork {
  private readonly segments: RoadSegment[] = []

  /**
   * 两点之间修一条路。直线太愣，中间按地形起伏插几个 waypoint，
   * 让路自然地拐一点弯——每段中点沿法线方向随机错开一小段。
   */
  addPath(from: { x: number; z: number }, to: { x: number; z: number }): void {
    const dx = to.x - from.x
    const dz = to.z - from.z
    const total = Math.hypot(dx, dz)
    // 每 26 米左右一个 waypoint
    const parts = Math.max(2, Math.round(total / 26))
    // 垂直于路径的方向，用于让路"晃"起来
    const nx = -dz / total
    const nz = dx / total

    let px = from.x
    let pz = from.z
    for (let i = 1; i <= parts; i++) {
      const t = i / parts
      let x = from.x + dx * t
      let z = from.z + dz * t
      // 端点保持精确（必须连到目的地），中间点随机摆动
      if (i < parts) {
        const sway = Math.sin(t * Math.PI * 2.3 + total * 0.13) * 7 * Math.sin(t * Math.PI)
        x += nx * sway
        z += nz * sway
      }
      this.segments.push({ ax: px, az: pz, bx: x, bz: z })
      px = x
      pz = z
    }
  }

  /** 到最近路段的距离。路段不多（几十条），逐个算是常数级开销 */
  distance(x: number, z: number): number {
    let best = Infinity
    for (const s of this.segments) {
      const d = distToSegment(x, z, s)
      if (d < best) best = d
    }
    return best
  }

  /** 是否在路上（供散布与草地查询） */
  isOnRoad(x: number, z: number, margin = ROAD_CLEAR): boolean {
    return this.distance(x, z) < margin
  }

  get segmentCount(): number {
    return this.segments.length
  }
}

function distToSegment(x: number, z: number, s: RoadSegment): number {
  const abx = s.bx - s.ax
  const abz = s.bz - s.az
  const lenSq = abx * abx + abz * abz
  if (lenSq < 1e-8) return Math.hypot(x - s.ax, z - s.az)
  let t = ((x - s.ax) * abx + (z - s.az) * abz) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(x - (s.ax + abx * t), z - (s.az + abz * t))
}
