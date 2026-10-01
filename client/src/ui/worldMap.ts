/**
 * 大地图覆盖层：点小地图打开，可切换三种缩放级别。
 *
 * 复用 minimap 的配色与绘制函数，两张图的观感因此一致——各写一套迟早
 * 会出现"同一片湖在两处颜色不同"的问题。
 *
 * 地形底图在**打开或切换缩放时**才重新采样。96×96 要跑九千多次噪声查询，
 * 每帧做一次是不可接受的；而这些数据只在范围变化时失效，平时原地重绘
 * 标记就够了。
 */

import { drawMap, colorForHeight, type MinimapMarkers } from './minimap.ts'
import type { Heightfield } from '../terrain/heightfield.ts'

const RESOLUTION = 96
/** 三档缩放，覆盖的世界范围（米） */
const RANGES = [320, 700, 1500]
const DEFAULT_RANGE_INDEX = 1

export class WorldMap {
  private overlay: HTMLDivElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private rangeLabel: HTMLDivElement | null = null

  private pixels = new Uint8ClampedArray(RESOLUTION * RESOLUTION * 4)
  private terrainReady = false
  private rangeIndex = DEFAULT_RANGE_INDEX
  private centerX = 0
  private centerZ = 0

  constructor(private readonly terrain: Heightfield) {}

  get isOpen(): boolean {
    return this.overlay !== null
  }

  toggle(markers: MinimapMarkers): void {
    if (this.overlay) this.close()
    else this.open(markers)
  }

  open(markers: MinimapMarkers): void {
    if (this.overlay) return
    this.centerX = markers.playerPos.x
    this.centerZ = markers.playerPos.z

    const overlay = document.createElement('div')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(4,8,14,0.78)',
      'display:flex', 'align-items:center', 'justify-content:center',
      // 高于 lil-gui 的 1001
      'z-index:1030', 'padding:20px',
    ].join(';')
    overlay.addEventListener('click', () => this.close())

    const panel = document.createElement('div')
    panel.style.cssText = [
      'background:rgba(11,19,27,0.97)', 'border:1px solid rgba(120,170,220,0.3)',
      'border-radius:12px', 'padding:16px',
      'display:flex', 'flex-direction:column', 'gap:12px', 'align-items:center',
      'box-shadow:0 18px 60px rgba(0,0,0,0.65)',
    ].join(';')
    panel.addEventListener('click', (e) => e.stopPropagation())

    const title = document.createElement('div')
    title.textContent = '地图'
    title.style.cssText =
      'color:#cfe3f5;font:600 15px/1 -apple-system,"PingFang SC",system-ui,sans-serif'
    panel.appendChild(title)

    // 地图画布尺寸随窗口自适应，保证在小屏上也放得下
    const side = Math.min(560, Math.max(280, Math.min(window.innerWidth, window.innerHeight) - 180))

    const canvas = document.createElement('canvas')
    canvas.width = side
    canvas.height = side
    canvas.style.cssText = [
      `width:${side}px`, `height:${side}px`, 'border-radius:8px',
      'background:rgba(8,14,20,0.9)', 'display:block',
      'border:1px solid rgba(120,170,220,0.18)',
    ].join(';')
    panel.appendChild(canvas)

    const controls = document.createElement('div')
    controls.style.cssText = 'display:flex;gap:10px;align-items:center'

    const mkButton = (label: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.textContent = label
      btn.style.cssText = [
        'background:rgba(30,52,72,0.9)', 'color:#bfe0f5',
        'border:1px solid rgba(120,180,230,0.35)', 'border-radius:6px',
        'padding:6px 14px', 'cursor:pointer', 'font-size:13px',
        'font-family:inherit',
      ].join(';')
      btn.onclick = onClick
      return btn
    }

    const label = document.createElement('div')
    label.style.cssText =
      'color:#8fb4d0;font:12px/1 -apple-system,"PingFang SC",system-ui,sans-serif;min-width:110px;text-align:center'

    controls.appendChild(mkButton('−', () => this.zoom(-1, markers)))
    controls.appendChild(label)
    controls.appendChild(mkButton('+', () => this.zoom(1, markers)))
    controls.appendChild(mkButton('关闭', () => this.close()))
    panel.appendChild(controls)

    overlay.appendChild(panel)
    document.body.appendChild(overlay)

    this.overlay = overlay
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.rangeLabel = label

    this.resample()
    this.updateLabel()
  }

  close(): void {
    this.overlay?.remove()
    this.overlay = null
    this.canvas = null
    this.ctx = null
    this.rangeLabel = null
  }

  private zoom(direction: number, markers: MinimapMarkers): void {
    const next = this.rangeIndex + direction
    if (next < 0 || next >= RANGES.length) return
    this.rangeIndex = next
    // 切换缩放后地图中心跟着玩家走，否则放大时可能把自己移出画面
    this.centerX = markers.playerPos.x
    this.centerZ = markers.playerPos.z
    this.resample()
    this.updateLabel()
  }

  private updateLabel(): void {
    if (this.rangeLabel) this.rangeLabel.textContent = `范围 ${RANGES[this.rangeIndex]} 米`
  }

  /** 重新采样地形底图。开销约百毫秒级，只在打开与切换缩放时执行。 */
  private resample(): void {
    const half = RANGES[this.rangeIndex] / 2
    const step = RANGES[this.rangeIndex] / RESOLUTION

    for (let row = 0; row < RESOLUTION; row++) {
      const wz = this.centerZ - half + (row + 0.5) * step
      for (let col = 0; col < RESOLUTION; col++) {
        const wx = this.centerX - half + (col + 0.5) * step
        colorForHeight(this.terrain.height(wx, wz), this.pixels, (row * RESOLUTION + col) * 4)
      }
    }
    this.terrainReady = true
  }

  update(markers: MinimapMarkers): void {
    if (!this.ctx || !this.canvas) return
    drawMap(this.ctx, {
      size: this.canvas.width,
      range: RANGES[this.rangeIndex],
      centerX: this.centerX,
      centerZ: this.centerZ,
      terrainPixels: this.pixels,
      resolution: RESOLUTION,
      markers,
      hasTerrain: this.terrainReady,
      // 大地图上标记画大一点，否则在几百米的视野里会小到看不见
      markerScale: 1.7,
    })
  }

  dispose(): void {
    this.close()
  }
}
