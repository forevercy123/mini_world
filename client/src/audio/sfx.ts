/**
 * 音效。
 *
 * 全部用 Web Audio 现场合成，不加载任何音频文件——这一版没有音效素材，
 * 而"没有声音"对动作游戏是致命的：挥剑、命中、受伤全靠视觉传达，打击感
 * 会薄一半。
 *
 * 合成的好处是改起来快：调一个数字就能换音色，不用找素材、不用管授权。
 * 代价是音色偏"电子"，但对这种低多边形风格反而合适。
 *
 * ── 关于浏览器的自动播放策略 ──
 *
 * AudioContext 在用户第一次交互之前是 suspended 的，直接播会静默失败。
 * 所以 `unlock()` 必须挂在一个真实的手势事件里（按键、点击），不能靠
 * 定时器或者加载完成。
 */

export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** 总音量。玩家可以在面板里关掉 */
  private volume = 0.5
  private ready = false

  get isReady(): boolean {
    return this.ready
  }

  get masterVolume(): number {
    return this.volume
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.master) this.master.gain.value = this.volume
  }

  /**
   * 在用户手势里调用一次，解锁音频。
   * 重复调用是安全的。
   */
  unlock(): void {
    if (this.ready) {
      // 已经解锁过，只要确保没被浏览器挂起
      void this.ctx?.resume()
      return
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.volume
      this.master.connect(this.ctx.destination)
      void this.ctx.resume()
      this.ready = true
    } catch (err) {
      console.warn('[音效] 初始化失败：', err)
      this.ready = false
    }
  }

  // ─────────────────────── 基础音源 ───────────────────────

  /** 一个带包络的振荡器。sweepTo 给了就做频率滑动 */
  private tone(
    freq: number,
    duration: number,
    type: OscillatorType,
    gain: number,
    sweepTo?: number,
    delay = 0,
  ): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay

    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    if (sweepTo !== undefined) {
      // 指数滑音比线性更符合听觉：音高是按倍数感知的
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + duration)
    }

    const env = ctx.createGain()
    // 极短的攻击段 + 指数衰减，是"敲击"类音效的标准包络
    env.gain.setValueAtTime(0, t0)
    env.gain.linearRampToValueAtTime(gain, t0 + 0.008)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

    osc.connect(env)
    env.connect(this.master)
    osc.start(t0)
    osc.stop(t0 + duration + 0.02)
  }

  /** 一段被带通滤过的白噪声，用来做"摩擦/破空"类音色 */
  private noise(duration: number, centerFreq: number, gain: number, sweepTo?: number): void {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    const t0 = ctx.currentTime

    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration))
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1

    const src = ctx.createBufferSource()
    src.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 0.9
    filter.frequency.setValueAtTime(centerFreq, t0)
    if (sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + duration)
    }

    const env = ctx.createGain()
    env.gain.setValueAtTime(0, t0)
    env.gain.linearRampToValueAtTime(gain, t0 + 0.006)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)

    src.connect(filter)
    filter.connect(env)
    env.connect(this.master)
    src.start(t0)
    src.stop(t0 + duration + 0.02)
  }

  // ─────────────────────── 具体音效 ───────────────────────

  /** 挥剑：一道从高到低的风声 */
  swing(): void {
    this.noise(0.16, 3200, 0.16, 700)
  }

  /** 命中：低频撞击 + 一点噪声。碰撞的"实"来自低频 */
  hit(): void {
    this.tone(180, 0.13, 'square', 0.2, 70)
    this.noise(0.09, 1100, 0.18, 400)
  }

  /** 玩家受伤：下行锯齿，听着就不舒服 */
  hurt(): void {
    this.tone(420, 0.28, 'sawtooth', 0.16, 130)
    this.tone(210, 0.3, 'square', 0.1, 80)
  }

  /** 拾取：两声上行，短促清脆 */
  pickup(): void {
    this.tone(880, 0.09, 'sine', 0.16)
    this.tone(1320, 0.12, 'sine', 0.13, undefined, 0.06)
  }

  /** 开箱：一个明亮的大三和弦 */
  chest(): void {
    const base = 523.25 // C5
    for (const [i, ratio] of [1, 1.25, 1.5].entries()) {
      this.tone(base * ratio, 0.35, 'triangle', 0.13, undefined, i * 0.045)
    }
  }

  /** 拿到封印：上行琶音，是这一版里最"隆重"的音效 */
  seal(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5]
    for (const [i, f] of notes.entries()) {
      this.tone(f, 0.5, 'triangle', 0.14, undefined, i * 0.1)
    }
  }

  /** 对话翻页：极轻的一声，只为确认"按到了" */
  blip(): void {
    this.tone(660, 0.05, 'sine', 0.07)
  }

  /** 电击：一段爆裂噪声 + 下滑音 */
  shock(): void {
    this.noise(0.3, 2600, 0.2, 300)
    this.tone(160, 0.35, 'sawtooth', 0.14, 60)
  }

  /** 起风：一段宽频噪声由低扫到高，像风从身边掠过 */
  gust(): void {
    this.noise(0.5, 500, 0.14, 2600)
    this.tone(200, 0.45, 'sine', 0.07, 420)
  }

  /** 闪避：一声短促的破空，比挥剑更闷 */
  dodge(): void {
    this.noise(0.14, 1600, 0.13, 400)
    this.tone(320, 0.1, 'sine', 0.08, 180)
  }

  /** 攀爬时的抓握声，节流后周期性调用 */
  hold(): void {
    this.noise(0.07, 700, 0.07)
  }

  /** 武器碎裂：一声脆响 + 碎片四散的噪声。要刺耳——武器碎了是坏消息 */
  shatter(): void {
    this.tone(1900, 0.08, 'square', 0.14, 900)
    this.noise(0.28, 4200, 0.18, 1400)
    this.tone(300, 0.22, 'sawtooth', 0.1, 90)
  }

  /** 切换武器：一声短金属声，像武器入鞘又抽出 */
  equip(): void {
    this.noise(0.06, 2400, 0.1, 3600)
    this.tone(1240, 0.07, 'triangle', 0.08, 1600, 0.03)
  }

  /** 烹饪完成：锅里咕嘟声 + 一声轻快上行。做饭是好事，音色要暖 */
  cook(): void {
    this.noise(0.4, 300, 0.12, 700)
    this.tone(523.25, 0.14, 'triangle', 0.1, undefined, 0.28)
    this.tone(783.99, 0.2, 'triangle', 0.11, undefined, 0.4)
  }

  /** 野兽受击：比骷髅的命中更闷一点，是"打到肉"的声音 */
  hitFlesh(): void {
    this.tone(140, 0.12, 'square', 0.16, 60)
    this.noise(0.07, 800, 0.12, 300)
  }

  /** 狼嚎/野兽警觉：一声短促上行吼叫 */
  beastAlert(): void {
    this.tone(340, 0.24, 'sawtooth', 0.07, 620)
  }
}
