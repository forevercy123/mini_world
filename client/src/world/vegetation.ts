/**
 * 世界的自然景观：树、灌木、岩石、花草。
 *
 * 素材换成 Kenney Nature Kit（CC0）之后，散布的形态也变了。上一版只有
 * 两种手写几何体，一个 InstancedMesh 装一种就够；现在有二十多种素材，
 * 再按「物种 × 区块」建 InstancedMesh 会直接冲到三百多个 draw call。
 * 所以整层改由 ScatterField 烘焙成「每区块一个静态网格」，draw call 只
 * 取决于区块数，加多少种素材都不涨。
 *
 * 这里只负责两件事：定义**加载清单**（哪些模型、各自多高）和**物种表**
 * （每个物种长在什么海拔、多密、要不要碰撞）。
 */

import { Group } from 'three'
import {
  ScatterField,
  type ScatterConfig,
  type SpeciesSpec,
} from './scatter.ts'
import type { NatureGeometry, NatureRequest } from './natureLibrary.ts'
import type { Heightfield } from '../terrain/heightfield.ts'
import type { ObstacleGrid } from '../physics/obstacleGrid.ts'
import type { RoadNetwork } from './roads.ts'

/**
 * 素材加载清单。
 *
 * `height` 是模型在原地的世界高度（米）。Kenney 这套模型是按「桌面摆件」
 * 尺度做的，树只有 1–2 米，必须显式说清楚要多大——靠包围盒自动放大是
 * 行不通的，那样灌木会被拉成树、树会被压成灌木。
 */
export const NATURE_MANIFEST: NatureRequest[] = [
  // ── 棕榈：只长在水边 ──
  { name: 'tree_palm', height: 7.0 },
  { name: 'tree_palmTall', height: 7.6 },
  { name: 'tree_palmShort', height: 5.2 },
  { name: 'tree_palmBend', height: 6.4 },

  // ── 阔叶：草原带主力 ──
  { name: 'tree_default', height: 7.2 },
  { name: 'tree_default_dark', height: 7.6 },
  { name: 'tree_oak', height: 6.8 },
  { name: 'tree_detailed', height: 7.4 },
  { name: 'tree_fat', height: 6.0 },
  { name: 'tree_tall', height: 8.4 },
  { name: 'tree_thin', height: 7.0 },
  { name: 'tree_simple', height: 7.8 },
  { name: 'tree_small', height: 4.8 },
  { name: 'tree_plateau', height: 6.6 },
  { name: 'tree_blocks', height: 5.8 },
  { name: 'tree_cone', height: 6.4 },

  // ── 秋季变种：给草原做点缀 ──
  { name: 'tree_oak_fall', height: 6.4 },
  { name: 'tree_default_fall', height: 6.8 },
  { name: 'tree_thin_fall', height: 6.8 },

  // ── 针叶：山地与高海拔 ──
  { name: 'tree_pineTallA', height: 10.5 },
  { name: 'tree_pineTallB', height: 12.0 },
  { name: 'tree_pineRoundA', height: 8.0 },
  { name: 'tree_pineRoundC', height: 7.2 },
  { name: 'tree_pineDefaultA', height: 8.8 },
  { name: 'tree_pineSmallA', height: 5.0 },
  { name: 'tree_pineGroundA', height: 3.2 },

  // ── 灌木与地被 ──
  { name: 'plant_bush', height: 1.6, fit: 'width' },
  { name: 'plant_bushLarge', height: 1.9, fit: 'width' },
  { name: 'plant_bushDetailed', height: 2.2, fit: 'width' },
  { name: 'plant_bushSmall', height: 1.2, fit: 'width' },
  { name: 'plant_flatShort', height: 1.3 },

  // ── 岩石 ──
  { name: 'rock_largeA', height: 2.0, fit: 'width' },
  { name: 'rock_largeB', height: 2.2, fit: 'width' },
  { name: 'rock_largeC', height: 2.0, fit: 'width' },
  { name: 'rock_largeD', height: 2.6, fit: 'width' },
  { name: 'rock_tallA', height: 3.4 },
  { name: 'rock_tallB', height: 2.8 },
  { name: 'rock_smallA', height: 0.9, fit: 'width' },
  { name: 'rock_smallB', height: 0.9, fit: 'width' },
  { name: 'rock_smallC', height: 0.8, fit: 'width' },
  { name: 'stone_largeA', height: 2.0, fit: 'width' },
  { name: 'stone_smallA', height: 0.9, fit: 'width' },

  // ── 花草与蘑菇 ──
  { name: 'flower_redA', height: 0.42 },
  { name: 'flower_redB', height: 0.38 },
  { name: 'flower_purpleA', height: 0.4 },
  { name: 'flower_purpleB', height: 0.36 },
  { name: 'flower_yellowA', height: 0.34 },
  { name: 'flower_yellowB', height: 0.3 },
  { name: 'mushroom_red', height: 0.3 },
  { name: 'mushroom_redGroup', height: 0.34 },
  { name: 'mushroom_tan', height: 0.26 },
  { name: 'mushroom_tanGroup', height: 0.32 },

  // ── 倒木与树桩 ──
  { name: 'log', height: 1.6, fit: 'width' },
  { name: 'log_stack', height: 1.5, fit: 'width' },
  { name: 'stump_round', height: 1.0, fit: 'width' },
  { name: 'stump_old', height: 1.1, fit: 'width' },

  // ── 地标构件：祭坛、封印之门、营地 ──
  // 不进散布表，由 landmarks.ts 单独摆放，这里只负责把几何体加载进来
  { name: 'platform_stone', height: 6.0, fit: 'width' },
  { name: 'statue_column', height: 4.0 },
  { name: 'statue_columnDamaged', height: 2.6 },
  { name: 'statue_obelisk', height: 5.5 },
  { name: 'statue_head', height: 2.4 },
  { name: 'statue_block', height: 1.2 },
  { name: 'statue_ring', height: 1.6 },
  { name: 'campfire_logs', height: 1.2, fit: 'width' },
  { name: 'campfire_stones', height: 1.8, fit: 'width' },
  { name: 'tent_smallClosed', height: 2.2 },
  // 锅是扁平器皿，必须按宽度归一化——按高度会得到一口三米宽的大缸
  { name: 'pot_large', height: 1.1, fit: 'width' },
  { name: 'sign', height: 1.6 },
]

/**
 * 物种表。
 *
 * ── 海拔带 ──
 * `band` 的分界跟着 heightfield 的生物群系带走：水位 11 米，沙滩到 19 米，
 * 草原 16–50 米，再往上进山。两边必须一起改，否则会出现「棕榈长在山脊上」
 * 这种穿帮。
 *
 * ── 权重是配比，不是概率 ──
 * 第一版按「每样都撒一点」的直觉给权重，结果 1400 个物件里树只占 17%，
 * 剩下全是小石头和地被——站在草原上看着像一片碎石滩。树是景观的主体，
 * 权重就该比石头高一个数量级：现在木质物种合计约 51，非木质约 13，
 * 在密度够的地方树占八成，全局看也在六成上下。
 *
 * ── density 决定「谁有资格站在这里」 ──
 * 它是所需森林密度下限。树要 0.2 以上，石头花草不挑（0），蘑菇跟着林子
 * 走（0.25）。于是空地有零星花草、疏林有树有草、密林里满是蘑菇和倒木，
 * 三层各得其所。
 */
export const SPECIES: SpeciesSpec[] = [
  // ── 棕榈：海滩专属，紧贴水位 ──
  { model: 'tree_palm', weight: 1.4, scale: [0.85, 1.15], band: [11.5, 19], collide: 0.3, climbable: true, wind: true, density: 0.1 },
  { model: 'tree_palmTall', weight: 1.25, scale: [0.85, 1.2], band: [11.5, 19], collide: 0.3, climbable: true, wind: true, density: 0.1 },
  { model: 'tree_palmShort', weight: 1.15, scale: [0.85, 1.15], band: [11.5, 18], collide: 0.28, climbable: true, wind: true, density: 0.1 },
  { model: 'tree_palmBend', weight: 1.1, scale: [0.9, 1.2], band: [11.5, 18.5], collide: 0.28, climbable: true, wind: true, density: 0.1 },

  // ── 阔叶林：草原带主力，权重最高的一批 ──
  { model: 'tree_default', weight: 1.8, scale: [0.85, 1.25], band: [16, 50], collide: 0.36, climbable: true, wind: true, density: 0.2 },
  { model: 'tree_oak', weight: 1.75, scale: [0.85, 1.3], band: [16, 48], collide: 0.34, climbable: true, wind: true, density: 0.2 },
  { model: 'tree_detailed', weight: 1.4, scale: [0.85, 1.2], band: [16, 50], collide: 0.34, climbable: true, wind: true, density: 0.22 },
  { model: 'tree_default_dark', weight: 1.25, scale: [0.85, 1.2], band: [18, 52], collide: 0.36, climbable: true, wind: true, density: 0.24 },
  { model: 'tree_tall', weight: 1.25, scale: [0.85, 1.25], band: [16, 52], collide: 0.3, climbable: true, wind: true, density: 0.22 },
  { model: 'tree_thin', weight: 1.1, scale: [0.85, 1.2], band: [16, 48], collide: 0.28, climbable: true, wind: true, density: 0.2 },
  { model: 'tree_simple', weight: 1.1, scale: [0.85, 1.2], band: [16, 46], collide: 0.3, climbable: true, wind: true, density: 0.2 },
  { model: 'tree_plateau', weight: 1.1, scale: [0.85, 1.25], band: [20, 56], collide: 0.32, climbable: true, wind: true, density: 0.24 },
  { model: 'tree_fat', weight: 1.05, scale: [0.9, 1.3], band: [16, 44], collide: 0.38, climbable: true, wind: true, density: 0.2 },
  // 方块树冠在这套素材里独一份，多了会让森林退化成"我的世界"，
  // 只留一点点当林相的点缀
  { model: 'tree_blocks', weight: 0.2, scale: [0.9, 1.3], band: [16, 46], collide: 0.32, climbable: true, wind: true, density: 0.24 },
  { model: 'tree_cone', weight: 0.85, scale: [0.9, 1.3], band: [18, 48], collide: 0.32, climbable: true, wind: true, density: 0.2 },
  { model: 'tree_small', weight: 0.9, scale: [0.9, 1.4], band: [16, 44], collide: 0.26, climbable: true, wind: true, density: 0.18 },

  // ── 秋季落叶树：秋色群系的主导物种，出了秋林几乎不出现 ──
  { model: 'tree_oak_fall', weight: 0.9, scale: [0.85, 1.2], band: [16, 48], collide: 0.34, climbable: true, wind: true, density: 0.14, autumnAffinity: 8 },
  { model: 'tree_default_fall', weight: 0.9, scale: [0.85, 1.2], band: [16, 48], collide: 0.36, climbable: true, wind: true, density: 0.14, autumnAffinity: 8 },
  { model: 'tree_thin_fall', weight: 0.8, scale: [0.85, 1.2], band: [16, 46], collide: 0.28, climbable: true, wind: true, density: 0.14, autumnAffinity: 8 },

  // ── 针叶林：从草原上缘开始接管，一直长到雪线附近 ──
  { model: 'tree_pineTallA', weight: 1.7, scale: [0.85, 1.2], band: [44, 92], collide: 0.32, climbable: true, wind: true, density: 0.18 },
  { model: 'tree_pineTallB', weight: 1.55, scale: [0.85, 1.2], band: [46, 94], collide: 0.32, climbable: true, wind: true, density: 0.18 },
  { model: 'tree_pineRoundA', weight: 1.4, scale: [0.85, 1.25], band: [42, 86], collide: 0.34, climbable: true, wind: true, density: 0.18 },
  { model: 'tree_pineRoundC', weight: 1.35, scale: [0.85, 1.25], band: [42, 84], collide: 0.32, climbable: true, wind: true, density: 0.18 },
  { model: 'tree_pineDefaultA', weight: 1.35, scale: [0.85, 1.2], band: [44, 90], collide: 0.3, climbable: true, wind: true, density: 0.18 },
  { model: 'tree_pineSmallA', weight: 1.15, scale: [0.9, 1.35], band: [42, 88], collide: 0.26, climbable: true, wind: true, density: 0.18 },
  { model: 'tree_pineGroundA', weight: 0.9, scale: [0.9, 1.4], band: [46, 92], collide: 0.2, climbable: true, wind: true, density: 0.16 },

  // ── 灌木：林下的填充，权重压得比树低一个档 ──
  { model: 'plant_bush', weight: 2.2, scale: [0.8, 1.5], band: [13, 60], maxSlope: 0.55, wind: true, density: 0.1 },
  { model: 'plant_bushLarge', weight: 1.7, scale: [0.8, 1.4], band: [13, 56], maxSlope: 0.55, wind: true, density: 0.15 },
  { model: 'plant_bushDetailed', weight: 1.6, scale: [0.8, 1.3], band: [15, 58], maxSlope: 0.55, wind: true, density: 0.2 },
  { model: 'plant_bushSmall', weight: 2.0, scale: [0.9, 1.6], band: [13, 62], maxSlope: 0.6, wind: true, density: 0 },
  { model: 'plant_flatShort', weight: 1.8, scale: [0.9, 1.5], band: [13, 58], maxSlope: 0.6, wind: true, density: 0 },

  // ── 岩石：低海拔零星、高海拔成群。小石头最没有景观价值，权重压到最低 ──
  { model: 'rock_smallA', weight: 0.7, scale: [0.7, 1.5], band: [12, 70], maxSlope: 0.85, collide: 0.34, climbable: true, standable: true, density: 0 },
  { model: 'rock_smallB', weight: 0.6, scale: [0.7, 1.5], band: [12, 72], maxSlope: 0.85, collide: 0.34, climbable: true, standable: true, density: 0 },
  { model: 'rock_smallC', weight: 0.55, scale: [0.7, 1.6], band: [12, 74], maxSlope: 0.85, collide: 0.32, climbable: true, standable: true, density: 0 },
  { model: 'stone_smallA', weight: 0.5, scale: [0.7, 1.4], band: [12, 76], maxSlope: 0.85, collide: 0.32, climbable: true, standable: true, density: 0 },
  { model: 'rock_largeA', weight: 1.1, scale: [0.7, 1.3], band: [20, 80], maxSlope: 0.8, collide: 0.7, climbable: true, standable: true, density: 0 },
  { model: 'rock_largeB', weight: 1.0, scale: [0.7, 1.3], band: [24, 84], maxSlope: 0.8, collide: 0.8, climbable: true, standable: true, density: 0 },
  { model: 'rock_largeC', weight: 1.0, scale: [0.7, 1.35], band: [22, 82], maxSlope: 0.8, collide: 0.75, climbable: true, standable: true, density: 0 },
  { model: 'rock_largeD', weight: 0.85, scale: [0.7, 1.3], band: [26, 88], maxSlope: 0.8, collide: 0.85, climbable: true, standable: true, density: 0 },
  { model: 'stone_largeA', weight: 0.9, scale: [0.7, 1.3], band: [20, 86], maxSlope: 0.8, collide: 0.7, climbable: true, standable: true, density: 0 },
  { model: 'rock_tallA', weight: 0.75, scale: [0.7, 1.25], band: [40, 95], maxSlope: 0.75, collide: 0.6, climbable: true, standable: true, density: 0 },
  { model: 'rock_tallB', weight: 0.7, scale: [0.7, 1.25], band: [44, 96], maxSlope: 0.75, collide: 0.55, climbable: true, standable: true, density: 0 },

  // ── 花：点缀色，成片要靠近看才密，所以权重也不高 ──
  { model: 'flower_redA', weight: 1.4, scale: [0.9, 1.5], band: [14, 52], maxSlope: 0.6, wind: true, density: 0 },
  { model: 'flower_redB', weight: 1.3, scale: [0.9, 1.5], band: [14, 52], maxSlope: 0.6, wind: true, density: 0 },
  { model: 'flower_purpleA', weight: 1.4, scale: [0.9, 1.5], band: [14, 54], maxSlope: 0.6, wind: true, density: 0 },
  { model: 'flower_purpleB', weight: 1.3, scale: [0.9, 1.5], band: [14, 54], maxSlope: 0.6, wind: true, density: 0 },
  { model: 'flower_yellowA', weight: 1.4, scale: [0.9, 1.6], band: [14, 50], maxSlope: 0.6, wind: true, density: 0 },
  { model: 'flower_yellowB', weight: 1.3, scale: [0.9, 1.6], band: [14, 50], maxSlope: 0.6, wind: true, density: 0 },

  // ── 蘑菇：偏阴湿，跟着林子走 ──
  { model: 'mushroom_red', weight: 1.2, scale: [0.9, 1.6], band: [15, 58], maxSlope: 0.55, density: 0.28 },
  { model: 'mushroom_redGroup', weight: 1.0, scale: [0.9, 1.5], band: [15, 58], maxSlope: 0.55, density: 0.28 },
  { model: 'mushroom_tan', weight: 1.2, scale: [0.9, 1.6], band: [15, 56], maxSlope: 0.55, density: 0.24 },
  { model: 'mushroom_tanGroup', weight: 1.0, scale: [0.9, 1.5], band: [15, 56], maxSlope: 0.55, density: 0.24 },

  // ── 倒木与树桩：只在林子里，低权重 ──
  { model: 'log', weight: 0.42, scale: [0.8, 1.3], band: [16, 60], maxSlope: 0.45, collide: 0.5, climbable: true, standable: true, density: 0.42 },
  { model: 'log_stack', weight: 0.28, scale: [0.8, 1.2], band: [16, 58], maxSlope: 0.4, collide: 0.6, climbable: true, standable: true, density: 0.45 },
  { model: 'stump_round', weight: 0.48, scale: [0.8, 1.4], band: [16, 62], maxSlope: 0.5, collide: 0.35, climbable: true, standable: true, density: 0.4 },
  { model: 'stump_old', weight: 0.42, scale: [0.8, 1.4], band: [16, 64], maxSlope: 0.5, collide: 0.35, climbable: true, standable: true, density: 0.4 },
]

export interface VegetationConfig {
  /** 目标物件总数（所有物种合计） */
  count: number
  /** 散布区域边长（米），以原点为中心 */
  areaSize: number
  /** 每个烘焙网格覆盖的区域边长（米），越小剔除越精细、draw call 越多 */
  groupSize: number
  seed: number
}

export const DEFAULT_VEGETATION_CONFIG: VegetationConfig = {
  // 树约占一半，其余是灌木、花、蘑菇、石头、倒木。
  //
  // 从 2000 提到 2800 是为了补地面层。之前那套权重按"树是主角"配，
  // 结果是林子漂亮、地面空荡——走进去只有草，像一片刚种完树苗的荒地。
  // 地被物件面数低（花 76 面、小石头 16 面），加一千个的代价很小。
  count: 2800,
  areaSize: 420,
  groupSize: 128,
  seed: 99,
}

export interface VegetationWindConfig {
  /** 摆动幅度（米），树冠顶端的最大位移 */
  strength: number
  /** 摆动速度倍率 */
  speed: number
}

export const DEFAULT_WIND: VegetationWindConfig = {
  strength: 0.16,
  speed: 1.0,
}

export class VegetationField {
  readonly group = new Group()
  private field: ScatterField | null = null

  constructor(
    hf: Heightfield,
    library: ReadonlyMap<string, NatureGeometry>,
    config: Partial<VegetationConfig> = {},
    wind: Partial<VegetationWindConfig> = {},
    /** 传入后会把树干、大石头的碰撞体登记进去，角色因此不会走进去 */
    obstacles?: ObstacleGrid,
    /** 道路网络：路面不长树 */
    roads?: RoadNetwork,
  ) {
    const cfg = { ...DEFAULT_VEGETATION_CONFIG, ...config }
    const windCfg = { ...DEFAULT_WIND, ...wind }
    this.group.name = 'vegetation'

    this.field = new ScatterField(
      hf,
      library,
      SPECIES,
      {
        count: cfg.count,
        areaSize: cfg.areaSize,
        groupSize: cfg.groupSize,
        // 阈值下移让森林覆盖更广：原来 [0.34, 0.74] 有近一半地面密度为零，
        // 从出生点望出去常常是一片无树的草坡，不像开放世界该有的林相
        clumping: { frequency: 0.0072, threshold: [0.26, 0.7] },
        seed: cfg.seed,
      } satisfies ScatterConfig,
      obstacles,
      windCfg,
      roads,
    )
    this.group.add(this.field.group)
  }

  update(dt: number): void {
    this.field?.update(dt)
  }

  setWindStrength(strength: number): void {
    this.field?.setWindStrength(strength)
  }

  /** 实际生成的物件总数 */
  get treeCount(): number {
    return this.field?.instanceCount ?? 0
  }

  /** 烘焙出的静态网格数，等于这一层的 draw call 贡献 */
  get batchCount(): number {
    return this.field?.chunkCount ?? 0
  }

  get triangleCount(): number {
    return this.field?.triangleCount ?? 0
  }

  /** 各素材实际生成的件数。用来确认树种是否真的长出来了 */
  get speciesBreakdown(): Array<[string, number]> {
    return this.field?.speciesBreakdown ?? []
  }

  setShadows(enabled: boolean): void {
    this.field?.setShadows(enabled)
  }

  dispose(): void {
    this.field?.dispose()
    this.field = null
  }
}

/**
 * 加载全部自然素材。返回的映射直接交给 VegetationField 使用。
 *
 * 缺几个模型不会让游戏起不来：ScatterField 会跳过找不到的物种，
 * 只在控制台留一条警告。
 */
export async function loadNature(
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, NatureGeometry>> {
  const { loadNatureBatch } = await import('./natureLibrary.ts')
  return loadNatureBatch(NATURE_MANIFEST, onProgress)
}
