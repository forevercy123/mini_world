/**
 * 高度场：把连续的噪声函数当作整个世界的地形高度来源。
 *
 * 阶段 0 用纯噪声即可；阶段 1 之后会把 tools/terrain_gen 在 GPU 上
 * 算好的侵蚀高度图烘成数据块，届时只需替换本类的 sample 实现，
 * 调用方（地形网格、植被散布、物理碰撞）都不用改。
 */

import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'
import { Color, Vector2, Vector3 } from 'three'

export interface TerrainShape {
  /** 最高峰高度（米） */
  maxHeight: number
  /** 山脊强度 0–1，越大山越陡峭 */
  ridgeStrength: number
  /** 平原基准高度（米） */
  baseHeight: number
  seed: number
}

export const DEFAULT_SHAPE: TerrainShape = {
  maxHeight: 130,
  // 0.72 时山峰只能到 55 米，世界显得平；0.86 能到 70 米上下，
  // 站在高处才看得出地形的层次
  ridgeStrength: 0.86,
  baseHeight: 6,
  seed: 1337,
}

/**
 * 海平面高度（米）。
 *
 * 这个值是整个世界的参照基准：水面高度、地貌分带、出生点选择全都相对它
 * 定义。实测地形中位数约 24 米、最低 -4 米，11 米对应约 12% 的地面被水覆盖
 * ——有湖泊河流，但主体仍是可通行的陆地。
 */
export const WATER_LEVEL = 11

/** 生物群系配色，按高度与坡度混合出顶点色 */
export const BIOME_COLORS = {
  sand: new Color(0xd8cba0),
  grassLow: new Color(0x6f9a4a),
  grassHigh: new Color(0x497236),
  rock: new Color(0x7a7268),
  rockDark: new Color(0x5a544c),
  snow: new Color(0xe8eef2),
  underwater: new Color(0x8a7f6a),
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export class Heightfield {
  private readonly noise = new ImprovedNoise()
  private readonly shape: TerrainShape
  /** 种子偏移，避免不同种子生成相同地形 */
  private readonly seedOffset: Vector3

  constructor(shape: Partial<TerrainShape> = {}) {
    this.shape = { ...DEFAULT_SHAPE, ...shape }
    // ImprovedNoise 无种子参数，用固定偏移量造出不同地形的效果
    const s = this.shape.seed
    this.seedOffset = new Vector3((s % 512) * 7.13, (s % 257) * 3.77, (s % 128) * 11.31)
  }

  /** 单次噪声采样，返回 [-1, 1] */
  private n(x: number, z: number, freq: number, offsetZ = 0): number {
    return this.noise.noise(
      x * freq + this.seedOffset.x,
      offsetZ + this.seedOffset.z,
      z * freq + this.seedOffset.y,
    )
  }

  /** 分形叠加：多个倍频的正弦式起伏 */
  private fbm(x: number, z: number, freq: number, octaves: number, persistence = 0.5): number {
    let sum = 0
    let amp = 1
    let f = freq
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.n(x, z, f, i * 17.7)
      norm += amp
      amp *= persistence
      f *= 2.03
    }
    return sum / norm
  }

  /** 山脊噪声：1-|n| 会产生尖锐的山脊线，是山脉形态的关键 */
  private ridged(x: number, z: number, freq: number, octaves: number): number {
    let sum = 0
    let amp = 1
    let f = freq
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      const v = 1 - Math.abs(this.n(x, z, f, 31.3 + i * 9.1))
      sum += amp * v * v
      norm += amp
      amp *= 0.5
      f *= 2.07
    }
    return sum / norm
  }

  /** 世界坐标 (x, z) 处的地面高度（米） */
  height(x: number, z: number): number {
    // 低频"大陆"信号决定这一带是平原还是山地。
    // 阈值区间经过实测修正：原先是 (-0.05, 0.45)，导致只有极少数区域能起山，
    // 全球高差只有 50 米、中位数 9 米——那是一块丘陵，不是一个世界。
    const continent = this.fbm(x, z, 0.00085, 3, 0.55)
    const mountainMask = smoothstep(-0.34, 0.26, continent)

    // 起伏基底
    const hills = this.fbm(x, z, 0.0055, 4, 0.5)
    // 山脊
    const ridge = this.ridged(x, z, 0.0032, 5)

    const { maxHeight, ridgeStrength, baseHeight } = this.shape

    const rolling = hills * 24 + baseHeight
    const mountains = ridge * maxHeight * ridgeStrength * mountainMask

    // 平地区域压平一些，让玩家有可以奔跑的开阔地
    const flatness = 1 - smoothstep(0.2, 0.6, mountainMask) * 0.42

    let h = (rolling + mountains) * flatness

    // 河谷：低频噪声做一次凹陷，制造水系走廊，也为水体准备低洼地
    const valley = this.fbm(x + 5000, z - 3000, 0.0016, 2, 0.5)
    h -= smoothstep(0.2, 0.78, valley) * 20

    // 陡崖层。
    // 实测发现：只靠山脊噪声时全图最陡处只有 45.4°，低于 48° 的行走上限
    // ——攀爬机制永远触发不了。噪声生成的地形天然"顺滑"，不可能出现
    // 垂直崖壁。所以这里用一个**窄区间的 smoothstep** 在台地边缘制造
    // 急剧的高度跃变：值域宽度 0.14 对应约 8 米水平距离，落差 44 米，
    // 坡度接近 80°，是可以攀爬的岩壁。
    // 阈值经过两轮实测标定：第一版只有 0.4% 的地形陡到需要攀爬，
    // 玩家跑半天遇不到一个崖壁，机制等于不存在。放宽掩码与 plateau
    // 区间后占比升到合理量级，目标区间是 3%–8%。
    const cliffMask = smoothstep(0.12, 0.52, mountainMask)
    if (cliffMask > 0.01) {
      const plateau = smoothstep(0.28, 0.44, this.fbm(x + 900, z + 400, 0.0042, 3, 0.5))
      h += plateau * 40 * cliffMask
    }

    return h
  }

  /** 用有限差分估算法线，供光照与坡度判断使用 */
  normal(x: number, z: number, out = new Vector3(), eps = 1.5): Vector3 {
    const hL = this.height(x - eps, z)
    const hR = this.height(x + eps, z)
    const hD = this.height(x, z - eps)
    const hU = this.height(x, z + eps)
    return out.set(hL - hR, 2 * eps, hD - hU).normalize()
  }

  /**
   * 坡度的归一化表示：0（平地）→ 1（垂直）。用于配色分带与着色器。
   *
   * 注意它**不是角度**。要和以弧度为单位的配置（如 maxSlopeAngle）比较时，
   * 请用 slopeAngle()——两者混用会导致判定恒真/恒假，这个坑踩过一次。
   */
  slope(x: number, z: number): number {
    const n = this.normal(x, z, _tmpNormal)
    return 1 - Math.max(0, n.y)
  }

  /** 坡度角（弧度），可与 maxSlopeAngle 之类的弧度配置直接比较 */
  slopeAngle(x: number, z: number): number {
    const n = this.normal(x, z, _tmpNormal)
    return Math.acos(Math.max(-1, Math.min(1, n.y)))
  }

  /**
   * 地形梯度 (∂h/∂x, ∂h/∂z)。
   *
   * 角色控制器靠它做两件事：判断前方坡是否陡到走不上去；以及坡太陡时
   * 把速度投影到与梯度垂直的方向，让角色沿等高线滑行而不是硬卡在坡上。
   * 后者是"走不上去但不会撞墙停住"的手感关键。
   */
  gradient(x: number, z: number, out = new Vector2(), eps = 1.0): Vector2 {
    const hL = this.height(x - eps, z)
    const hR = this.height(x + eps, z)
    const hD = this.height(x, z - eps)
    const hU = this.height(x, z + eps)
    return out.set((hR - hL) / (2 * eps), (hU - hD) / (2 * eps))
  }

}

const _tmpNormal = new Vector3()

/**
 * 按海拔与坡度混出地貌颜色。低多边形风格的核心就是不依赖贴图，
 * 靠颜色分区表达地貌。
 *
 * 阈值经过一次修正：最初把 8 米以下都算作沙滩，结果低地草原全变成了
 * 土黄色。真实的分带应该是「只有贴着水面的那一圈才是沙」。
 *
 * 这是一个纯函数且**全局唯一**——地形网格和未来的小地图、贴图烘焙
 * 都必须调它，否则同一块地在不同地方会显示出不同颜色。
 */
export function shadeVertex(height: number, slope: number, out: Color): Color {
  const { sand, grassLow, grassHigh, rock, snow, underwater } = BIOME_COLORS

  // 以水位为基准换算相对高度。用绝对高度标定的话，每次调水位或地形尺度
  // 都要重新标一堆阈值（第一版就因此让半个世界变成了沙滩）。
  const rel = height - WATER_LEVEL

  if (rel < 0.5) {
    out.copy(underwater).lerp(sand, smoothstep(-3, 0.5, rel))
  } else if (rel < 4) {
    out.copy(sand).lerp(grassLow, smoothstep(0.5, 4, rel))
  } else if (rel < 30) {
    out.copy(grassLow).lerp(grassHigh, smoothstep(4, 30, rel))
  } else if (rel < 52) {
    out.copy(grassHigh).lerp(rock, smoothstep(30, 52, rel))
  } else {
    out.copy(rock).lerp(snow, smoothstep(52, 66, rel))
  }

  // 陡坡露出岩石
  const rockAmount = smoothstep(0.3, 0.68, slope)
  if (rockAmount > 0) out.lerp(rock, rockAmount)

  // 极陡处压暗，强化体积感
  const steep = smoothstep(0.72, 0.95, slope)
  if (steep > 0) out.multiplyScalar(1 - steep * 0.22)

  return out
}
