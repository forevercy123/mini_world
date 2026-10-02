/**
 * 生物群系：让地图的不同区域看起来不一样。
 *
 * 之前的地貌分带只有一个维度——海拔。结果是整个世界里同一海拔
 * 长得一模一样：走到哪都是同一片绿草地，用户说"到处都是草地"
 * 就是这么来的。
 *
 * 这里加第二个维度：**区域**。一张低频噪声（约 220 米一个特征尺度）
 * 把草原带再细分成开阔草甸、密林、秋色林三块；海拔继续管
 * 沙滩/岩石/雪顶。两个维度叠起来，地图上就有了"这边是金色的
 * 秋林、翻过山是灰石坡、下到水边是沙滩"的分区感。
 *
 * 群系判定是纯函数，地形配色、草地、散布物种从同一个函数读——
 * 三处用各自的噪声就会对不上（地上是秋色、长的树却是绿的）。
 */

import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'
import { WATER_LEVEL } from './heightfield.ts'

export type Biome =
  | 'underwater'
  | 'beach'
  | 'meadow' // 开阔草甸：亮绿、草盛、树稀
  | 'forest' // 密林：深绿、树密、蘑菇多
  | 'autumn' // 秋色林：金黄调、落叶树
  | 'rock' // 高地岩石：灰、松树、苔痕
  | 'snow' // 雪顶

/**
 * 区域噪声（0–1）。低频：约 220 米一个特征——太大则全图一边倒，
 * 太小则群系碎成补丁。固定的相位偏移让它与高度噪声、密度噪声错开，
 * 不然"高海拔的地方永远正好是秋林"，那是噪声同源的穿帮。
 */
const regionNoiseGen = new ImprovedNoise()
export function regionAt(x: number, z: number): number {
  const n = regionNoiseGen.noise(x / 220 + 71.3, z / 220 - 43.7, 5.5)
  return n * 0.5 + 0.5
}

/**
 * 某地的群系。海拔管硬性分带（沙滩/岩石/雪顶），
 * 平面位置管区域性格——跟着 heightfield 的手工区域规划走：
 *
 *   东部谷地：森林（内部嵌一块秋色林）
 *   南部湖岸：环湖草甸
 *   西部高原坡脚：疏林草甸
 *   中央平原与其余草原：开阔草甸
 *
 * 区域噪声还在，但只用于东部森林内部的秋林斑块——
 * 大块的性格由区域决定，小块的变化由噪声决定。
 */
export function biomeAt(x: number, z: number, height: number): Biome {
  const rel = height - WATER_LEVEL
  if (rel < 0.5) return 'underwater'
  if (rel < 3) return 'beach'
  if (height > 74) return 'snow'
  if (height > 58) return 'rock'

  // 东部谷地是森林区，内部噪声切出一块秋林
  if (x > 105) {
    return regionAt(x, z) > 0.58 ? 'autumn' : 'forest'
  }
  // 南部湖岸与西部坡脚是草甸
  return 'meadow'
}

/** 草地密度倍率：哪些群系长草、长多少 */
export const GRASS_DENSITY: Record<Biome, number> = {
  underwater: 0,
  beach: 0,
  meadow: 1.0,
  forest: 0.75,
  autumn: 0.5, // 落叶盖住了草
  rock: 0.12, // 石缝里零星几丛
  snow: 0,
}

const ZERO_FACTORS = { autumn: 0, forest: 0 }

/**
 * 地面染色的群系强度（连续值 0–1）。秋色和密林只出现在东部谷地，
 * 边缘用区域噪声与东界掩膜各做一条渐带，颜色不会硬切。
 * 地形顶点色读它，而不是直接读区域噪声——别处 region 值再高也不染。
 */
export function colorFactors(
  x: number,
  z: number,
  height: number,
): { autumn: number; forest: number } {
  const rel = height - WATER_LEVEL
  if (rel < 4 || height > 52) return ZERO_FACTORS
  const eastMask = smoothstep(100, 128, x)
  if (eastMask <= 0) return ZERO_FACTORS
  const r = regionAt(x, z)
  const autumn = eastMask * smoothstep(0.56, 0.68, r)
  const forest = eastMask * (1 - smoothstep(0.56, 0.68, r)) * 0.8
  return { autumn, forest }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
