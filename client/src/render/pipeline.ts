/**
 * 渲染管线封装。
 *
 * 这一层是「怎么画」，与「画什么」（world / terrain）严格分离——
 * 将来若要从 WebGL2 切到 WebGPU，改动应局限在本文件内。
 *
 * 性能上最大的两个杠杆——像素比（分辨率缩放）与后处理开关——
 * 都在这里暴露成可调项，因为 M1 的填充率是硬瓶颈。
 */

import {
  ACESFilmicToneMapping,
  PCFSoftShadowMap,
  Vector2,
  type Camera,
  type Scene,
  WebGLRenderer,
} from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import type { RenderInfo } from '../core/perf.ts'

export interface RenderSettings {
  /** 渲染分辨率倍率。1.0 = CSS 像素 1:1；Mac 上 devicePixelRatio 为 2，直接跟随会让填充率翻 4 倍。 */
  pixelRatio: number
  shadows: boolean
  shadowMapSize: number
  bloom: boolean
  bloomStrength: number
  /**
   * 色调映射曝光。物理天空的散射亮度很高，ACES 在 1.0 曝光下会把
   * 天空压成灰白一片，必须调低。这个值直接决定整个画面的明暗基调。
   */
  exposure: number
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  pixelRatio: 1,
  shadows: true,
  shadowMapSize: 2048,
  bloom: true,
  bloomStrength: 0.35,
  exposure: 0.55,
}

export class RenderPipeline {
  readonly renderer: WebGLRenderer
  readonly settings: RenderSettings

  private composer: EffectComposer | null = null
  private renderPass: RenderPass | null = null
  private bloomPass: UnrealBloomPass | null = null
  private scene: Scene
  private camera: Camera
  private width = 1
  private height = 1

  constructor(canvas: HTMLCanvasElement, scene: Scene, camera: Camera, settings?: Partial<RenderSettings>) {
    this.scene = scene
    this.camera = camera
    this.settings = { ...DEFAULT_RENDER_SETTINGS, ...settings }

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // MSAA 由后处理链或 FXAA 替代；M1 上 MSAA 8x 代价过高
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    })
    // 兜底清除色取天空的近似色：万一天空球被裁剪或尚未加载，
    // 背景也是天色而不是刺眼的纯黑
    this.renderer.setClearColor(0xb9cfe2, 1)
    this.renderer.setPixelRatio(this.settings.pixelRatio)
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = this.settings.exposure
    this.renderer.shadowMap.enabled = this.settings.shadows
    this.renderer.shadowMap.type = PCFSoftShadowMap
    this.renderer.shadowMap.autoUpdate = true

    // 关掉自动重置：EffectComposer 每帧会调用多次 renderer.render()，
    // 每次都会清空统计，导致读到的永远是最后一个全屏 pass 的数据
    // （表现为 draw call 恒为 1、三角形恒为 0）。改为每帧手动重置一次，
    // 让整帧所有 pass 的开销累积起来。
    this.renderer.info.autoReset = false

    this.buildComposer()
  }

  private buildComposer(): void {
    this.renderPass = new RenderPass(this.scene, this.camera)
    const composer = new EffectComposer(this.renderer)
    composer.addPass(this.renderPass)

    // UnrealBloom 在 M1 上开销可观（多次降采样 + 全屏叠加），因此做成可关闭项
    this.bloomPass = new UnrealBloomPass(
      new Vector2(this.width, this.height), // 实际分辨率在 setSize 时会被覆盖
      this.settings.bloomStrength,
      0.6, // radius
      0.85, // threshold：只让高光溢出，避免整个画面发糊
    )
    this.bloomPass.enabled = this.settings.bloom
    composer.addPass(this.bloomPass)

    // OutputPass 负责色调映射与 sRGB 输出，必须放在链尾
    composer.addPass(new OutputPass())

    composer.setPixelRatio(this.settings.pixelRatio)
    this.composer = composer
  }

  setSize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.renderer.setSize(width, height, false)
    this.composer?.setSize(width, height)
    this.bloomPass?.setSize(width, height)
  }

  setPixelRatio(ratio: number): void {
    this.settings.pixelRatio = ratio
    this.renderer.setPixelRatio(ratio)
    this.composer?.setPixelRatio(ratio)
  }

  setShadows(enabled: boolean): void {
    this.settings.shadows = enabled
    this.renderer.shadowMap.enabled = enabled
    // 切换阴影后所有材质需要重新编译，强制标记一次
    this.scene.traverse((obj) => {
      const mesh = obj as { material?: { needsUpdate: boolean } | { needsUpdate: boolean }[] }
      if (!mesh.material) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) m.needsUpdate = true
    })
  }

  setBloom(enabled: boolean): void {
    this.settings.bloom = enabled
    if (this.bloomPass) this.bloomPass.enabled = enabled
  }

  setBloomStrength(strength: number): void {
    this.settings.bloomStrength = strength
    if (this.bloomPass) this.bloomPass.strength = strength
  }

  setExposure(value: number): void {
    this.settings.exposure = value
    this.renderer.toneMappingExposure = value
  }

  render(): void {
    // 手动重置统计，累积本帧所有 pass 的工作量（见构造函数里的说明）
    this.renderer.info.reset()

    // 关闭 bloom 时绕过 composer，省掉一次全屏拷贝
    if (this.composer && this.bloomPass?.enabled) {
      this.composer.render()
    } else {
      this.renderer.render(this.scene, this.camera)
    }
  }

  get info(): RenderInfo {
    const r = this.renderer.info
    return {
      calls: r.render.calls,
      triangles: r.render.triangles,
      programs: r.programs?.length ?? 0,
    }
  }

  dispose(): void {
    this.composer?.dispose()
    this.renderer.dispose()
  }
}
