/**
 * 对话框。
 *
 * 塞尔达式的对话有两个特征，这里都保留了：
 *
 * 1. **一次只显示一句**，按键翻页。一次糊一大段文字，玩家会直接跳过。
 * 2. **说话的人有名字条**。没有名字条，玩家分不清这句话是贤者说的
 *    还是系统提示。
 *
 * 覆盖层用 DOM 而不是画在 canvas 上：文字排版、换行、多语言都是浏览器
 * 的强项，自己画一遍纯属找麻烦。HUD 的其它部分也是这么做的。
 */

export interface DialogueLine {
  /** 说话人，显示在名字条上 */
  speaker: string
  text: string
}

export class DialogueBox {
  private readonly root: HTMLDivElement
  private readonly nameEl: HTMLDivElement
  private readonly textEl: HTMLDivElement
  private readonly hintEl: HTMLDivElement

  private lines: readonly DialogueLine[] = []
  private index = 0
  private open = false
  private onFinish: (() => void) | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'dialogue'
    this.root.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:88px',
      'transform:translateX(-50%)',
      'width:min(680px, 88vw)',
      'background:rgba(10,16,24,0.92)',
      'border:1px solid rgba(140,190,240,0.35)',
      'border-radius:12px',
      'padding:18px 22px 14px',
      'color:#e6f0fa',
      'font:15px/1.75 -apple-system,"PingFang SC",system-ui,sans-serif',
      'z-index:120',
      'display:none',
      'box-shadow:0 10px 40px rgba(0,0,0,0.55)',
      'pointer-events:none',
    ].join(';')

    this.nameEl = document.createElement('div')
    this.nameEl.style.cssText = [
      'position:absolute',
      'top:-13px',
      'left:18px',
      'background:rgba(24,40,58,0.98)',
      'border:1px solid rgba(140,190,240,0.45)',
      'border-radius:6px',
      'padding:2px 12px',
      'font-size:13px',
      'font-weight:600',
      'color:#9fd0ff',
      'letter-spacing:0.05em',
    ].join(';')

    this.textEl = document.createElement('div')
    this.textEl.style.minHeight = '52px'

    this.hintEl = document.createElement('div')
    this.hintEl.textContent = '按 E 继续'
    this.hintEl.style.cssText = [
      'text-align:right',
      'font-size:12px',
      'color:#7fa3c4',
      'margin-top:6px',
    ].join(';')

    this.root.append(this.nameEl, this.textEl, this.hintEl)
    document.body.appendChild(this.root)
  }

  get isOpen(): boolean {
    return this.open
  }

  /** 开始一段对话。结束后调用 onFinish */
  show(lines: readonly DialogueLine[], onFinish?: () => void): void {
    if (lines.length === 0) {
      onFinish?.()
      return
    }
    this.lines = lines
    this.index = 0
    this.onFinish = onFinish ?? null
    this.open = true
    this.root.style.display = 'block'
    this.render()
  }

  /**
   * 翻到下一页。返回 true 表示这次按键被对话框吃掉了——
   * 调用方据此决定要不要把同一次按键同时判给跳跃/攻击。
   */
  advance(): boolean {
    if (!this.open) return false
    this.index++
    if (this.index >= this.lines.length) {
      this.close()
      return true
    }
    this.render()
    return true
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.root.style.display = 'none'
    const done = this.onFinish
    this.onFinish = null
    this.lines = []
    done?.()
  }

  private render(): void {
    const line = this.lines[this.index]
    if (!line) return
    this.nameEl.textContent = line.speaker
    this.textEl.textContent = line.text
    this.hintEl.textContent =
      this.index === this.lines.length - 1 ? '按 E 结束' : `按 E 继续  ${this.index + 1}/${this.lines.length}`
  }

  dispose(): void {
    this.root.remove()
  }
}

/**
 * 交互提示：站在可以对话的目标旁边时浮出的「按 E」气泡。
 *
 * 做成跟随屏幕底部固定位置而不是世界坐标投影：这一版只有贤者一个可对话
 * 对象，投影一套世界→屏幕的换算不划算。等 NPC 多起来再升级。
 */
export class InteractPrompt {
  private readonly root: HTMLDivElement
  private shown = false

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'interact'
    this.root.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:150px',
      'transform:translateX(-50%)',
      'background:rgba(14,22,32,0.9)',
      'border:1px solid rgba(150,200,250,0.4)',
      'border-radius:20px',
      'padding:7px 18px',
      'color:#dceaf8',
      'font:14px/1.4 -apple-system,"PingFang SC",system-ui,sans-serif',
      'z-index:110',
      'pointer-events:none',
      'display:none',
      'white-space:nowrap',
    ].join(';')
    document.body.appendChild(this.root)
  }

  show(label: string): void {
    if (this.shown && this.root.textContent === label) return
    this.shown = true
    this.root.textContent = label
    this.root.style.display = 'block'
  }

  hide(): void {
    if (!this.shown) return
    this.shown = false
    this.root.style.display = 'none'
  }

  dispose(): void {
    this.root.remove()
  }
}

/** 顶部的任务栏：当前目标 + 到目标的距离 */
export class ObjectiveBanner {
  private readonly root: HTMLDivElement
  private readonly titleEl: HTMLDivElement
  private readonly textEl: HTMLDivElement
  private lastText = ''

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'objective'
    this.root.style.cssText = [
      'position:fixed',
      'top:14px',
      'left:50%',
      'transform:translateX(-50%)',
      'min-width:260px',
      'max-width:min(560px, 76vw)',
      'background:rgba(10,16,24,0.72)',
      'border-left:3px solid #f0c040',
      'border-radius:4px',
      'padding:8px 16px',
      'color:#e8f0f8',
      'font:13px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif',
      'z-index:85',
      'pointer-events:none',
      'text-align:center',
      'transition:opacity 0.3s',
    ].join(';')

    this.titleEl = document.createElement('div')
    this.titleEl.textContent = '当前目标'
    this.titleEl.style.cssText = 'font-size:11px;color:#f0c040;letter-spacing:0.12em;margin-bottom:2px'

    this.textEl = document.createElement('div')

    this.root.append(this.titleEl, this.textEl)
    document.body.appendChild(this.root)
  }

  /**
   * @param distance 为 null 表示没有具体地点（比如通关后）
   * @param sideText 进行中的支线。挂在主线下面一行，字号小一档——
   *   支线是"顺便做的事"，不该和主线抢同样的视觉权重
   */
  update(text: string, distance: number | null, sideText?: string): void {
    const suffix = distance === null ? '' : `　·　${Math.round(distance)} 米`
    const full = text + suffix + '|' + (sideText ?? '')
    if (full === this.lastText) return
    this.lastText = full

    this.textEl.textContent = ''
    const main = document.createElement('div')
    main.textContent = text + suffix
    this.textEl.appendChild(main)

    if (sideText) {
      const side = document.createElement('div')
      side.textContent = sideText
      side.style.cssText = 'font-size:12px;color:#9fd0ff;margin-top:2px'
      this.textEl.appendChild(side)
    }
  }

  setVisible(visible: boolean): void {
    this.root.style.opacity = visible ? '1' : '0'
  }

  dispose(): void {
    this.root.remove()
  }
}
