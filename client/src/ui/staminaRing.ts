/**
 * 体力环 HUD。
 *
 * 放在角色下方（屏幕中下部）而不是角落，是因为它和角色的动作强相关——
 * 攀爬时眼睛盯着角色，体力环必须在余光范围内。这也是塞尔达把它画在
 * 林克身边的原因。
 *
 * 用 SVG 圆环而不是 canvas：缩放不失真，改颜色只需改 CSS，而且不需要
 * 每帧重绘（只更新 dashoffset 一个属性）。
 */

const RADIUS = 42
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export class StaminaRing {
  private readonly root: HTMLDivElement
  private readonly arc: SVGCircleElement
  private shown = false
  private lastRatio = -1
  private lastLow = false
  private hideTimer = 0

  constructor() {
    const NS = 'http://www.w3.org/2000/svg'

    this.root = document.createElement('div')
    this.root.id = 'stamina-ring'
    this.root.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:104px', 'transform:translateX(-50%)',
      'width:64px', 'height:64px', 'z-index:60', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.28s ease',
    ].join(';')

    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 100 100')
    svg.style.cssText = 'width:100%;height:100%;display:block'

    const track = document.createElementNS(NS, 'circle')
    track.setAttribute('cx', '50')
    track.setAttribute('cy', '50')
    track.setAttribute('r', String(RADIUS))
    track.setAttribute('fill', 'none')
    track.setAttribute('stroke', 'rgba(6,12,18,0.55)')
    track.setAttribute('stroke-width', '9')

    this.arc = document.createElementNS(NS, 'circle')
    this.arc.setAttribute('cx', '50')
    this.arc.setAttribute('cy', '50')
    this.arc.setAttribute('r', String(RADIUS))
    this.arc.setAttribute('fill', 'none')
    this.arc.setAttribute('stroke', '#8fe39a')
    this.arc.setAttribute('stroke-width', '9')
    this.arc.setAttribute('stroke-linecap', 'round')
    this.arc.setAttribute('stroke-dasharray', String(CIRCUMFERENCE))
    // 让进度从正上方开始顺时针增长
    this.arc.setAttribute('transform', 'rotate(-90 50 50)')
    this.arc.style.transition = 'stroke 0.2s'

    svg.appendChild(track)
    svg.appendChild(this.arc)
    this.root.appendChild(svg)
    document.body.appendChild(this.root)
  }

  /**
   * @param ratio 体力比例 0–1
   * @param active 是否正在被消耗（决定环是否常亮）
   */
  update(ratio: number, active: boolean): void {
    const clamped = Math.min(1, Math.max(0, ratio))
    const low = clamped < 0.25

    if (clamped !== this.lastRatio) {
      this.arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - clamped)))
      this.lastRatio = clamped
    }

    // 低体力换成警示色，比闪动更容易在余光里察觉
    if (low !== this.lastLow) {
      this.arc.setAttribute('stroke', low ? '#e8a24a' : '#8fe39a')
      this.lastLow = low
    }

    // 满体力且不在消耗时淡出——常驻会一直干扰视线
    const shouldShow = active || !this.isFullLatch(clamped)
    if (shouldShow !== this.shown) {
      this.root.style.opacity = shouldShow ? '1' : '0'
      this.shown = shouldShow
    }
  }

  private isFullLatch(ratio: number): boolean {
    return ratio >= 0.999
  }

  /** 供外部（如暂停、过场）强制隐藏 */
  forceHide(): void {
    this.root.style.opacity = '0'
    this.shown = false
    window.clearTimeout(this.hideTimer)
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer)
    this.root.remove()
  }
}
