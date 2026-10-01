/**
 * 自动巡检：让相机按固定轨迹跑过几种典型场景，分段录制性能数据。
 *
 * 手动"感觉挺流畅"不能作为决策依据——同一份代码在不同视角下帧率
 * 可以差三倍。这里把场景固化成可复现的用例，输出的数字能跨版本、
 * 跨机器直接对比。
 *
 * 时序约定（容易写错，注意）：相机姿态必须在**渲染前**设置，
 * 性能采样必须在**渲染后**采集（renderer 的统计此时才更新）。
 * 所以对外暴露 beforeRender / afterRender 两个钩子。
 */

import { Vector3, type PerspectiveCamera } from 'three'
import { RecordingSession, type PerfSample, type PerfStats } from '../core/perf.ts'

export interface BenchCase {
  name: string
  /** 说明这一例子在测什么，报告里会带上 */
  note: string
  seconds: number
  /** 给定归一化时间 t∈[0,1]，写出相机位置与注视点 */
  pose: (t: number, position: Vector3, target: Vector3) => void
}

export interface BenchResult {
  name: string
  note: string
  stats: PerfStats
}

/**
 * 四个典型用例，覆盖性能特征差异最大的视角：
 *  - 远眺：可见地形块最多，三角形与 draw call 峰值
 *  - 林间：植被叠加地形，阴影投射体最多
 *  - 俯瞰：视锥几乎全在渲染，填充率与顶点双高
 *  - 贴地高速：考验地形流式加载，最容易出卡顿
 */
export const BENCH_CASES: BenchCase[] = [
  {
    name: '地平线远眺',
    note: '站在高处平视远方，可见地形块最多',
    seconds: 8,
    pose: (t, position, target) => {
      position.set(-120 + t * 40, 44, 60)
      target.set(-20 + t * 40, 40, 160)
    },
  },
  {
    name: '森林穿行',
    note: '低空掠过树林，阴影投射体最多',
    seconds: 8,
    pose: (t, position, target) => {
      const angle = t * 1.6
      const r = 70
      position.set(Math.cos(angle) * r, 9, Math.sin(angle) * r)
      target.set(Math.cos(angle + 0.5) * r, 7, Math.sin(angle + 0.5) * r)
    },
  },
  {
    name: '高空俯瞰',
    note: '高空俯视大地形，填充率与顶点压力最大',
    seconds: 8,
    pose: (t, position, target) => {
      position.set(Math.sin(t * 3) * 40, 190, Math.cos(t * 3) * 40)
      target.set(0, 0, 0)
    },
  },
  {
    name: '贴地高速飞行',
    note: '贴近地面高速移动，考验地形流式加载',
    seconds: 10,
    pose: (t, position, target) => {
      const dist = t * 900 - 450
      position.set(dist, 7, 12)
      target.set(dist + 60, 6, 12)
    },
  },
]

export interface AutopilotCallbacks {
  /** 每帧把相机姿态应用到场景 */
  onPose: (position: Vector3, target: Vector3) => void
  onCaseStart?: (benchCase: BenchCase, index: number) => void
  onCaseEnd?: (result: BenchResult) => void
  onFinish?: (results: BenchResult[]) => void
  /** 每个用例开始前等待地形补齐的时间（秒），避免把加载中的帧算进去 */
  settleSeconds?: number
}

export class Autopilot {
  private readonly results: BenchResult[] = []
  private caseIndex = 0
  private caseTime = 0
  private phase: 'settle' | 'record' = 'settle'
  private session: RecordingSession | null = null
  private running = false

  private readonly position = new Vector3()
  private readonly target = new Vector3()
  private readonly settle: number

  constructor(
    private readonly cases: BenchCase[],
    private readonly cb: AutopilotCallbacks,
  ) {
    this.settle = cb.settleSeconds ?? 1.5
  }

  get isRunning(): boolean {
    return this.running
  }

  get progressText(): string {
    if (!this.running) return ''
    const c = this.cases[this.caseIndex]
    const phase = this.phase === 'settle' ? '预热' : '录制'
    return `巡检 ${this.caseIndex + 1}/${this.cases.length} · ${c?.name ?? ''} · ${phase}`
  }

  start(): void {
    this.results.length = 0
    this.caseIndex = 0
    this.caseTime = 0
    this.phase = 'settle'
    this.running = this.cases.length > 0
    if (this.running) this.beginCase(0)
  }

  stop(): void {
    this.running = false
    this.session = null
  }

  private beginCase(index: number): void {
    const benchCase = this.cases[index]
    this.cb.onCaseStart?.(benchCase, index)
    this.session = new RecordingSession(benchCase.name)
    this.session.begin(performance.now())
  }

  /** 渲染前调用：推进状态并摆好相机 */
  beforeRender(dt: number): void {
    if (!this.running) return
    const benchCase = this.cases[this.caseIndex]
    if (!benchCase) {
      this.running = false
      return
    }

    // 先按当前进度摆相机，再推进时间线——否则切换用例时会跳一帧
    const t = benchCase.seconds > 0 ? Math.min(1, this.caseTime / benchCase.seconds) : 0
    benchCase.pose(t, this.position, this.target)
    this.cb.onPose(this.position, this.target)

    this.caseTime += dt

    if (this.phase === 'settle') {
      if (this.caseTime >= this.settle) {
        this.phase = 'record'
        this.caseTime = 0
        this.session = new RecordingSession(benchCase.name)
        this.session.begin(performance.now())
      }
      return
    }

    if (this.caseTime >= benchCase.seconds) {
      const stats = this.session ? this.session.finish() : null
      if (stats) {
        const result: BenchResult = { name: benchCase.name, note: benchCase.note, stats }
        this.results.push(result)
        this.cb.onCaseEnd?.(result)
      }
      this.caseIndex++
      this.caseTime = 0
      this.phase = 'settle'
      if (this.caseIndex >= this.cases.length) {
        this.running = false
        this.session = null
        this.cb.onFinish?.(this.results)
      } else {
        this.beginCase(this.caseIndex)
      }
    }
  }

  /** 渲染后调用：把这一帧的采样喂进来 */
  afterRender(sample: PerfSample): void {
    if (!this.running || this.phase !== 'record' || !this.session) return
    this.session.push(sample)
  }

  getResults(): BenchResult[] {
    return this.results
  }
}

export interface ReportMeta {
  [key: string]: string | number
}

/** 把巡检结果拼成可直接存档的文本报告 */
export function formatReport(results: BenchResult[], meta: ReportMeta): string {
  const lines: string[] = []
  lines.push('='.repeat(64))
  lines.push('阶段 0 性能摸底报告')
  lines.push('='.repeat(64))
  lines.push('')
  lines.push('【环境】')
  for (const [k, v] of Object.entries(meta)) {
    lines.push(`  ${String(k).padEnd(14)} ${v}`)
  }
  lines.push('')
  lines.push('【分项结果】')
  for (const r of results) {
    const s = r.stats
    lines.push('')
    lines.push(`■ ${r.name}  —  ${r.note}`)
    lines.push(
      `  FPS       avg ${s.fps.avg.toFixed(1)}   min ${s.fps.min.toFixed(1)}   p95 ${s.fps.p95.toFixed(1)}   max ${s.fps.max.toFixed(1)}`,
    )
    lines.push(
      `  帧时间 ms  avg ${s.frameMs.avg.toFixed(2)}   p95 ${s.frameMs.p95.toFixed(2)}   max ${s.frameMs.max.toFixed(2)}`,
    )
    lines.push(`  DrawCall  avg ${Math.round(s.drawCalls.avg)}   max ${Math.round(s.drawCalls.max)}`)
    lines.push(
      `  三角形     avg ${Math.round(s.triangles.avg / 1000)}k   max ${Math.round(s.triangles.max / 1000)}k`,
    )
    lines.push(
      `  JS堆 MB    ${s.heapMB.start.toFixed(0)} → ${s.heapMB.end.toFixed(0)}   峰值 ${s.heapMB.max.toFixed(0)}`,
    )
  }

  const agg = aggregate(results)
  lines.push('')
  lines.push('【总评】')
  lines.push(`  最低 avg FPS     ${agg.minAvgFps.toFixed(1)}`)
  lines.push(`  最差 p95 帧时间   ${agg.worstP95.toFixed(2)} ms`)
  lines.push(`  DrawCall 峰值     ${agg.maxDrawCalls}`)
  lines.push(`  三角形峰值        ${Math.round(agg.maxTriangles / 1000)}k`)
  lines.push(`  JS堆峰值          ${agg.peakHeapMB.toFixed(0)} MB`)
  lines.push('')
  lines.push(`  内存判定：${agg.peakHeapMB <= 1200 ? '✅ 通过（≤1200MB）' : '⚠️ 超出预算，需压缩资源'}`)
  lines.push(`  帧率判定：${agg.minAvgFps >= 30 ? '✅ 通过（≥30 FPS 保底）' : '❌ 未通过，需下调画质目标'}`)
  lines.push('')
  return lines.join('\n')
}

function aggregate(results: BenchResult[]): {
  minAvgFps: number
  worstP95: number
  maxDrawCalls: number
  maxTriangles: number
  peakHeapMB: number
} {
  if (results.length === 0) {
    return { minAvgFps: 0, worstP95: 0, maxDrawCalls: 0, maxTriangles: 0, peakHeapMB: 0 }
  }
  let minAvgFps = Infinity
  let worstP95 = 0
  let maxDrawCalls = 0
  let maxTriangles = 0
  let peakHeapMB = 0
  for (const r of results) {
    minAvgFps = Math.min(minAvgFps, r.stats.fps.avg)
    worstP95 = Math.max(worstP95, r.stats.frameMs.p95)
    maxDrawCalls = Math.max(maxDrawCalls, Math.round(r.stats.drawCalls.max))
    maxTriangles = Math.max(maxTriangles, r.stats.triangles.max)
    peakHeapMB = Math.max(peakHeapMB, r.stats.heapMB.max)
  }
  return { minAvgFps, worstP95, maxDrawCalls, maxTriangles, peakHeapMB }
}

/** 让相机看向目标点，供自由飞行与巡检共用 */
export function lookAt(camera: PerspectiveCamera, target: Vector3): void {
  camera.lookAt(target)
}
