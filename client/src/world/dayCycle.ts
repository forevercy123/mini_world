/**
 * 昼夜循环。
 *
 * 这是整个场景光照的中枢：太阳方位、光色、天光、雾色、水面反射色
 * 全部由它派生，改一处就能让整个世界的时间感一致。如果各处单独写
 * 插值逻辑，黄昏时很容易出现"天是橙的、雾是蓝的、水面反射是白的"
 * 这种穿帮。
 *
 * 所有颜色都用「太阳高度角」这一个变量驱动——它是唯一需要判断的量，
 * 其余的暖冷、明暗都是它的函数。
 */

import { Color, Vector3 } from 'three'

export interface DayCycleConfig {
  /** 一整天对应的真实秒数。塞尔达约 24 分钟，这里默认 8 分钟便于观察 */
  dayLength: number
  /** 起始时刻（0–24 小时） */
  startHour: number
  /** 是否自动推进 */
  autoAdvance: boolean
}

export const DEFAULT_DAY_CONFIG: DayCycleConfig = {
  dayLength: 480,
  startHour: 9,
  autoAdvance: true,
}

/** 太阳高度角到各量的映射区间 */
const DAY_RAMP_START = -0.06
const DAY_RAMP_END = 0.32

const NIGHT_ZENITH = new Color(0x0a1430)
const DAY_ZENITH = new Color(0x2f6fbf)
const NIGHT_HORIZON = new Color(0x18203a)
const DAY_HORIZON = new Color(0xbcd8ee)
const DUSK_HORIZON = new Color(0xff9a5c)

const NIGHT_SUN = new Color(0xff8c42)
const DAY_SUN = new Color(0xfff1dd)

const NIGHT_HEMI_SKY = new Color(0x44578a)
const DAY_HEMI_SKY = new Color(0xa9c9e8)
const NIGHT_HEMI_GROUND = new Color(0x252a38)
const DAY_HEMI_GROUND = new Color(0x50483c)

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export class DayCycle {
  config: DayCycleConfig
  /** 当前时刻，0–24 小时 */
  timeOfDay: number

  readonly sunDirection = new Vector3()
  readonly sunColor = new Color()
  readonly skyZenith = new Color()
  readonly skyHorizon = new Color()
  readonly hemiSky = new Color()
  readonly hemiGround = new Color()

  /** 太阳直射光强度 */
  sunIntensity = 0
  /** 半球光强度 */
  hemiIntensity = 0
  /** 太阳高度角（-1 到 1），供外部判断白天/夜晚 */
  elevation = 0
  /** 月光强度（夜间才有值） */
  moonIntensity = 0
  /** 夜色浓度 0–1 */
  nightAmount = 0

  private readonly _dir = new Vector3()
  private readonly _moonDir = new Vector3()

  constructor(config: Partial<DayCycleConfig> = {}) {
    this.config = { ...DEFAULT_DAY_CONFIG, ...config }
    this.timeOfDay = this.config.startHour
    this.evaluate()
  }

  /** 直接设定时刻（0–24） */
  setHour(hour: number): void {
    this.timeOfDay = ((hour % 24) + 24) % 24
    this.evaluate()
  }

  update(dt: number): void {
    if (!this.config.autoAdvance) return
    const hoursPerSecond = 24 / this.config.dayLength
    this.timeOfDay = (this.timeOfDay + dt * hoursPerSecond) % 24
    this.evaluate()
  }

  /** 把当前时刻解算成太阳方位与全套配色 */
  private evaluate(): void {
    // 轨道：6 点东方地平线升起，12 点过顶，18 点西方落下。
    // 轨道带一点 z 向倾斜，避免正午太阳完全垂直导致所有斜面同样明亮。
    const t = (this.timeOfDay / 24) * Math.PI * 2 - Math.PI / 2
    this._dir.set(Math.cos(t), Math.sin(t), 0.32).normalize()
    this.sunDirection.copy(this._dir)

    const elev = this._dir.y
    this.elevation = elev

    const dayAmount = smoothstep(DAY_RAMP_START, DAY_RAMP_END, elev)

    // 黄昏/黎明：太阳贴近地平线时在地平线色里掺入橙红
    const duskAmount = Math.max(0, 1 - Math.abs(elev) * 3.4)

    this.skyZenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, dayAmount)
    this.skyHorizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayAmount)
    this.skyHorizon.lerp(DUSK_HORIZON, duskAmount * 0.55)

    this.sunColor.copy(NIGHT_SUN).lerp(DAY_SUN, smoothstep(0.0, 0.3, elev))
    this.sunIntensity = dayAmount * 2.8

    this.hemiSky.copy(NIGHT_HEMI_SKY).lerp(DAY_HEMI_SKY, dayAmount)
    this.hemiGround.copy(NIGHT_HEMI_GROUND).lerp(DAY_HEMI_GROUND, dayAmount)
    // 白天给到 1.45。原来只到 1.15，相对 2.8 的太阳光太弱，背光面和
    // 树荫下的东西会黑成一片剪影——岩石看不出是岩石，树冠底面是一坨黑。
    // 这里是拿一点对比度换阴影里的可读性，风格化渲染里这笔买卖划算
    this.hemiIntensity = 1.0 + dayAmount * 0.45

    // 月光。
    // 只靠半球光做夜景是行不通的：半球光色和草地顶点色都是暗色，相乘
    // 之后趋近于黑，怎么调强度都只能得到一团灰。夜间需要一盏有方向的
    // 灯来产生明暗对比，地形轮廓才能被读出来。
    this.nightAmount = 1 - dayAmount
    this.moonIntensity = this.nightAmount * 1.35
    // 月亮方向取太阳的反向：太阳落到地平线以下时，反方向正好升到天上
    this._moonDir.copy(this._dir).multiplyScalar(-1).normalize()
  }

  /** 月光照射方向（单位向量，指向月亮） */
  get moonDirection(): Vector3 {
    return this._moonDir
  }

  /** 供 HUD 显示的 "HH:MM" */
  get clockText(): string {
    const h = Math.floor(this.timeOfDay)
    const m = Math.floor((this.timeOfDay - h) * 60)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
}
