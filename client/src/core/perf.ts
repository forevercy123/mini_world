/**
 * 性能监控：帧率、帧时间、Draw Call、三角形数、JS 堆内存。
 *
 * 阶段 0 的目标是产出**可比较的测量数据**，而不只是"看起来流畅"。
 * 因此这里除了实时 HUD，还提供 RecordingSession：把一段时间的采样
 * 汇总成带 avg / p95 / max 的统计对象，可导出 JSON 存档对比。
 */

type MemoryInfo = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

/** Chrome 专有的 performance.memory；Safari 上返回 0。 */
export function readHeapMB(): number {
  const mem = (performance as Performance & { memory?: MemoryInfo }).memory
  return mem ? mem.usedJSHeapSize / 1048576 : 0
}

export interface PerfSample {
  /** 采样时间戳（ms，performance.now） */
  t: number
  frameMs: number
  drawCalls: number
  triangles: number
  programs: number
  heapMB: number
}

export interface Range {
  avg: number
  min: number
  max: number
  p95: number
}

export interface PerfStats {
  frames: number
  durationMs: number
  fps: Range
  frameMs: Range
  drawCalls: { avg: number; max: number }
  triangles: { avg: number; max: number }
  programs: number
  heapMB: { start: number; end: number; max: number }
}

function summarize(values: number[]): Range {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, p95: 0 }
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  const sorted = [...values].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  return { avg: sum / values.length, min, max, p95 }
}

/** 把一组采样汇总成统计结果。 */
export function summarizeSamples(samples: PerfSample[]): PerfStats {
  const fps = samples.map((s) => (s.frameMs > 0 ? 1000 / s.frameMs : 0))
  const frameMs = samples.map((s) => s.frameMs)
  const drawCalls = samples.map((s) => s.drawCalls)
  const triangles = samples.map((s) => s.triangles)
  const heap = samples.map((s) => s.heapMB)

  const durationMs =
    samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0

  const fpsStats = summarize(fps)
  const frameStats = summarize(frameMs)

  return {
    frames: samples.length,
    durationMs,
    fps: fpsStats,
    frameMs: { avg: frameStats.avg, min: frameStats.min, max: frameStats.max, p95: frameStats.p95 },
    drawCalls: { avg: mean(drawCalls), max: Math.max(0, ...drawCalls) },
    triangles: { avg: mean(triangles), max: Math.max(0, ...triangles) },
    programs: samples.length ? samples[samples.length - 1].programs : 0,
    heapMB: {
      start: heap[0] ?? 0,
      end: heap[heap.length - 1] ?? 0,
      max: heap.length ? Math.max(...heap) : 0,
    },
  }
}

function mean(values: number[]): number {
  if (!values.length) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** 把统计结果格式化成等宽文本表格，方便贴进报告。 */
export function formatStats(label: string, s: PerfStats): string {
  const pad = (n: number, w = 7) => n.toFixed(1).padStart(w)
  const padI = (n: number, w = 7) => Math.round(n).toString().padStart(w)
  return [
    `── ${label} ──`,
    `  采样帧数 ${s.frames}   时长 ${(s.durationMs / 1000).toFixed(1)}s`,
    `  FPS       avg${pad(s.fps.avg)}  min${pad(s.fps.min)}  p95${pad(s.fps.p95)}  max${pad(s.fps.max)}`,
    `  帧时间 ms  avg${pad(s.frameMs.avg)}  p95${pad(s.frameMs.p95)}  max${pad(s.frameMs.max)}`,
    `  DrawCall  avg${padI(s.drawCalls.avg)}  max${padI(s.drawCalls.max)}`,
    `  三角形     avg${padI(s.triangles.avg)}  max${padI(s.triangles.max)}`,
    `  着色器程序 ${s.programs}`,
    `  JS堆 MB    start${pad(s.heapMB.start)}  end${pad(s.heapMB.end)}  max${pad(s.heapMB.max)}`,
  ].join('\n')
}

export interface RecorderOptions {
  /** 丢弃开头多少毫秒的采样，避开首帧编译着色器的抖动 */
  warmupMs?: number
}

/** 一次测量会话：start() 开始收集，stop() 返回统计结果。 */
export class RecordingSession {
  private samples: PerfSample[] = []
  private startTime = 0
  private readonly warmupMs: number
  private readonly label: string

  constructor(label: string, opts: RecorderOptions = {}) {
    this.label = label
    this.warmupMs = opts.warmupMs ?? 1000
  }

  begin(now: number): void {
    this.samples = []
    this.startTime = now
  }

  push(sample: PerfSample): void {
    if (sample.t - this.startTime < this.warmupMs) return
    this.samples.push(sample)
  }

  get count(): number {
    return this.samples.length
  }

  finish(): PerfStats {
    return summarizeSamples(this.samples)
  }

  report(): string {
    return formatStats(this.label, this.finish())
  }
}

/**
 * 实时 HUD。用 DOM 而非 canvas 绘制，避免干扰被测的渲染开销。
 * 只在文字变化时写 DOM，把自身开销压到可忽略。
 */
export class PerfHUD {
  private el: HTMLDivElement
  private readonly monitor: PerfMonitor
  private visible = true
  private lastText = ''
  private lastUpdate = 0
  private extra = ''

  constructor(monitor: PerfMonitor) {
    this.monitor = monitor
    this.el = document.createElement('div')
    this.el.style.cssText = [
      'position:fixed', 'top:10px', 'left:10px', 'z-index:50',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#9fe8b0', 'background:rgba(8,14,20,0.78)',
      'padding:8px 12px', 'border-radius:6px', 'white-space:pre',
      'pointer-events:none', 'text-shadow:0 1px 2px #000',
    ].join(';')
    document.body.appendChild(this.el)
  }

  toggle(): boolean {
    this.visible = !this.visible
    this.el.style.display = this.visible ? 'block' : 'none'
    return this.visible
  }

  /** 附加一行状态信息（地形块数、巡检进度等） */
  setExtra(text: string): void {
    this.extra = text
  }

  update(now: number): void {
    if (!this.visible || now - this.lastUpdate < 200) return
    this.lastUpdate = now
    const s = this.monitor.latest
    if (!s) return
    // 显示用平滑值避免数字乱跳，统计仍走原始值
    const ms = this.monitor.smoothFrameMs
    const fps = ms > 0 ? 1000 / ms : 0
    const lines = [
      `FPS    ${fps.toFixed(0).padStart(3)}  (${ms.toFixed(1)} ms)`,
      `Draw   ${s.drawCalls}`,
      `Tris   ${(s.triangles / 1000).toFixed(0)}k`,
      `Heap   ${s.heapMB.toFixed(0)} MB`,
      `Prog   ${s.programs}`,
    ]
    if (this.extra) lines.push(this.extra)
    const text = lines.join('\n')
    if (text !== this.lastText) {
      this.el.textContent = text
      this.lastText = text
    }
  }

  dispose(): void {
    this.el.remove()
  }
}

/** 采样器：每帧喂入，维护滑动窗口与最近一次采样。 */
export class PerfMonitor {
  private window: number[] = []
  private readonly windowSize: number
  private _latest: PerfSample | null = null
  private emaFrameMs = 16.7

  constructor(windowSize = 60) {
    this.windowSize = windowSize
  }

  get latest(): PerfSample | null {
    return this._latest
  }

  /** 平滑后的帧时间（EMA），比瞬时值更适合展示 */
  get smoothFrameMs(): number {
    return this.emaFrameMs
  }

  push(frameMs: number, info: RenderInfo): PerfSample {
    this.emaFrameMs = this.emaFrameMs * 0.9 + frameMs * 0.1
    this.window.push(frameMs)
    if (this.window.length > this.windowSize) this.window.shift()

    const sample: PerfSample = {
      t: performance.now(),
      // 存原始值而非平滑值：p95 与 max 的意义全在于捕捉尖峰，
      // 用 EMA 会把卡顿抹平，报告就失去诊断价值了
      frameMs,
      drawCalls: info.calls,
      triangles: info.triangles,
      programs: info.programs,
      heapMB: readHeapMB(),
    }
    this._latest = sample
    return sample
  }
}

/** 从渲染器读取的每帧统计，抽出来避免 perf 模块直接依赖 three。 */
export interface RenderInfo {
  calls: number
  triangles: number
  programs: number
}
