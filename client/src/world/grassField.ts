/**
 * 草叶层。
 *
 * 3D 场景里"像不像草原"几乎全由这一层决定。之前地面只有顶点色，
 * 走上去像踩在一块刷了绿漆的地毯上——没有草叶就没有尺度参照，
 * 再多的树也救不回来。
 *
 * 性能上做了三件事：
 *
 * 1. **每簇只有 3 个三角形**（3 片叶子，每片一个三角面）。一万簇也才
 *    三万面，对预算毫无压力。
 * 2. **只生成在真正长草的地方**：水边、陡坡、雪线以上都不放，
 *    省下来的配额全部用在玩家真会看到的地方。
 * 3. **风动用注入顶点着色器实现**，不是每帧改矩阵。一万个实例每帧
 *    重算矩阵会直接吃光 CPU 预算，而着色器里几行 sin 几乎不要钱。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'

export interface GrassConfig {
  /** 单块的边长（米） */
  chunkSize: number
  /** 覆盖半径（块数）。总共 (2r+1)² 块跟着关注点走 */
  chunkRadius: number
  /** 密度（簇/平方米） */
  density: number
  /** 每簇的叶子高度范围 */
  minHeight: number
  maxHeight: number
  seed: number
}

export const DEFAULT_GRASS: GrassConfig = {
  // 分块而不是一整片。
  //
  // 原来是一块 150 米见方的固定草场，落在原点。玩家跑出 75 米就走出草地，
  // 脚下突然变回光秃秃的顶点色，而那里离视距边缘还有两百多米——走着走着
  // 草没了，比一开始就没有草更出戏。
  //
  // 现在按块铺：40 米一块，7×7 块跟着关注点走，覆盖 280 米。块级剔除能
  // 生效（原来整片共用一个 InstancedMesh，包围球覆盖全图，剔除等于没有），
  // 所以总簇数涨了，实际画出来的反而少了。
  chunkSize: 44,
  // 覆盖 ±88 米，25 块。再远就看不清草叶了，多铺出去的块只是在烧三角形
  chunkRadius: 2,
  density: 0.7,
  // 从 0.34–0.66 压低到 0.26–0.48。半米高的草会把一米五的骷髅敌人挡得
  // 只剩一个头顶，站在稍远的地方根本看不出前面有东西——草是背景，
  // 不该盖过要打的目标
  minHeight: 0.26,
  maxHeight: 0.48,
  seed: 4242,
}

/** 每帧最多新建几块。建一块约 2ms，给多了会在跑动时掉帧 */
const BUILD_BUDGET_PER_FRAME = 2

interface GrassChunk {
  mesh: InstancedMesh
  cx: number
  cz: number
}

export class GrassField {
  readonly group = new Group()
  private readonly material: MeshBasicMaterial
  private readonly geometry: BufferGeometry
  private readonly chunks = new Map<string, GrassChunk>()
  private readonly windTime = { value: 0 }
  private readonly windStrength = { value: 0.5 }
  private readonly windSpeed = { value: 1 }
  private windPhase = 0
  private actualTufts = 0

  constructor(
    private readonly hf: Heightfield,
    config: Partial<GrassConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_GRASS, ...config }
    this.group.name = 'grass'

    this.geometry = createTuftGeometry()

    // 用不受光照的材质。草是竖直薄片，DoubleSide 会让背面的法线被翻转
    // 朝下，那些叶子就完全不受光、渲染成一丛黑刺（第一版就是这样）。
    // 保持单面几何又想要双面可见，最省事的做法是让明暗完全由顶点色决定。
    this.material = new MeshBasicMaterial({
      vertexColors: true,
      side: DoubleSide,
    })
    this.installWind()
  }

  private readonly cfg: GrassConfig

  /** 按块生成：块内先撒候选点，过滤掉不该长草的地方，再逐实例填矩阵 */
  private buildChunk(cx: number, cz: number): void {
    const cfg = this.cfg
    const size = cfg.chunkSize
    const originX = cx * size
    const originZ = cz * size

    // 每块用自己的种子，保证同一块无论何时重建都长得一模一样；
    // 用全局种子的话，块卸载重建一次草就换了个位置，玩家跑个来回能看出来
    const rng = mulberry32(chunkSeed(cfg.seed, cx, cz))

    const expected = size * size * cfg.density
    // 抖动网格：格距由目标数量反推。用网格而不是纯随机撒点，
    // 是为了避免随机聚集留下秃斑
    const spacing = Math.sqrt((size * size) / Math.max(1, expected))
    const grid = Math.max(1, Math.round(size / spacing))

    const placements: Array<{ x: number; y: number; z: number; rot: number; scale: number; height: number }> = []

    for (let iz = 0; iz < grid; iz++) {
      for (let ix = 0; ix < grid; ix++) {
        const x = originX + (ix + rng()) * spacing
        const z = originZ + (iz + rng()) * spacing

        const h = this.hf.height(x, z)
        // 沙滩上不长草。
        //
        // 门槛必须和地形配色的分带对齐：heightfield 里 rel 从 0.5 到 4 米
        // 是沙滩过渡到草地，而这里原来只要求 rel > 0.6——于是整条沙滩被
        // 判成"可以长草"。从远处看岸边是干净的沙，走过去却突然全长满草，
        // 比一开始就不长草更出戏。
        if (h < WATER_LEVEL + 3.2) continue
        // 雪线以上不长草
        if (h > 78) continue
        if (this.hf.slope(x, z) > 0.62) continue

        const scale = 0.8 + rng() * 0.5
        const height = cfg.minHeight + rng() * (cfg.maxHeight - cfg.minHeight)
        placements.push({ x, y: h, z, rot: rng() * Math.PI * 2, scale, height })
      }
    }

    if (placements.length === 0) return

    const mesh = new InstancedMesh(this.geometry, this.material, placements.length)
    // 不受光照的材质，阴影对草没有意义
    mesh.castShadow = false
    mesh.receiveShadow = false

    const matrix = new Matrix4()
    const position = new Vector3()
    const quaternion = new Quaternion()
    const scaleVec = new Vector3()
    const color = new Color()
    const up = new Vector3(0, 1, 0)

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]
      position.set(p.x, p.y, p.z)
      quaternion.setFromAxisAngle(up, p.rot)
      scaleVec.set(p.scale, p.height, p.scale)
      matrix.compose(position, quaternion, scaleVec)
      mesh.setMatrixAt(i, matrix)

      // 每簇的色调略有差异，整片草地才不会像一块均匀的绿布
      const tint = 0.82 + rng() * 0.36
      color.setRGB(tint * 0.95, tint, tint * 0.88)
      mesh.setColorAt(i, color)
    }

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    // 分块之后包围球才有意义：一块只覆盖 40 米，视锥剔除终于能生效
    mesh.computeBoundingSphere()

    this.group.add(mesh)
    this.chunks.set(`${cx},${cz}`, { mesh, cx, cz })
    this.actualTufts += placements.length
  }

  /** 把覆盖范围挪到关注点周围，缺的补、远的删 */
  private ensureChunks(center: Vector3): void {
    const size = this.cfg.chunkSize
    const r = this.cfg.chunkRadius
    const baseX = Math.round(center.x / size)
    const baseZ = Math.round(center.z / size)

    const needed = new Set<string>()
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        needed.add(`${baseX + dx},${baseZ + dz}`)
      }
    }

    for (const [key, chunk] of this.chunks) {
      if (needed.has(key)) continue
      this.group.remove(chunk.mesh)
      this.actualTufts -= chunk.mesh.count
      chunk.mesh.dispose()
      this.chunks.delete(key)
    }

    let budget = BUILD_BUDGET_PER_FRAME
    // 近处的块优先：玩家脚下先长出草，远处晚一两帧看不出来
    const missing: Array<{ cx: number; cz: number; d: number }> = []
    for (const key of needed) {
      if (this.chunks.has(key)) continue
      const [cx, cz] = key.split(',').map(Number)
      missing.push({ cx, cz, d: (cx - baseX) ** 2 + (cz - baseZ) ** 2 })
    }
    missing.sort((a, b) => a.d - b.d)

    for (const m of missing) {
      if (budget-- <= 0) break
      this.buildChunk(m.cx, m.cz)
    }
  }

  /** 与树木同一套做法：往标准材质里注入风摆，保留完整光照与阴影 */
  private installWind(): void {
    this.material.onBeforeCompile = (shader: { uniforms: Record<string, unknown>; vertexShader: string }) => {
      shader.uniforms.uWindTime = this.windTime
      shader.uniforms.uWindStrength = this.windStrength
      shader.uniforms.uWindSpeed = this.windSpeed

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uWindTime;
          uniform float uWindStrength;
          uniform float uWindSpeed;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          // 只让叶尖摆动：底部贴地不能动，否则会看到草从土里平移
          float tipWeight = clamp(transformed.y / 0.45, 0.0, 1.0);
          tipWeight *= tipWeight;
          #ifdef USE_INSTANCING
            float phase = instanceMatrix[3].x * 0.42 + instanceMatrix[3].z * 0.37;
          #else
            float phase = 0.0;
          #endif
          // 两个频率叠加，摆起来比单一正弦更碎、更像风过草地
          float sway = sin(uWindTime * uWindSpeed * 1.9 + phase);
          sway += sin(uWindTime * uWindSpeed * 3.7 + phase * 1.9) * 0.45;
          transformed.x += sway * uWindStrength * tipWeight * 0.16;
          transformed.z += sway * uWindStrength * tipWeight * 0.1;`,
        )
    }
  }

  /**
   * @param center 关注点（游玩时是角色，飞行时是相机）。草场跟着它走，
   *   走到哪里脚下都有草
   */
  update(dt: number, center?: Vector3): void {
    this.windPhase += dt
    this.windTime.value = this.windPhase
    if (center) this.ensureChunks(center)
  }

  setWindStrength(strength: number): void {
    // 草的摆动幅度比树敏感，这里按比例缩放而不是直接赋值
    this.windStrength.value = strength * 2.3
  }

  get tuftCount(): number {
    return this.actualTufts
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.mesh)
      chunk.mesh.dispose()
    }
    this.chunks.clear()
    this.actualTufts = 0
    this.geometry.dispose()
    this.material.dispose()
  }
}

/**
 * 一簇草：四片叶子绕中心散开。
 *
 * 顶点色从根部深绿渐变到尖端浅绿——这个渐变是草看起来有生机的关键，
 * 单一颜色的草会像插在地上的塑料片。叶尖用两种绿交替，是为了让一根
 * 簇内部就有层次，不必依赖实例色调。
 */
function createTuftGeometry(): BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const normals: number[] = []

  // 比地面顶点色更亮一档：和地面同色的话，草叶会隐进地里看不出来
  const rootColor = new Color(0x3d6b2a)
  // 两档叶尖色。一根簇里混着深浅两种绿，整片草地才不会像刷了同一桶漆
  const tipLight = new Color(0x9ed162)
  const tipDark = new Color(0x6aa841)
  const halfWidth = 0.05
  const bladeCount = 4

  for (let b = 0; b < bladeCount; b++) {
    // 起始角偏一点，四片叶子才不会连成一个正十字
    const angle = (b / bladeCount) * Math.PI * 2 + 0.45
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    // 每片叶子的高度和倾斜都不同。完全一致的叶子看起来像一排栅栏，
    // 而不是一丛草。取值走整数运算，保证每次生成的草场完全一致
    const h = 0.7 + (((b * 37) % 11) / 11) * 0.45
    const lean = 0.14 + (((b * 53) % 7) / 7) * 0.24

    // 底边两点
    const baseL = [-halfWidth * cos, 0, -halfWidth * sin]
    const baseR = [halfWidth * cos, 0, halfWidth * sin]
    // 叶尖
    const tip = [cos * lean, h, sin * lean]

    positions.push(...baseL, ...baseR, ...tip)
    // 根部深、尖端浅
    colors.push(rootColor.r, rootColor.g, rootColor.b)
    colors.push(rootColor.r, rootColor.g, rootColor.b)
    const tipColor = b % 2 === 0 ? tipLight : tipDark
    colors.push(tipColor.r, tipColor.g, tipColor.b)
    // 法线一律朝上：草是薄片，用真实面法线会在正午变成一片死黑
    for (let i = 0; i < 3; i++) normals.push(0, 1, 0)
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  return geo
}

/**
 * 每块草地的独立种子。
 *
 * 必须是纯函数：块被卸载后重建时要长得一模一样，否则玩家跑个来回，
 * 身后那片草的形状就换了样。
 */
function chunkSeed(base: number, cx: number, cz: number): number {
  return (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ base) >>> 0
}

/** 确定性伪随机，保证每次生成的草场一致 */
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
