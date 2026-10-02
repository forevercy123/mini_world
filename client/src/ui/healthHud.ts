/**
 * 生命值 HUD（心心）。
 *
 * 用字形而不是 SVG：心形符号在系统字体里就有，一行一个字符，改数量
 * 只需增删元素，不需要重算路径。位置放在左上角 HUD 的下方，避开已有
 * 的调试信息块。
 *
 * 只在数值变化时写 DOM——每帧无条件重写会让这份 UI 自己变成性能负担。
 */

export class HealthHud {
  private readonly root: HTMLDivElement
  private readonly hearts: HTMLSpanElement[] = []
  private lastCurrent = -1

  constructor(maxHearts: number) {
    this.root = document.createElement('div')
    this.root.id = 'health-hud'
    this.root.style.cssText = [
      'position:fixed', 'left:12px', 'top:152px', 'z-index:55',
      'display:flex', 'gap:3px', 'pointer-events:none',
      'font:22px/1 -apple-system,"PingFang SC",system-ui,sans-serif',
      'text-shadow:0 1px 3px rgba(0,0,0,0.75)',
    ].join(';')

    for (let i = 0; i < maxHearts; i++) {
      const heart = document.createElement('span')
      heart.textContent = '♥'
      heart.style.cssText = 'transition:color 0.15s,transform 0.15s'
      this.root.appendChild(heart)
      this.hearts.push(heart)
    }

    document.body.appendChild(this.root)
    this.update(maxHearts)
  }

  /** 生命上限变了（拿到心之容器）时补心 */
  setMax(maxHearts: number): void {
    while (this.hearts.length < maxHearts) {
      const heart = document.createElement('span')
      heart.textContent = '♥'
      heart.style.cssText = 'transition:color 0.15s,transform 0.15s'
      this.root.appendChild(heart)
      this.hearts.push(heart)
    }
    while (this.hearts.length > maxHearts) {
      this.hearts.pop()?.remove()
    }
    // 心数变了，强制重绘
    this.lastCurrent = -1
  }

  update(current: number): void {
    const rounded = Math.max(0, current)
    if (rounded === this.lastCurrent) return
    this.lastCurrent = rounded

    for (let i = 0; i < this.hearts.length; i++) {
      const heart = this.hearts[i]
      const filled = i < rounded
      heart.style.color = filled ? '#e8544a' : 'rgba(220,235,250,0.16)'
      // 失去的心稍微缩小，让剩余生命的数量一眼可数
      heart.style.transform = filled ? 'scale(1)' : 'scale(0.86)'
    }
  }

  /** 受击时整排心抖一下，比单纯变颜色更醒目 */
  flash(): void {
    this.root.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 220, easing: 'ease-out' },
    )
  }

  dispose(): void {
    this.root.remove()
  }
}
