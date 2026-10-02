/**
 * 区域标题：走进一个新地方时，地名从屏幕中下方浮出来。
 *
 * 塞尔达的这个细节作用很大：它让"区域"成为玩家心智地图的一部分
 * （"我在海拉鲁平原"而不是"我在某片草地"），也让地图的分区感
 * 被明确说出来。没有它，地图做得再有结构，玩家也未必读得出。
 */

import { WATER_LEVEL } from '../terrain/heightfield.ts'

interface Region {
  id: string
  name: string
  sub: string
  /** 判定：坐标落进来就算 */
  test: (x: number, z: number, h: number) => boolean
}

/**
 * 区域表与地图塑形里的分区一一对应。顺序即优先级：
 * 湖岸比平原先判，雪山比高原先判
 */
const REGIONS: readonly Region[] = [
  {
    id: 'lake',
    name: '明镜湖',
    sub: '南 境 水 乡',
    test: (x, z, h) => z > 115 && Math.abs(x) < 260 && h < WATER_LEVEL + 4,
  },
  {
    id: 'snow',
    name: '苍雪峰',
    sub: '北 境 高 山',
    test: (x, z, h) => z < -95 && Math.abs(x) < 260 && h > 50,
  },
  {
    id: 'highland',
    name: '风啸高原',
    sub: '西 部 台 地',
    test: (x, z) => x < -105 && Math.abs(z) < 200,
  },
  {
    id: 'forest',
    name: '低语森林',
    sub: '东 部 谷 地',
    test: (x, z) => x > 110 && Math.abs(z) < 200,
  },
  {
    id: 'plain',
    name: '初心平原',
    sub: '中 央 草 原',
    test: (x, z) => Math.hypot(x, z) < 160,
  },
]

export class RegionTitle {
  private current: string | null = null
  private el: HTMLDivElement | null = null
  private hideTimer = 0
  private checkTimer = 0

  /** 节流检查：每 0.4 秒看一次玩家在哪 */
  update(dt: number, x: number, z: number, h: number): void {
    this.checkTimer -= dt
    if (this.checkTimer > 0) return
    this.checkTimer = 0.4

    const region = REGIONS.find((r) => r.test(x, z, h))
    const id = region?.id ?? null
    if (id === this.current) return
    this.current = id
    if (region) this.show(region.name, region.sub)
  }

  private show(name: string, sub: string): void {
    this.el?.remove()
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:18%', 'transform:translateX(-50%)',
      'text-align:center', 'z-index:60', 'pointer-events:none',
      'color:#f2ecd8', 'text-shadow:0 2px 18px rgba(0,0,0,0.75)',
      'opacity:0', 'transition:opacity 0.9s',
      'font:300 26px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif',
      'letter-spacing:0.42em',
    ].join(';')
    el.innerHTML = `${name}<div style="font-size:11px;letter-spacing:0.34em;opacity:0.7;margin-top:2px">${sub}</div>`
    document.body.appendChild(el)
    this.el = el
    requestAnimationFrame(() => { el.style.opacity = '1' })

    window.clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 1000)
      if (this.el === el) this.el = null
    }, 3000)
  }
}
