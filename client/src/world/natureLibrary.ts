/**
 * 外部自然素材库：把 Kenney Nature Kit 的 glTF 模型变成可批量烘焙的顶点色几何体。
 *
 * 为什么要走这一趟转换，而不是直接往场景里 add 模型：
 *
 * 1. **模型自带的是材质色，不是顶点色**。散布系统要把成百上千个物件合并进
 *    极少数几个几何体，合并的前提是所有几何体共用同一种材质——也就是必须有
 *    顶点色。这里把材质色烘进顶点色，之后整片森林就只是几个静态网格。
 *
 * 2. **原始配色是「桌面摆件」的配色**。Kenney 这套模型是给俯视小场景做的，
 *    树叶是青绿色、树皮是浅粉棕、石头几乎纯白。直接放进地形只会显得发灰
 *    发脏，所以这里统一重新调色，向 heightfield 的调色板靠拢。
 *
 * 3. **尺度差了 4 倍**。模型高 1–2 米，而世界里的树要在 6–9 米。这里按
 *    「目标高度」归一化，调用方只需要说「这棵树该有 7 米高」。
 *
 * 授权：Kenney Nature Kit 为 CC0（公有领域），可自由商用。
 * https://kenney.nl/assets/nature-kit
 */

import { Box3, BufferGeometry, Color, Float32BufferAttribute, Mesh, type Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * 材质名 → 目标颜色（sRGB）。
 *
 * Kenney 这套资源的材质命名很规整，按名字映射比按原始颜色值映射稳得多：
 * 同一个 `leafsGreen` 在几十个模型里颜色完全一致，改这一处就是全库生效。
 *
 * 颜色向 heightfield 的地表调色板靠：草是 grassLow/grassHigh 的绿，岩石是
 * rock/rockDark 的灰。花朵和蘑菇反过来——它们本来就该在满屏绿里跳出来，
 * 保留高饱和。
 */
const PALETTE: Record<string, number> = {
  // 树冠：阔叶偏黄绿、针叶偏深青绿，秋天变橙。
  // 比地表草色亮一档，树冠才会从草地背景里跳出来
  leafsGreen: 0x63a03c,
  leafsDark: 0x3c7a34,
  leafsFall: 0xdd8a30,
  // 地表植被
  grass: 0x5f9439,
  // 树干
  woodBark: 0x6d5137,
  woodBarkDark: 0x4f3928,
  woodBirch: 0xc4b69c,
  woodInner: 0xa5824f,
  // 岩石。Kenney 这套素材里 `rock_*` 是带草皮的土堆、`stone_*` 才是石头，
  // 但两种都当岩石撒。原本把 dirt 映射成深棕，结果草地上立着一堆深褐色
  // 的方锥，像帐篷不像石头——调成风化的灰棕，两类才能混成一片石滩
  stone: 0x8a8b85,
  dirt: 0x8d7f68,
  // 花朵与果实：高饱和，不向地表配色妥协
  colorRed: 0xd8453c,
  colorPurple: 0x9b6bd6,
  colorYellow: 0xf2c53d,
  colorTan: 0xdb9f56,
  // 兜底：白模。用途混杂（蘑菇菌柄、石头亮面、树梢），取中性浅灰最不容易出错
  _defaultMat: 0xada79b,
}

/** 单个素材模型的成品几何体 */
export interface NatureGeometry {
  name: string
  /** 已缩放到目标高度、底面贴合 y=0、带顶点色的几何体 */
  geometry: BufferGeometry
  /** 归一化后的世界高度（米） */
  height: number
  /** 水平半径（米），用于登记碰撞 */
  radius: number
  /** 三角形数，用于预算核算 */
  triangles: number
}

/** 加载请求：一个模型 + 期望的世界尺寸 */
export interface NatureRequest {
  /** 不含扩展名的文件名，位于 /assets/nature/ */
  name: string
  /** 期望的世界尺寸（米），含义由 fit 决定 */
  height: number
  /**
   * 按哪个维度归一化到 `height`。
   *
   * 默认按高度，但**扁平的模型必须按宽度**。Kenney 的 `rock_*` 是一坨坨
   * 压扁的土丘（原始尺寸高 0.26、宽 1.02，宽高比近 4），按高度缩放的话
   * 想要 1.5 米高就会得到 6 米宽——草原上会立起一排棕色的小山。这类
   * 模型还有石板、原木、篝火圈，都是同一个毛病。
   */
  fit?: 'height' | 'width'
}

/**
 * 从 GLB 里抽取几何体，重新着色并归一化。
 *
 * 失败时返回 null 而不是抛错：少一棵树不该让整个游戏起不来。
 */
export async function loadNatureGeometry(
  request: NatureRequest,
  loader?: GLTFLoader,
): Promise<NatureGeometry | null> {
  const gltfLoader = loader ?? new GLTFLoader()
  try {
    const gltf = await gltfLoader.loadAsync(`/assets/nature/${request.name}.glb`)
    const root = gltf.scene as Object3D
    // 世界矩阵必须先刷新：下面取几何体时要靠它把各部件摆到正确位置
    root.updateMatrixWorld(true)

    const parts: BufferGeometry[] = []
    root.traverse((child) => {
      const mesh = child as Mesh
      if (!mesh.isMesh) return

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const geometry = mesh.geometry as BufferGeometry
      const groups = geometry.groups

      // 一个 mesh 挂多个材质时，靠 groups 划分每个材质负责的三角形区间；
      // 只有一个材质时整块按它处理
      if (materials.length > 1 && groups.length > 0) {
        for (const group of groups) {
          const material = materials[group.materialIndex ?? 0]
          const piece = sliceGeometry(geometry, group.start, group.count)
          if (piece) parts.push(paintAndPlace(piece, material, mesh))
        }
      } else {
        const piece = geometry.clone()
        parts.push(paintAndPlace(piece, materials[0], mesh))
      }
    })

    if (parts.length === 0) {
      console.warn(`[素材] ${request.name} 里没有可用网格`)
      return null
    }

    const merged = mergeGeometries(parts, false)
    for (const p of parts) p.dispose()
    if (!merged) {
      console.warn(`[素材] ${request.name} 合并失败（属性不一致）`)
      return null
    }

    // 归一化：先缩放再重新测量，避免原始包围盒的浮点误差累积
    merged.computeBoundingBox()
    const box = merged.boundingBox!
    const rawHeight = box.max.y - box.min.y
    const rawWidth = Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
    const raw = request.fit === 'width' ? rawWidth : rawHeight
    const scale = request.height / Math.max(0.001, raw)
    merged.scale(scale, scale, scale)

    merged.computeBoundingBox()
    const fitted = merged.boundingBox!
    // 底面贴地：散布时直接把实例放到地表高度即可
    merged.translate(0, -fitted.min.y, 0)
    merged.computeBoundingBox()
    merged.computeBoundingSphere()

    const final = merged.boundingBox!
    const triangles = merged.index
      ? merged.index.count / 3
      : merged.attributes.position.count / 3

    return {
      name: request.name,
      geometry: merged,
      height: final.max.y - final.min.y,
      radius: Math.max(final.max.x - final.min.x, final.max.z - final.min.z) / 2,
      triangles,
    }
  } catch (err) {
    console.warn(`[素材] ${request.name} 加载失败：`, err)
    return null
  }
}

/** 批量加载，返回以模型名索引的映射。并发发起，总耗时取决于最慢的一个。 */
export async function loadNatureBatch(
  requests: readonly NatureRequest[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, NatureGeometry>> {
  const loader = new GLTFLoader()
  const result = new Map<string, NatureGeometry>()
  let done = 0

  await Promise.all(
    requests.map(async (req) => {
      const geo = await loadNatureGeometry(req, loader)
      done++
      onProgress?.(done, requests.length)
      if (geo) result.set(req.name, geo)
    }),
  )

  return result
}

/**
 * 从几何体里切出一段三角形。
 *
 * 多材质 mesh 在 glTF 里是「一个网格 + 若干 group」，每个 group 指向一段
 * 索引区间。要先按区间拆开、各自上色，再整体合并回去——否则整棵树只能用
 * 一个颜色。
 */
function sliceGeometry(
  source: BufferGeometry,
  start: number,
  count: number,
): BufferGeometry | null {
  if (count <= 0) return null
  const piece = source.clone()

  if (source.index) {
    // 有索引：只保留这一段索引，并重映射到本段用到的顶点
    const srcIndex = source.index
    const used = new Map<number, number>()
    const newIndex: number[] = []
    for (let i = start; i < start + count; i++) {
      const original = srcIndex.getX(i)
      let mapped = used.get(original)
      if (mapped === undefined) {
        mapped = used.size
        used.set(original, mapped)
      }
      newIndex.push(mapped)
    }

    for (const key of Object.keys(piece.attributes)) {
      piece.deleteAttribute(key)
    }
    for (const [key, attr] of Object.entries(source.attributes)) {
      const array = attr.array as ArrayLike<number>
      const itemSize = attr.itemSize
      const packed = new Float32Array(used.size * itemSize)
      for (const [original, mapped] of used) {
        for (let c = 0; c < itemSize; c++) {
          packed[mapped * itemSize + c] = array[original * itemSize + c] ?? 0
        }
      }
      piece.setAttribute(key, new Float32BufferAttribute(packed, itemSize))
    }
    piece.setIndex(newIndex)
    return piece
  }

  // 无索引：按顶点区间直接裁
  const from = start
  const to = start + count
  for (const key of Object.keys(piece.attributes)) {
    piece.deleteAttribute(key)
  }
  for (const [key, attr] of Object.entries(source.attributes)) {
    const array = attr.array as ArrayLike<number>
    const itemSize = attr.itemSize
    const packed = new Float32Array((to - from) * itemSize)
    for (let i = from; i < to; i++) {
      for (let c = 0; c < itemSize; c++) {
        packed[(i - from) * itemSize + c] = array[i * itemSize + c] ?? 0
      }
    }
    piece.setAttribute(key, new Float32BufferAttribute(packed, itemSize))
  }
  return piece
}

/**
 * 给一段几何体刷上材质对应的颜色，并摆到它在模型里的位置。
 *
 * 顶点色而不是材质色，是为了之后能把任意多个模型合并成一个几何体。
 */
function paintAndPlace(
  geometry: BufferGeometry,
  material: { name?: string; color?: Color } | undefined,
  mesh: Mesh,
): BufferGeometry {
  const name = material?.name ?? ''
  const target = new Color(PALETTE[name] ?? PALETTE._defaultMat)

  // 未知材质名时退回原始颜色，至少不会把模型刷成一片灰
  if (!(name in PALETTE) && material?.color) {
    target.copy(material.color)
  }

  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = target.r
    colors[i * 3 + 1] = target.g
    colors[i * 3 + 2] = target.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))

  // 合并要求所有几何体属性一致：UV 用不上（没有贴图），留着反而会因为
  // 部分模型缺 UV 而合并失败
  geometry.deleteAttribute('uv')
  geometry.deleteAttribute('uv1')
  geometry.deleteAttribute('uv2')
  geometry.deleteAttribute('tangent')
  geometry.deleteAttribute('skinIndex')
  geometry.deleteAttribute('skinWeight')

  geometry.applyMatrix4(mesh.matrixWorld)
  return geometry
}

/** 量一下模型合并后的包围盒，用于挑选素材（离线分析用） */
export function measure(geometry: BufferGeometry): Box3 {
  geometry.computeBoundingBox()
  return geometry.boundingBox!.clone()
}
