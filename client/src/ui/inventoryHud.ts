/**
 * 背包 HUD：左上角心心下方的一行物品。
 *
 * 只在背包版本号变化时重建 DOM。拾取物品是低频事件，而每帧重写 DOM
 * 会让这个本来只是"看一眼"的 UI 变成持续的开销。
 */

import { Inventory, ITEM_DEFS } from '../gameplay/inventory.ts'

export class InventoryHud {
  private readonly root: HTMLDivElement
  private lastVersion = -1

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'inventory-hud'
    this.root.style.cssText = [
      'position:fixed', 'left:12px', 'top:184px', 'z-index:55',
      'display:flex', 'flex-direction:column', 'gap:4px',
      'font:12px/1.4 -apple-system,"PingFang SC",system-ui,sans-serif',
      'color:#dbe8f4', 'text-shadow:0 1px 3px rgba(0,0,0,0.8)',
      'pointer-events:none',
    ].join(';')
    document.body.appendChild(this.root)
  }

  update(inventory: Inventory): void {
    if (inventory.version === this.lastVersion) return
    this.lastVersion = inventory.version

    const items = inventory.list()
    this.root.textContent = ''

    if (items.length === 0) {
      const hint = document.createElement('div')
      hint.textContent = '背包空空如也——地上的果子可以捡'
      hint.style.cssText = 'color:rgba(200,220,240,0.45);font-size:11.5px'
      this.root.appendChild(hint)
      return
    }

    for (const { def, count } of items) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:7px'

      const dot = document.createElement('span')
      dot.style.cssText = [
        'width:11px', 'height:11px', 'border-radius:50%',
        `background:#${def.color.toString(16).padStart(6, '0')}`,
        'box-shadow:0 0 6px rgba(255,255,255,0.28)',
        'flex:none',
      ].join(';')

      const label = document.createElement('span')
      label.textContent = `${def.name} ×${count}`

      row.appendChild(dot)
      row.appendChild(label)
      this.root.appendChild(row)
    }

    const tip = document.createElement('div')
    tip.textContent = '按 G 食用'
    tip.style.cssText = 'color:rgba(200,220,240,0.42);font-size:10.5px;margin-top:2px'
    this.root.appendChild(tip)
  }

  dispose(): void {
    this.root.remove()
  }
}

/** 便于外部确认物品定义表被正确引用（避免 tree-shaking 误删） */
export const ITEM_COUNT = Object.keys(ITEM_DEFS).length
