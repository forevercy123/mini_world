/**
 * 静态散布烘焙器：把成百上千个模型实例合并成「每区块一个网格」。
 *
 * ── 为什么不用 InstancedMesh ──
 *
 * 上一版树木用的是 InstancedMesh，一个 InstancedMesh 只能装一种几何体，
 * 于是 draw call = 树种数 × 区块数。两种手写树还能忍（2×16=32），换成
 * 外部素材后树、灌木、岩石、花草加起来二十多种，同一条公式立刻变成
 * 三百多个 draw call——还没画地形就超预算了。
 *
 * 既然树在生成之后就永不移动，实例矩阵就是常量。那就把它**烘焙进顶点**：
 * 每个区块把落在它范围内的所有物件（不分种类）变换到世界空间后合并成
 * 一个几何体。draw call 于是只等于区块数，与用了多少种素材完全无关。
 *
 * 代价是显存：顶点不再共享，1400 棵树约 21 万个三角形，位置/法线/颜色
 * 三组 float32 加起来约 15MB，换来的是 draw call 从三百降到二十。
 *
 * ── 风动怎么办 ──
 *
 * 顶点被烘焙到世界空间后，着色器里再拿不到「这个顶点属于哪棵树、离地多高」，
 * 摆幅就无从算起。所以烘焙时顺手写一条 `wind` 属性：0 在根部、1 在梢头。
 * 顶点着色器只读这一条，摆动逻辑和用实例矩阵时一样简单。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { NatureGeometry } from './natureLibrary.ts'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'
import { regionAt } from '../terrain/biome.ts'
import type { ObstacleGrid } from '../physics/obstacleGrid.ts'
import type { RoadNetwork } from './roads.ts'

/**
 * 攀爬高度占模型高度的比例。
 * 取 0.7：树能爬到树冠下沿，石头基本到顶——再高就爬上树冠了，
 * 站上去是一团叶子，不合理
 */
const CLIMB_HEIGHT_RATIO = 0.7

/**
 * 够高才允许攀爬（米）。
 *
 * 倒木、树桩、小石头这些不到膝盖高，视觉上几乎被草盖住——玩家撞上去
 * 却被判成"开始攀爬"，感受到的就是一堵凭空出现的空气墙。低于这个高度
 * 的一律只当障碍物绕行。
 */
const CLIMB_MIN_HEIGHT = 1.8

/** 一个物种的散布规则 */
export interface SpeciesSpec {
  /** 素材名，对应 /assets/nature/<model>.glb */
  model: string
  /** 相对权重：同类里出现频率的占比 */
  weight: number
  /** 世界高度倍数范围，乘在素材归一化高度之上 */
  scale: [number, number]
  /** 树干碰撞半径（米，会乘实例缩放）；省略表示不登记碰撞 */
  collide?: number
  /**
   * 顶面可以站人。石头、树桩、倒木标这一项，玩家能跳上去；
   * 树干不标——它只能挡路，站到树干顶上不合理。
   */
  standable?: boolean
  /**
   * 可以攀爬。对着它一直走会开始往上爬——树干、石头、树桩都标。
   * 攀爬上限取模型高度的 CLIMB_HEIGHT_RATIO：树只到树冠下方，
   * 石头爬到顶就能站上去
   */
  climbable?: boolean
  /** 适宜海拔区间（米） */
  band: [number, number]
  /** 海拔过渡带宽（米）。带宽内权重渐变为 0，避免出现一条刀切的分界线 */
  bandFade?: number
  /** 最大坡度（heightfield.slope 的 1-cos 形式） */
  maxSlope?: number
  /** 需要的森林密度下限（0–1）。灌木花草要求低，树木要求高，林下才不会是空的 */
  density?: number
  /** 是否参与风动摆动 */
  wind?: boolean
  /**
   * 秋色群系的亲和度。>1 表示秋色区主导（落叶树给 8），
   * 缺省则秋色区照常、非秋色区按普通对待。
   * 带亲和度的物种在非秋色区权重会压到 6%——秋林就该成片，不该满地零星
   */
  autumnAffinity?: number
}

export interface ScatterConfig {
  /** 目标物件总数（所有物种合计） */
  count: number
  /** 散布区域边长（米），以原点为中心 */
  areaSize: number
  /** 区块边长（米）。越小剔除越精细，draw call 越多 */
  groupSize: number
  /** 密度噪声：空间频率与阈值区间 */
  clumping: { frequency: number; threshold: [number, number] }
  seed: number
}

export interface ScatterResult {
  /** 实际生成的物件数 */
  count: number
  /** 生成的区块网格数，即 draw call 贡献 */
  chunks: number
  /** 三角形总数 */
  triangles: number
}

export class ScatterField {
  readonly group = new Group()
  private readonly meshes: Mesh[] = []
  private readonly geometry: BufferGeometry[] = []
  private readonly material: MeshLambertMaterial
  private readonly windTime = { value: 0 }
  private readonly windStrength: { value: number }
  private readonly windSpeed: { value: number }
  private windPhase = 0
  private stats: ScatterResult = { count: 0, chunks: 0, triangles: 0 }
  private readonly speciesCounts = new Map<string, number>()

  constructor(
    hf: Heightfield,
    library: ReadonlyMap<string, NatureGeometry>,
    species: readonly SpeciesSpec[],
    config: ScatterConfig,
    obstacles?: ObstacleGrid,
    wind: { strength: number; speed: number } = { strength: 0.16, speed: 1 },
    /** 道路网络：路上的位置不长树（树冠糊脸的路没法走） */
    private readonly roads?: RoadNetwork,
  ) {
    this.group.name = 'scatter'
    this.windStrength = { value: wind.strength }
    this.windSpeed = { value: wind.speed }
    // 这里用平滑着色，跟手写几何时期的选择相反。
    //
    // 手写树只有 100-200 面且形状规整，平面着色能把棱面变成"风格"；
    // Kenney 的树冠是球体和锥体拼的，面数同样低但轮廓是圆的，再按面
    // 着色就成了一颗颗多面体骰子，跟塞尔达那种圆润的卡通树不是一回事。
    // 平滑法线让低面数的球看起来仍然是球。
    this.material = new MeshLambertMaterial({ vertexColors: true })

    // 一点点自发光。树冠底面朝下，直射光和半球光的天空色都照不到它，
    // 只能拿到半球光的"地面色"（深棕），在树底下抬头看就是一坨黑。
    // 真实的树叶会透光，这点自发光就是那个意思——数值必须压得很低，
    // 再高一点整片林子就会发灰、失去明暗对比。
    this.material.emissive = new Color(0x14200e)
    this.installWind()

    const usable = species.filter((s) => library.has(s.model))
    const missing = species.filter((s) => !library.has(s.model))
    if (missing.length > 0) {
      console.warn(`[散布] 缺少素材：${missing.map((s) => s.model).join(', ')}`)
    }
    if (usable.length === 0) return

    this.populate(hf, library, usable, config, obstacles)
  }

  /**
   * 用 onBeforeCompile 往标准材质里注入风动，而不是自己写一套 ShaderMaterial。
   *
   * 好处是保留了 Lambert 的全部光照与阴影逻辑（自写的话这些都要重来一遍）。
   * 注入点在 begin_vertex 之后——此时 `transformed` 已是顶点位置的副本。
   * 烘焙过的顶点就在世界空间里，所以相位直接取它的水平坐标即可。
   */
  private installWind(): void {
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = this.windTime
      shader.uniforms.uWindStrength = this.windStrength
      shader.uniforms.uWindSpeed = this.windSpeed

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uWindTime;
          uniform float uWindStrength;
          uniform float uWindSpeed;
          attribute float wind;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          // wind 是烘焙时写好的离地比例（0 根部、1 梢头），平方后只有树冠摆
          float windH = wind * wind;
          // 相位取自顶点的世界水平坐标，否则所有树会完全同步摆动，一眼假
          float phaseSeed = transformed.x * 0.09 + transformed.z * 0.13;
          float w1 = sin(uWindTime * uWindSpeed * 1.25 + phaseSeed);
          float w2 = sin(uWindTime * uWindSpeed * 2.10 + phaseSeed * 1.7) * 0.45;
          float bend = (w1 + w2) * uWindStrength * windH;
          transformed.x += bend;
          transformed.z += bend * 0.6;`,
        )
    }
  }

  /** 每帧推进风动。累加而非取模，避免长时间运行后精度下降。 */
  update(dt: number): void {
    this.windPhase += dt
    this.windTime.value = this.windPhase
  }

  setWindStrength(strength: number): void {
    this.windStrength.value = strength
  }

  get instanceCount(): number {
    return this.stats.count
  }

  get chunkCount(): number {
    return this.stats.chunks
  }

  get triangleCount(): number {
    return this.stats.triangles
  }

  /** 各素材实际生成的件数，按数量从多到少。调散布参数时看这个最直观 */
  get speciesBreakdown(): Array<[string, number]> {
    return [...this.speciesCounts.entries()].sort((a, b) => b[1] - a[1])
  }

  setShadows(enabled: boolean): void {
    for (const m of this.meshes) m.castShadow = enabled
  }

  dispose(): void {
    // 几何体由本层独占，逐块销毁；材质是共享的，最后统一销毁
    for (const m of this.meshes) m.geometry.dispose()
    this.meshes.length = 0
    this.geometry.length = 0
    this.material.dispose()
  }

  // ─────────────────────────── 生成 ───────────────────────────

  private populate(
    hf: Heightfield,
    library: ReadonlyMap<string, NatureGeometry>,
    species: readonly SpeciesSpec[],
    cfg: ScatterConfig,
    obstacles?: ObstacleGrid,
  ): void {
    const rand = mulberry32(cfg.seed)
    const half = cfg.areaSize / 2

    // 用抖动网格采样。格距按目标数量的 3 倍反推：密度噪声与生物群系
    // 会筛掉大部分候选点，先多撒再抽样，count 才能真实反映最终数量。
    const spacing = Math.sqrt((cfg.areaSize * cfg.areaSize) / Math.max(1, cfg.count * 3))
    const grid = Math.max(1, Math.ceil(cfg.areaSize / spacing))

    // 权重表：累计和用于 O(log n) 抽物种
    const totalWeight = species.reduce((sum, s) => sum + s.weight, 0)

    const placements: Placement[] = []
    const densityAt = makeDensityNoise(cfg.clumping, cfg.seed)

    for (let iz = 0; iz < grid; iz++) {
      for (let ix = 0; ix < grid; ix++) {
        const x = -half + (ix + rand()) * spacing
        const z = -half + (iz + rand()) * spacing

        const density = densityAt(x, z)
        if (density <= 0.001) continue

        const y = hf.height(x, z)
        const slope = hf.slope(x, z)

        const spec = pickSpecies(species, totalWeight, rand, y, density, regionAt(x, z), x)
        if (!spec) continue
        // 树不挡路：道路上空出一条走廊，玩家沿着路走不会被树冠糊脸
        if (this.roads && spec.collide && this.roads.isOnRoad(x, z)) continue
        if (slope > (spec.maxSlope ?? 0.55)) continue
        if (density < (spec.density ?? 0)) continue

        const geometry = library.get(spec.model)!
        const [lo, hi] = spec.scale
        const scale = lo + rand() * (hi - lo)

        // 在斜坡上下沉一点。
        //
        // 物件是按中心点的地面高度摆的，而它自己有宽度——坡越陡、越宽，
        // 边缘就翘得越高，看起来像浮在地面上。下沉量取"边缘在坡度下会
        // 抬高多少"的一半，既压住悬空，又不会把整棵树埋进去。
            const footprint = geometry.radius * scale
        const sink = Math.min(footprint * Math.tan(hf.slopeAngle(x, z)) * 0.5, 0.7)

        placements.push({
          spec,
          geometry,
          x,
          y: y - sink,
          z,
          rot: rand() * Math.PI * 2,
          scale,
          // 色调在 0.84–1.16 之间浮动，同一种素材才不会一眼看出是复制品
          tint: 0.84 + rand() * 0.32,
          tintG: 0.94 + rand() * 0.12,
          sway: spec.wind === true,
        })

        if (spec.collide) {
          // 可站立的物件额外登记顶面高度。取包围盒高度的 0.85——石头顶部
          // 是弧面，按最高点算的话角色会浮在石头上方一小截
          const topY = spec.standable ? y - sink + geometry.height * scale * 0.85 : undefined
          // 可攀爬的登记高度上限。有 topY 的爬到顶就站上去；树没有顶面，
          // 只让爬到树冠下方——爬到树冠上站着不合理，但爬上去看个视野很值。
          //
          // 高度不够的一律不登记：那些东西只该挡路，不该让人"爬"上去
          const tall = geometry.height * scale >= CLIMB_MIN_HEIGHT
          const canClimb = spec.climbable === true && tall
          const climbHeight = canClimb ? geometry.height * scale * CLIMB_HEIGHT_RATIO : undefined
          obstacles?.insert(x, z, spec.collide * scale, topY, canClimb, climbHeight)
        }
      }
    }

    // 候选通常远超目标数量，做一次部分 Fisher-Yates 抽样：
    // 既精确控制最终数量，又不破坏空间分布
    if (placements.length > cfg.count) {
      for (let i = 0; i < cfg.count; i++) {
        const j = i + Math.floor(rand() * (placements.length - i))
        const tmp = placements[i]
        placements[i] = placements[j]
        placements[j] = tmp
      }
      placements.length = cfg.count
    }

    this.bake(placements, cfg.groupSize)
  }

  /** 按区块分桶，每桶烘焙成一个静态网格 */
  private bake(placements: Placement[], groupSize: number): void {
    const buckets = new Map<string, Placement[]>()
    for (const p of placements) {
      const key = `${Math.floor(p.x / groupSize)},${Math.floor(p.z / groupSize)}`
      const bucket = buckets.get(key)
      if (bucket) bucket.push(p)
      else buckets.set(key, [p])

      this.speciesCounts.set(p.spec.model, (this.speciesCounts.get(p.spec.model) ?? 0) + 1)
    }

    let triangles = 0
    for (const list of buckets.values()) {
      const geometry = bakeChunk(list)
      if (!geometry) continue
      this.geometry.push(geometry)
      triangles += geometry.index ? geometry.index.count / 3 : 0

      const mesh = new Mesh(geometry, this.material)
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.matrixAutoUpdate = false
      // 顶点已经在世界空间里，包围球必须按实际顶点算，否则剔除会误杀
      geometry.computeBoundingSphere()
      this.group.add(mesh)
      this.meshes.push(mesh)
    }

    this.stats = { count: placements.length, chunks: this.meshes.length, triangles }
  }
}

interface Placement {
  spec: SpeciesSpec
  geometry: NatureGeometry
  x: number
  y: number
  z: number
  rot: number
  scale: number
  tint: number
  tintG: number
  /** 是否参与风动。岩石和花不摆，只有树和灌木 */
  sway: boolean
}

/**
 * 把一批实例合并成一个几何体。
 *
 * 逐顶点写入预分配的大数组，而不是先 clone 再 mergeGeometries：
 * 后者要为每个实例复制一份几何体、再整体拷贝一次，1400 棵树会做
 * 两千多次分配，启动时肉眼可见地卡一下。
 */
function bakeChunk(list: Placement[]): BufferGeometry | null {
  let vertexCount = 0
  let indexCount = 0
  for (const p of list) {
    const src = p.geometry.geometry
    const count = src.attributes.position.count
    vertexCount += count
    indexCount += src.index ? src.index.count : count
  }
  if (vertexCount === 0) return null

  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 3)
  const winds = new Float32Array(vertexCount)
  const indices = new Uint32Array(indexCount)

  const matrix = new Matrix4()
  const normalMatrix = new Matrix3()
  const quaternion = new Quaternion()
  const position = new Vector3()
  const scaleVec = new Vector3()
  const vertex = new Vector3()
  const normal = new Vector3()
  const up = new Vector3(0, 1, 0)

  let vOff = 0
  let iOff = 0

  for (const p of list) {
    const src = p.geometry.geometry
    const srcPos = src.attributes.position as BufferAttribute
    const srcNormal = src.attributes.normal as BufferAttribute | undefined
    const srcColor = src.attributes.color as BufferAttribute
    const count = srcPos.count

    position.set(p.x, p.y, p.z)
    quaternion.setFromAxisAngle(up, p.rot)
    scaleVec.set(p.scale, p.scale, p.scale)
    matrix.compose(position, quaternion, scaleVec)
    normalMatrix.getNormalMatrix(matrix)

    // 素材高度用于还原「离地比例」：烘进风动权重后，着色器才知道
    // 这个顶点是树根还是树梢
    const height = p.geometry.height || 1

    for (let i = 0; i < count; i++) {
      vertex.fromBufferAttribute(srcPos, i).applyMatrix4(matrix)
      const o = (vOff + i) * 3
      positions[o] = vertex.x
      positions[o + 1] = vertex.y
      positions[o + 2] = vertex.z

      if (srcNormal) {
        normal.fromBufferAttribute(srcNormal, i).applyMatrix3(normalMatrix).normalize()
        normals[o] = normal.x
        normals[o + 1] = normal.y
        normals[o + 2] = normal.z
      }

      colors[o] = srcColor.getX(i) * p.tint
      colors[o + 1] = srcColor.getY(i) * p.tint * p.tintG
      colors[o + 2] = srcColor.getZ(i) * p.tint

      // 离地比例：底 0、顶 1。风摆幅按它的平方衰减，根部几乎不动。
      // 石头和花整株写 0，它们不该跟着风摇。
      if (p.sway) {
        const local = p.geometry.geometry.boundingBox
          ? (srcPos.getY(i) - p.geometry.geometry.boundingBox.min.y) / height
          : srcPos.getY(i) / height
        winds[vOff + i] = local < 0 ? 0 : local > 1 ? 1 : local
      }
    }

    if (src.index) {
      for (let i = 0; i < src.index.count; i++) {
        indices[iOff + i] = src.index.getX(i) + vOff
      }
      iOff += src.index.count
    } else {
      for (let i = 0; i < count; i++) indices[iOff + i] = vOff + i
      iOff += count
    }

    vOff += count
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('color', new BufferAttribute(colors, 3))
  geometry.setAttribute('wind', new BufferAttribute(winds, 1))
  geometry.setIndex(new BufferAttribute(indices, 1))
  return geometry
}

/**
 * 森林密度噪声：同一片区域该长满树还是只有零星几棵。
 *
 * 用两次不同频率的噪声相乘：低频决定大块的林区与草地，高频在林子内部
 * 制造疏密，边缘才不会是平滑的渐变。
 */
function makeDensityNoise(
  cfg: ScatterConfig['clumping'],
  seed: number,
): (x: number, z: number) => number {
  const [lo, hi] = cfg.threshold
  const offset = ((seed % 97) * 2654435761) | 0
  /**
   * 简易值噪声：格点 hash + 双线性插值，省掉一个 Perlin 依赖。
   *
   * 每一轮乘法都必须走 Math.imul。用 `*` 的话中间结果会冲到 2.7e18，
   * 远超 double 能精确表示的 9e15，低位被抹平——hash 退化成几乎常数，
   * 密度随之在整张地图上取同一个值，树木会成片消失（踩过这个坑）。
   */
  const hash = (ix: number, iz: number): number => {
    let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ offset
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
  const valueNoise = (x: number, z: number): number => {
    const ix = Math.floor(x)
    const iz = Math.floor(z)
    const fx = x - ix
    const fz = z - iz
    // smoothstep 插值，避免方格状的人工痕迹
    const sx = fx * fx * (3 - 2 * fx)
    const sz = fz * fz * (3 - 2 * fz)
    const a = hash(ix, iz)
    const b = hash(ix + 1, iz)
    const c = hash(ix, iz + 1)
    const d = hash(ix + 1, iz + 1)
    return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz
  }

  return (x, z) => {
    const low = valueNoise(x * cfg.frequency, z * cfg.frequency)
    const high = valueNoise(x * cfg.frequency * 3.7 + 51.7, z * cfg.frequency * 3.7 + 17.3)
    const combined = low * 0.72 + high * 0.28
    return smoothstep(lo, hi, combined)
  }
}

/**
 * 按权重抽取一个物种，同时按海拔带过滤。
 *
 * 权重是「相对频率」而不是概率：先把落在适宜海拔内的物种权重加总，再在
 * 这个总长上取随机点。这样即使某个物种因为海拔被排除，其余物种也会
 * 按比例补上，不会出现「高山上只剩空地」。
 */
function pickSpecies(
  species: readonly SpeciesSpec[],
  totalWeight: number,
  rand: () => number,
  height: number,
  density: number,
  region: number,
  x: number,
): SpeciesSpec | null {
  // 秋色群系只在东部谷地（与 biomeAt 的分区一致）：区域噪声
  // 负责谷地内部的秋林斑块，东界决定"哪里是谷地"
  const inAutumn = x > 105 && region > 0.58 && height > WATER_LEVEL + 3 && height < 58

  // 先算出每个物种在当前海拔下的有效权重
  let effective = 0
  const weights = new Array<number>(species.length)
  for (let i = 0; i < species.length; i++) {
    const s = species[i]
    let w = s.weight * bandWeight(s, height) * (density >= (s.density ?? 0) ? 1 : 0)
    // 秋色亲和：落叶树在秋林里压倒性主导，出了秋林几乎不见
    if (s.autumnAffinity) w *= inAutumn ? s.autumnAffinity : 0.06
    weights[i] = w
    effective += w
  }
  if (effective <= 0) return null

  let roll = rand() * Math.min(effective, totalWeight)
  for (let i = 0; i < species.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return species[i]
  }
  // 浮点误差兜底：权重全为零之外的最后一个有效物种
  for (let i = species.length - 1; i >= 0; i--) {
    if (weights[i] > 0) return species[i]
  }
  return null
}

/** 海拔带权重：带内为 1，带边缘用 smoothstep 过渡到 0 */
function bandWeight(spec: SpeciesSpec, height: number): number {
  const [lo, hi] = spec.band
  const fade = spec.bandFade ?? 8
  if (height < lo - fade || height > hi + fade) return 0
  const rise = smoothstep(lo - fade, lo + fade, height)
  const fall = 1 - smoothstep(hi - fade, hi + fade, height)
  return Math.min(rise, fall)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 确定性伪随机，保证同一 seed 每次生成相同的世界 */
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
