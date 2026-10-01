/**
 * 主循环：固定步长更新 + 可变步长渲染。
 *
 * 用固定步长跑逻辑（物理、玩法、AI），保证不同帧率下行为一致——
 * 这对塞尔达式的精确操作（闪避帧、攀爬判定）是必需的。
 * 渲染用真实 dt，保证动画平滑。
 */

export interface LoopCallbacks {
  /** 固定步长逻辑更新，dt 恒为 1/fixedHz 秒 */
  update: (dt: number) => void
  /** 每帧渲染，dt 为真实间隔（秒），alpha 为逻辑插值系数 */
  render: (dt: number, alpha: number) => void
}

export class GameLoop {
  private rafId = 0
  private running = false
  private lastTime = 0
  private accumulator = 0
  private readonly fixedDt: number
  /** 单帧最多补多少步逻辑，防止卡顿后"死亡螺旋" */
  private readonly maxSubSteps: number

  constructor(
    private readonly cb: LoopCallbacks,
    fixedHz = 60,
    maxSubSteps = 5,
  ) {
    this.fixedDt = 1 / fixedHz
    this.maxSubSteps = maxSubSteps
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.accumulator = 0
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private tick = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.tick)

    // 真实间隔，钳制到 [0, 250ms]。
    // 上限防止切标签页回来时一次补几千步；下限 0 是必需的——某些环境
    // （headless、系统时钟调整、虚拟时间）下 rAF 时间戳会回退，出现负 dt。
    // 负 dt 会让累积器变负，while 条件永不成立，逻辑更新就被彻底跳过了。
    const rawDt = (now - this.lastTime) / 1000
    this.lastTime = now
    const dt = Math.min(Math.max(rawDt, 0), 0.25)

    this.accumulator += dt

    let steps = 0
    while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
      this.cb.update(this.fixedDt)
      this.accumulator -= this.fixedDt
      steps++
    }
    // 补步数超限说明这一帧太慢，丢弃积压避免越积越多
    if (steps >= this.maxSubSteps) this.accumulator = 0

    this.cb.render(dt, this.accumulator / this.fixedDt)
  }
}
