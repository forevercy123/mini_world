/**
 * 卡通渲染（三渲二）工具：色调阶 + 轮廓描边。
 *
 * 塞尔达式"精细感"的一半来自渲染而不是模型：同样一个低多边形
 * 角色，Lambert 的连续明暗让它像个橡皮泥，换成**阶跃色调 + 深色
 * 轮廓线**之后立刻有了"画出来"的利落感。这也是为什么换更贵的
 * 模型之前必须先做这一步——它是所有角色通用的放大器。
 *
 * 两件套：
 *  - `toonify(material)`：把 Lambert 换成 MeshToonMaterial（3 阶渐变），
 *    保留贴图与颜色，顺手把高光压掉
 *  - `addOutline(root, thickness)`：给 root 下的每个 Mesh 克隆一个
 *    背面外扩的黑色轮廓壳。SkinnedMesh 的轮廓壳共享同一副骨架，
 *    所以动画照样驱动——这是 InvertedHull 在骨骼模型上的关键一步
 */

import {
  BackSide,
  Color,
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  RedFormat,
  SkinnedMesh,
  type Material,
  type Texture,
} from 'three'

/** 3 阶渐变贴图：暗部 25% / 中间 55% / 亮部 100%。Nearest 才有阶跃感 */
let cachedGradient: DataTexture | null = null
function gradientMap(): DataTexture {
  if (!cachedGradient) {
    const data = new Uint8Array([64, 140, 255])
    cachedGradient = new DataTexture(data, 3, 1, RedFormat)
    cachedGradient.minFilter = NearestFilter
    cachedGradient.magFilter = NearestFilter
    cachedGradient.needsUpdate = true
  }
  return cachedGradient
}

/**
 * Lambert → Toon。贴图、颜色、emissive（敌人闪白要用）都保留。
 * 返回的新材质需要替换回原 mesh——调用方负责赋值。
 */
export function toonify(source: Material): MeshToonMaterial {
  const old = source as unknown as {
    color?: Color
    map?: Texture | null
    emissive?: Color
    vertexColors?: boolean
    transparent?: boolean
    opacity?: number
  }
  const mat = new MeshToonMaterial({
    color: old.color ? old.color.clone() : new Color(0xffffff),
    map: old.map ?? null,
    gradientMap: gradientMap(),
    vertexColors: old.vertexColors ?? false,
    transparent: old.transparent ?? false,
    opacity: old.opacity ?? 1,
  })
  if (old.emissive) mat.emissive.copy(old.emissive)
  return mat
}

/** 共享的描边材质：背面黑壳，顶点沿法线外扩。厚度注入在 shader 里 */
let cachedOutlineMaterial: MeshBasicMaterial | null = null
function outlineMaterial(): MeshBasicMaterial {
  if (!cachedOutlineMaterial) {
    cachedOutlineMaterial = new MeshBasicMaterial({
      color: 0x1a1512,
      side: BackSide,
    })
    // 沿法线外扩：用 onBeforeCompile 把厚度常量写进顶点着色器。
    // 骨骼模型的 normal 已随蒙皮变形，外扩方向天然正确
    cachedOutlineMaterial.onBeforeCompile = (shader: { vertexShader: string }) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         transformed += normalize(objectNormal) * ${OUTLINE_THICKNESS};`,
      )
    }
  }
  return cachedOutlineMaterial
}

/** 描边厚度（米）。按角色身高 ~1.75m 标定：0.004m 是"一笔"的宽度，
 *  远看是利落轮廓、近看又不会糊成一团 */
const OUTLINE_THICKNESS = '0.004'

/**
 * 给一棵角色树加上描边。
 *
 * 骨骼模型必须新起 SkinnedMesh 并 bind 同一副骨架——只克隆 Mesh
 * 的话轮廓壳不会跟着动画动，会是一个静止的黑壳挂在原地。
 *
 * @param root 角色根节点（遍历它下面的全部 Mesh）
 * @param filter 可选：只给符合条件的 mesh 加（比如跳过武器）
 */
export function addOutline(root: Object3D, filter?: (mesh: Mesh) => boolean): void {
  const material = outlineMaterial()
  const jobs: Array<{ mesh: Mesh; outline: Mesh }> = []

  root.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    if (filter && !filter(mesh)) return

    if ((mesh as SkinnedMesh).isSkinnedMesh) {
      const skinned = mesh as SkinnedMesh
      const outline = new SkinnedMesh(skinned.geometry, material)
      outline.bind(skinned.skeleton, skinned.bindMatrix)
      outline.frustumCulled = false
      jobs.push({ mesh, outline })
    } else {
      const outline = new Mesh(mesh.geometry, material)
      outline.frustumCulled = mesh.frustumCulled
      jobs.push({ mesh, outline })
    }
  })

  // 统一挂到各自 mesh 的父节点下、紧跟在原 mesh 后面，
  // 保证局部变换（缩放/位置）与原件一致
  for (const { mesh, outline } of jobs) {
    outline.position.copy(mesh.position)
    outline.quaternion.copy(mesh.quaternion)
    outline.scale.copy(mesh.scale)
    outline.castShadow = false
    outline.receiveShadow = false
    mesh.parent?.add(outline)
  }
}
