/**
 * 分块地形 + 四叉树式 LOD。
 *
 * 世界的组织方式：以相机所在块为中心，按环形范围决定需要哪些块，
 * 每块再按到相机的距离选择顶点密度（LOD）。远处用极低密度，
 * 因为 M1 的顶点/填充预算很紧（见 开发规划.md 第三节）。
 *
 * 性能要点（踩过的坑，改代码前先读）：
 *  1. 高度采样是纯噪声函数，逐顶点调用会重复计算上千次——所以先算出
 *     整块的高度网格，法线、坡度、配色全部从网格读，每个顶点只采样一次。
 *  2. 块重建是同步的，代价约 10ms，因此每帧只处理有限个重建任务，
 *     否则相机快速移动时会掉帧。
 *  3. 所有块共享同一个材质，避免着色器切换。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  Vector3,
} from 'three'
import { WATER_LEVEL, shadeVertex, type Heightfield } from './heightfield.ts'
import { colorFactors } from './biome.ts'
import type { RoadNetwork } from '../world/roads.ts'

export interface TerrainConfig {
  /** 每块的世界尺寸（米） */
  chunkSize: number
  /** 视距（米），超出范围的块会被卸载 */
  viewDistance: number
  /** 每级 LOD 的分段数（顶点数 = 分段数 + 1） */
  lodSegments: number[]
  /** 每级 LOD 的生效距离上界（米），长度需与 lodSegments 一致 */
  lodDistances: number[]
  /** 裙边下探深度（米），用于遮住 LOD 接缝 */
  skirtDepth: number
}

export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  chunkSize: 64,
  viewDistance: 320,
  // 64 段在 64m 块上是 1m 一格，足够走路；再高只是白烧顶点。
  // 最外圈从 8 降到 6：那一层基本被雾吃掉，16 米一格和 10 米一格
  // 在画面里没有区别，省下的三角形留给植被。
  lodSegments: [64, 32, 16, 6],
  lodDistances: [104, 176, 248, 320],
  // 裙边要足够深才能兜住相邻块的高度差。3 米时会在地形起伏大的地方
  // 露底，看起来就是地面上的一条黑缝——加到 12 米才稳。
  skirtDepth: 12,
}

/** 土路颜色：晒暖的夯土黄，比草地暗、比沙滩深 */
const ROAD_COLOR = new Color(0x9c7f56)

interface ChunkRecord {
  mesh: Mesh
  lod: number
}

/** 重建任务队列的元素 */
interface RebuildTask {
  cx: number
  cz: number
  lod: number
  key: string
}

export class ChunkedTerrain {
  readonly group: Group = new Group()
  readonly config: TerrainConfig

  private readonly hf: Heightfield
  private readonly chunks = new Map<string, ChunkRecord>()
  private readonly material: MeshLambertMaterial
  private pending: RebuildTask[] = []
  private pendingKeys = new Set<string>()
  private lastCenterX = Number.NaN
  private lastCenterZ = Number.NaN
  private sinceReplan = 0
  /** 统计：本帧实际重建了几块，用于观察流式加载是否跟得上 */
  lastRebuilt = 0

  constructor(
    hf: Heightfield,
    config: Partial<TerrainConfig> = {},
    /** 道路网络：路面顶点染土色。可选，没路的场景（测试）不传 */
    private readonly roads?: RoadNetwork,
  ) {
    this.hf = hf
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config }
    this.material = new MeshLambertMaterial({ vertexColors: true })
    this.group.name = 'terrain'
  }

  /** 当前已加载的块数 */
  get chunkCount(): number {
    return this.chunks.size
  }

  /** 待重建队列长度 */
  get queueLength(): number {
    return this.pending.length
  }

  private pickLod(distance: number): number {
    const d = this.config.lodDistances
    for (let i = 0; i < d.length; i++) {
      if (distance <= d[i]) return i
    }
    return d.length - 1
  }

  /**
   * 每帧调用。相机移动超过阈值或间隔够久时才重新规划块集合，
   * 避免每帧做上百次 Map 查找与距离计算。
   */
  update(cameraPos: Vector3, dt: number, budget = 1): void {
    this.sinceReplan += dt
    const dx = cameraPos.x - this.lastCenterX
    const dz = cameraPos.z - this.lastCenterZ
    const moved = !Number.isFinite(dx) || dx * dx + dz * dz > 16 * 16

    if (moved || this.sinceReplan > 0.5) {
      this.replan(cameraPos)
      this.lastCenterX = cameraPos.x
      this.lastCenterZ = cameraPos.z
      this.sinceReplan = 0
    }

    this.processQueue(budget)
    this.lastRebuilt = 0
  }

  private replan(cameraPos: Vector3): void {
    const { chunkSize, viewDistance } = this.config
    const ccx = Math.floor(cameraPos.x / chunkSize)
    const ccz = Math.floor(cameraPos.z / chunkSize)
    const radius = Math.ceil(viewDistance / chunkSize)

    const needed = new Set<string>()

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // 块中心到相机的水平距离
        const centerX = (ccx + dx + 0.5) * chunkSize
        const centerZ = (ccz + dz + 0.5) * chunkSize
        const dist = Math.hypot(centerX - cameraPos.x, centerZ - cameraPos.z)
        if (dist > viewDistance) continue

        const cx = ccx + dx
        const cz = ccz + dz
        const key = `${cx},${cz}`
        needed.add(key)

        const lod = this.pickLod(dist)
        const existing = this.chunks.get(key)
        if (!existing) {
          this.enqueue(cx, cz, lod, key)
        } else if (existing.lod !== lod) {
          this.enqueue(cx, cz, lod, key)
        }
      }
    }

    // 卸载离开范围的块
    for (const [key, record] of this.chunks) {
      if (!needed.has(key)) {
        this.group.remove(record.mesh)
        record.mesh.geometry.dispose()
        this.chunks.delete(key)
      }
    }

    // 丢弃不再需要的待办任务（相机掉头时很常见）
    if (this.pending.length > 0) {
      this.pending = this.pending.filter((t) => needed.has(t.key))
      this.pendingKeys = new Set(this.pending.map((t) => t.key))
    }

    // 近处的块优先重建，保证玩家脚下先成型
    this.pending.sort((a, b) => {
      const da = Math.hypot((a.cx + 0.5) * chunkSize - cameraPos.x, (a.cz + 0.5) * chunkSize - cameraPos.z)
      const db = Math.hypot((b.cx + 0.5) * chunkSize - cameraPos.x, (b.cz + 0.5) * chunkSize - cameraPos.z)
      return da - db
    })
  }

  private enqueue(cx: number, cz: number, lod: number, key: string): void {
    if (this.pendingKeys.has(key)) return
    this.pendingKeys.add(key)
    this.pending.push({ cx, cz, lod, key })
  }

  private processQueue(budget: number): void {
    let built = 0
    while (built < budget && this.pending.length > 0) {
      const task = this.pending.shift()!
      this.pendingKeys.delete(task.key)
      this.buildChunk(task)
      built++
    }
    this.lastRebuilt = built
  }

  private buildChunk(task: RebuildTask): void {
    const { cx, cz, lod, key } = task
    const segments = this.config.lodSegments[lod]
    const size = this.config.chunkSize

    // 换 LOD 时先释放旧几何
    const existing = this.chunks.get(key)
    if (existing) {
      this.group.remove(existing.mesh)
      existing.mesh.geometry.dispose()
      this.chunks.delete(key)
    }

    const geometry = this.buildGeometry(cx, cz, size, segments)
    const mesh = new Mesh(geometry, this.material)
    mesh.position.set(cx * size, 0, cz * size)
    mesh.castShadow = true
    mesh.receiveShadow = true
    // 让 three 用包围球做视锥剔除，避免手动判定
    geometry.computeBoundingSphere()

    this.group.add(mesh)
    this.chunks.set(key, { mesh, lod })
  }

  /**
   * 生成一块地形几何。
   *
   * 顶点布局：先是 (segments+1)² 个表面顶点，随后是四条边各自的裙边顶点。
   * 裙边顶点只复制一份（拓扑上位于对应表面顶点的正下方 skirtDepth），
   * 目的是从侧面遮住相邻块因 LOD 不同而产生的裂缝。
   */
  private buildGeometry(cx: number, cz: number, size: number, segments: number): BufferGeometry {
    const hf = this.hf
    const n = segments + 1
    const step = size / segments
    const originX = cx * size
    const originZ = cz * size

    // ── 第一步：采样高度网格，四周外扩 PAD 圈 ──
    //
    // 外扩是为了让法线差分在块的边界上也拿得到真实地形数据（见第三步）。
    // 没有这圈缓冲，边界顶点就只能靠块内单侧数据估算坡度，而邻居同样
    // 只看得到它那一侧，同一条边界上两边算出的法线能差几十度。
    const PAD = 4
    const ext = n + PAD * 2
    const heights = new Float32Array(ext * ext)
    for (let iy = 0; iy < ext; iy++) {
      const wz = originZ + (iy - PAD) * step
      for (let ix = 0; ix < ext; ix++) {
        heights[iy * ext + ix] = hf.height(originX + (ix - PAD) * step, wz)
      }
    }
    /** 取格点 (ix,iy) 的高度；ix/iy 允许越出 [0,n) 进入外扩区 */
    const at = (ix: number, iy: number): number => heights[(iy + PAD) * ext + (ix + PAD)]

    // ── 第二步：位置与配色 ──
    const surfaceCount = n * n
    const skirtCount = 4 * n
    const totalCount = surfaceCount + skirtCount

    const positions = new Float32Array(totalCount * 3)
    const colors = new Float32Array(totalCount * 3)
    const normals = new Float32Array(totalCount * 3)
    const color = new Color()

    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const idx = iy * n + ix
        const h = at(ix, iy)

        positions[idx * 3] = ix * step
        positions[idx * 3 + 1] = h
        positions[idx * 3 + 2] = iy * step

        // 配色用的坡度仍按块内差分：它只影响色彩分带，边界上的细微
        // 差异肉眼看不出来，没必要为它多花采样
        const hL = at(ix - 1, iy)
        const hR = at(ix + 1, iy)
        const hD = at(ix, iy - 1)
        const hU = at(ix, iy + 1)
        const dx = (hR - hL) / (2 * step)
        const dz = (hU - hD) / (2 * step)
        const slope = 1 - 1 / Math.sqrt(1 + dx * dx + dz * dz)

        // 群系配色：区域与高度一起决定这块地的颜色。
        // 染色强度在这里采一次（顶点世界坐标处），草地与散布读的
        // 是同一个函数，三方不会对不上
        const wx0 = originX + ix * step
        const wz0 = originZ + iy * step
        shadeVertex(h, slope, color, colorFactors(wx0, wz0, h))

        // 路面染色：离路中心线 2.3 米内染土色，边缘渐变。
        // 路是玩家的向导——它必须在草地上"读得出一条线"
        if (this.roads && this.roads.segmentCount > 0) {
          const rd = this.roads.distance(wx0, wz0)
          if (rd < 3.1) {
            const k = 1 - smoothstep01(rd, 1.6, 3.1)
            color.lerp(ROAD_COLOR, k * 0.72)
          }
        }

        // 加两个尺度的噪声扰动。
        //
        // 生物群系配色是按海拔和坡度算的连续函数，同一片草原会得到一模
        // 一样的绿——从空中看像刷了一层漆。真实的草地是斑驳的：有的地方
        // 干得发黄，有的地方湿得发青，其间还夹着细碎的杂色。大尺度那层
        // 摆动色相，小尺度那层加颗粒。
        const wx = originX + ix * step
        const wz = originZ + iy * step
        const tint = speckleNoise(wx * 0.031, wz * 0.031)
        color.r *= 1 + tint * 0.13
        color.b *= 1 - tint * 0.11
        color.g *= 1 + grainNoise(wx * 0.26, wz * 0.26) * 0.06

        // 地形自遮挡的粗略近似：低处被周围的山挡掉一部分天光，所以暗一些。
        // 真正的环境光遮蔽要在屏幕空间算，M1 上划不来；这里只用高度做一条
        // 明暗梯度，山谷和山顶就分得开了，起伏读起来立体得多
        color.multiplyScalar(0.9 + smoothstep01(h, WATER_LEVEL + 2, WATER_LEVEL + 52) * 0.18)

        colors[idx * 3] = color.r
        colors[idx * 3 + 1] = color.g
        colors[idx * 3 + 2] = color.b
      }
    }

    // ── 第三步：法线 ──
    //
    // 这里不能用 computeVertexNormals()。它按「块内」三角形的面法线累加，
    // 于是边界顶点只看到半个邻域，相邻两块各算各的——同一条边界上一边
    // 的法线可能朝上、另一边是斜的，光照在接缝处硬生生断开，从空中看
    // 就是一条贯穿地面的黑线（比 LOD 高度差本身显眼得多）。
    //
    // 换成只依赖世界坐标的中心差分：步长固定为 NORMAL_EPS 米，与块划分、
    // 与 LOD 级别都无关，于是边界两侧必然算出同一个法线，接缝处的光照
    // 天然连续。
    const NORMAL_EPS = 2.5
    // 以格点为单位表示同一个世界步长；最细的一级 LOD 是 1 米一格
    const d = NORMAL_EPS / step
    /** 格点坐标处的双线性插值高度，允许小数坐标 */
    const sampleGrid = (gx: number, gy: number): number => {
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      const h00 = at(x0, y0)
      const h10 = at(x0 + 1, y0)
      const h01 = at(x0, y0 + 1)
      const h11 = at(x0 + 1, y0 + 1)
      return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
    }

    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const idx = iy * n + ix
        // 必须走插值：d 通常是小数（最细一级 LOD 上是 2.5 格），
        // 直接拿它当数组下标会读到 undefined
        const gx = (sampleGrid(ix - d, iy) - sampleGrid(ix + d, iy)) / (2 * NORMAL_EPS)
        const gz = (sampleGrid(ix, iy - d) - sampleGrid(ix, iy + d)) / (2 * NORMAL_EPS)
        const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz)
        normals[idx * 3] = gx * inv
        normals[idx * 3 + 1] = inv
        normals[idx * 3 + 2] = gz * inv
      }
    }

    // ── 第三步：裙边顶点（位于边顶点的正下方） ──
    const skirtDepth = this.config.skirtDepth
    const skirtBase = surfaceCount
    let skirtWrite = skirtBase

    const writeSkirt = (ix: number, iy: number, tint: number) => {
      const src = iy * n + ix
      const dst = skirtWrite++
      positions[dst * 3] = positions[src * 3]
      positions[dst * 3 + 1] = positions[src * 3 + 1] - skirtDepth
      positions[dst * 3 + 2] = positions[src * 3 + 2]
      // 裙边取接近地表的颜色而不是压暗：它露出来的场合正是"遮缝"，
      // 调暗会从远处看到一条黑线（之前就是这个问题）。真正需要土色
      // 剖面的地方（悬崖断面）本来就看不见裙边。
      colors[dst * 3] = colors[src * 3] * tint
      colors[dst * 3 + 1] = colors[src * 3 + 1] * tint
      colors[dst * 3 + 2] = colors[src * 3 + 2] * tint
    }

    // 1.0：裙边必须和地表完全同色。它本来就是"地表的向下延伸"，
    // 任何压暗都会让它从远处显成一条暗带
    const SKIRT_TINT = 1.0
    for (let ix = 0; ix < n; ix++) writeSkirt(ix, 0, SKIRT_TINT) // 南
    for (let ix = 0; ix < n; ix++) writeSkirt(ix, segments, SKIRT_TINT) // 北
    for (let iy = 0; iy < n; iy++) writeSkirt(0, iy, SKIRT_TINT) // 西
    for (let iy = 0; iy < n; iy++) writeSkirt(segments, iy, SKIRT_TINT) // 东

    // ── 第四步：索引 ──
    const indices: number[] = []
    for (let iy = 0; iy < segments; iy++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = iy * n + ix
        const b = a + 1
        const c = a + n
        const d = c + 1
        // 与 PlaneGeometry 旋转后一致的朝向（从上方看为逆时针）
        indices.push(a, c, b, b, c, d)
      }
    }

    // 裙边索引，绕序保证法线朝块外
    // 南边：z 最小，法线朝 -z
    for (let ix = 0; ix < segments; ix++) {
      const top0 = ix
      const top1 = ix + 1
      const bot0 = skirtBase + ix
      const bot1 = skirtBase + ix + 1
      indices.push(top0, top1, bot1, top0, bot1, bot0)
    }
    // 北边
    const northBase = skirtBase + n
    const northTop = segments * n
    for (let ix = 0; ix < segments; ix++) {
      const top0 = northTop + ix
      const top1 = northTop + ix + 1
      const bot0 = northBase + ix
      const bot1 = northBase + ix + 1
      indices.push(top0, bot0, bot1, top0, bot1, top1)
    }
    // 西边：x 最小，法线朝 -x
    const westBase = skirtBase + 2 * n
    for (let iy = 0; iy < segments; iy++) {
      const top0 = iy * n
      const top1 = (iy + 1) * n
      const bot0 = westBase + iy
      const bot1 = westBase + iy + 1
      indices.push(top0, bot0, bot1, top0, bot1, top1)
    }
    // 东边：x 最大，法线朝 +x
    const eastBase = skirtBase + 3 * n
    for (let iy = 0; iy < segments; iy++) {
      const top0 = iy * n + segments
      const top1 = (iy + 1) * n + segments
      const bot0 = eastBase + iy
      const bot1 = eastBase + iy + 1
      indices.push(top0, top1, bot1, top0, bot1, bot0)
    }

    // 裙边顶点位于第三步填好的法线数组之后，这里补上它们的法线：
    // 裙边是竖直面，按真实几何法线它接不到照到地面的那束光，无论
    // 顶点色调多亮都会渲染成一条暗带。强行朝上之后，裙边和地表受光
    // 完全一致，"地表向下延伸了一截"这件事在视觉上就消失了。
    for (let i = surfaceCount; i < totalCount; i++) {
      normals[i * 3] = 0
      normals[i * 3 + 1] = 1
      normals[i * 3 + 2] = 0
    }

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    geometry.setAttribute('normal', new BufferAttribute(normals, 3))
    geometry.setIndex(indices)

    return geometry
  }

  /** 采样任意世界坐标的地面高度，供角色控制器与植被使用 */
  heightAt(x: number, z: number): number {
    return this.hf.height(x, z)
  }

  dispose(): void {
    for (const [, record] of this.chunks) {
      record.mesh.geometry.dispose()
    }
    this.chunks.clear()
    this.material.dispose()
  }
}

// 顶点配色统一走 heightfield.shadeVertex，避免同一套分带规则在两处各写一份

/**
 * 便宜的二维值噪声，返回 [-1, 1]。
 *
 * 地表扰动每个顶点要跑两次，用 fbm 那种多八度的噪声太贵。这里只需要
 * "平滑的随机"，一层双线性插值的 hash 格点就够，而且必须用 Math.imul——
 * 用 `*` 的话中间结果会越过 2^53，低位被抹平，噪声退化成一片一片的常数。
 */
function speckleNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const sx = fx * fx * (3 - 2 * fx)
  const sz = fz * fz * (3 - 2 * fz)
  const h00 = hash2(ix, iz)
  const h10 = hash2(ix + 1, iz)
  const h01 = hash2(ix, iz + 1)
  const h11 = hash2(ix + 1, iz + 1)
  return (h00 * (1 - sx) + h10 * sx) * (1 - sz) + (h01 * (1 - sx) + h11 * sx) * sz
}

/** 同上，但幅度收窄到 ±0.5，用作细颗粒 */
function grainNoise(x: number, z: number): number {
  return speckleNoise(x, z) * 0.5
}

/** 把 value 从 [edge0, edge1] 平滑映射到 [0, 1] */
function smoothstep01(value: number, edge0: number, edge1: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function hash2(ix: number, iz: number): number {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return (((n ^ (n >>> 16)) >>> 0) / 4294967296) * 2 - 1
}
