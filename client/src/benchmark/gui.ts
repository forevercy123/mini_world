/**
 * 参数面板。
 *
 * 面板里只放会被频繁调整的开关，不放实时读数——lil-gui 的自动刷新
 * 每帧都要碰 DOM，会污染正在测量的帧率。状态信息统一走 HUD。
 */

import GUI from 'lil-gui'
import type { RenderPipeline } from '../render/pipeline.ts'
import type { FlyController } from '../core/flyControls.ts'
import type { BenchmarkWorld } from './world.ts'

export interface GuiState {
  /** true = 第三人称角色控制；false = 自由飞行（调试/巡检） */
  playMode: boolean
  pixelRatio: number
  shadows: boolean
  shadowMapSize: number
  bloom: boolean
  bloomStrength: number
  exposure: number
  viewDistance: number
  treeCount: number
  speed: number
  groundFollow: boolean
  /** 当前时刻 0–24，拖动它会自动暂停时间推进 */
  timeOfDay: number
  autoAdvance: boolean
  dayLength: number
  /** 风的摆动幅度 */
  windStrength: number
  /** 音效音量 0–1 */
  soundVolume: number
}

export interface GuiActions {
  runBenchmark: () => void
  exportReport: () => void
  resetCamera: () => void
  toggleHUD: () => void
  /** 切换控制模式，true = 角色模式 */
  setMode: (play: boolean) => void
  setSoundVolume: (v: number) => void
}

/** 三档预设，用于快速比较不同画质档的帧率差距 */
const PRESETS: Record<string, Partial<GuiState>> = {
  '低配（无阴影无泛光）': { pixelRatio: 0.75, shadows: false, bloom: false },
  '中配（1024阴影）': { pixelRatio: 1, shadows: true, shadowMapSize: 1024, bloom: true },
  '高配（1.5x+2048阴影）': { pixelRatio: 1.5, shadows: true, shadowMapSize: 2048, bloom: true },
}

export function createGui(
  pipeline: RenderPipeline,
  world: BenchmarkWorld,
  controller: FlyController,
  actions: GuiActions,
  state: GuiState,
): GUI {
  const gui = new GUI({ title: '阶段 0 · 性能摸底', width: 296 })

  // ── 渲染 ──
  const renderFolder = gui.addFolder('渲染')
  renderFolder
    .add(state, 'pixelRatio', 0.5, 2, 0.05)
    .name('分辨率倍率')
    .onChange((v: number) => pipeline.setPixelRatio(v))
  renderFolder
    .add(state, 'shadows')
    .name('阴影')
    .onChange((v: boolean) => {
      pipeline.setShadows(v)
      world.setShadows(v)
    })
  renderFolder
    .add(state, 'shadowMapSize', [512, 1024, 2048, 4096])
    .name('阴影贴图')
    .onChange((v: number) => world.setShadowMapSize(v))
  renderFolder.add(state, 'bloom').name('泛光 Bloom').onChange((v: boolean) => pipeline.setBloom(v))
  renderFolder
    .add(state, 'bloomStrength', 0, 1.5, 0.05)
    .name('泛光强度')
    .onChange((v: number) => pipeline.setBloomStrength(v))
  renderFolder
    .add(state, 'exposure', 0.2, 1.5, 0.05)
    .name('曝光')
    .onChange((v: number) => pipeline.setExposure(v))

  // ── 世界 ──
  const worldFolder = gui.addFolder('世界')
  worldFolder
    .add(state, 'soundVolume', 0, 1, 0.05)
    .name('音效音量')
    .onChange((v: number) => actions.setSoundVolume(v))
  worldFolder
    .add(state, 'viewDistance', 128, 768, 32)
    .name('视距 (米)')
    .onChange((v: number) => world.setViewDistance(v))
  worldFolder
    .add(state, 'treeCount', 0, 4000, 100)
    // 换外部素材后这一项管的是全部散布物（树 + 灌木 + 岩石 + 花草），
    // 不再只是树
    .name('散布物件数')
    // 重建植被有几十毫秒开销，用 onChange 会在拖动时卡顿，所以收尾才应用
    .onFinishChange((v: number) => world.setTreeCount(v))

  // ── 时间 ──
  const timeFolder = gui.addFolder('时间与天气')
  timeFolder
    .add(state, 'timeOfDay', 0, 24, 0.1)
    .name('时刻')
    .onChange((v: number) => {
      // 手动拨时间就暂停自动推进，否则刚拖完就被时钟推走，很别扭
      world.dayCycle.config.autoAdvance = false
      state.autoAdvance = false
      world.dayCycle.setHour(v)
      gui.controllersRecursive().forEach((c) => c.updateDisplay())
    })
  timeFolder
    .add(state, 'autoAdvance')
    .name('时间自动推进')
    .onChange((v: boolean) => {
      world.dayCycle.config.autoAdvance = v
    })
  timeFolder
    .add(state, 'dayLength', 60, 1800, 30)
    .name('一天时长(秒)')
    .onChange((v: number) => {
      world.dayCycle.config.dayLength = v
    })
  timeFolder
    .add(state, 'windStrength', 0, 0.8, 0.02)
    .name('风力')
    .onChange((v: number) => world.vegetation.setWindStrength(v))
  timeFolder.open()

  // ── 操控 ──
  const camFolder = gui.addFolder('操控')
  camFolder
    .add(state, 'playMode')
    .name('角色模式')
    .onChange((v: boolean) => actions.setMode(v))
  camFolder.add(state, 'speed', 4, 120, 1).name('飞行速度').onChange((v: number) => {
    controller.speed = v
  })
  camFolder.add(state, 'groundFollow').name('飞行贴地').onChange((v: boolean) => {
    controller.groundFollow = v
  })
  camFolder.add(actions, 'resetCamera').name('重置视角')
  camFolder.open()

  // ── 预设 ──
  const presetFolder = gui.addFolder('画质预设')
  for (const [name, patch] of Object.entries(PRESETS)) {
    presetFolder
      .add(
        {
          apply: () => {
            Object.assign(state, patch)
            pipeline.setPixelRatio(state.pixelRatio)
            pipeline.setBloom(state.bloom)
            if (patch.shadowMapSize) world.setShadowMapSize(patch.shadowMapSize)
            pipeline.setShadows(state.shadows)
            world.setShadows(state.shadows)
            gui.controllersRecursive().forEach((c) => c.updateDisplay())
          },
        },
        'apply',
      )
      .name(name)
  }

  // ── 测量 ──
  const benchFolder = gui.addFolder('性能测量')
  benchFolder.add(actions, 'runBenchmark').name('▶ 开始自动巡检')
  benchFolder.add(actions, 'exportReport').name('⬇ 导出报告')
  benchFolder.add(actions, 'toggleHUD').name('显示/隐藏 HUD')
  benchFolder.open()

  return gui
}
