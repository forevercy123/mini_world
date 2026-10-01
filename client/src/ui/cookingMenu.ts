/**
 * 烹饪界面。
 *
 * 站在锅边按 E 打开：左边是背包里的食材，点选放进中间的锅，
 * 右边实时预览会做出什么。整个界面只用一层 DOM——烹饪是
 * 低频操作，不值得为它进 WebGL。
 *
 * 交互节奏学塞尔达：选食材没有确认步骤，点一下就下锅，
 * 再点一下拿回来，"下锅"按钮才结算。打开期间世界照常运转
 * （怪还会打你）——做饭不该是安全屋。
 */

import { ITEM_DEFS, type Inventory, type ItemId } from '../gameplay/inventory.ts'
import { planDish, POT_SLOTS } from '../gameplay/cooking.ts'

export class CookingMenu {
  private readonly root: HTMLDivElement
  private readonly potSlots: HTMLDivElement
  private readonly shelf: HTMLDivElement
  private readonly previewBox: HTMLDivElement
  private readonly cookButton: HTMLButtonElement
  private readonly pot: ItemId[] = []

  /** 结算回调：扣除食材、发放料理、播音效，由外部接线 */
  onCook: ((ingredients: readonly ItemId[], dish: ItemId) => void) | null = null
  /** 打开/关闭状态变化时通知外部（关闭时要归还移动控制权） */
  onOpenChange: ((open: boolean) => void) | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'cooking-menu'
    this.root.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'width:min(560px,92vw)', 'background:rgba(12,18,26,0.95)',
      'border:1px solid rgba(150,190,230,0.3)', 'border-radius:12px',
      'padding:20px 24px', 'z-index:110', 'display:none',
      'font:13px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif',
      'color:#dce9f5', 'box-shadow:0 16px 60px rgba(0,0,0,0.6)',
    ].join(';')

    const title = document.createElement('div')
    title.textContent = '烹 饪'
    title.style.cssText = 'font-size:17px;letter-spacing:0.3em;color:#ffe9a8;margin-bottom:12px;text-align:center'
    this.root.appendChild(title)

    // 锅：三个槽位
    this.potSlots = document.createElement('div')
    this.potSlots.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-bottom:10px'
    this.root.appendChild(this.potSlots)

    this.previewBox = document.createElement('div')
    this.previewBox.style.cssText = 'text-align:center;min-height:22px;color:#9fc3e8;margin-bottom:12px'
    this.previewBox.textContent = '点选下面的食材放进锅里'
    this.root.appendChild(this.previewBox)

    // 食材架
    this.shelf = document.createElement('div')
    this.shelf.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-height:200px;overflow:auto;margin-bottom:14px'
    this.root.appendChild(this.shelf)

    const buttonRow = document.createElement('div')
    buttonRow.style.cssText = 'display:flex;gap:12px;justify-content:center'

    this.cookButton = document.createElement('button')
    this.cookButton.textContent = '下锅！'
    this.cookButton.style.cssText = [
      'padding:8px 34px', 'font-size:14px', 'cursor:pointer',
      'background:#b4622a', 'color:#fff', 'border:none', 'border-radius:8px',
      'letter-spacing:0.2em',
    ].join(';')
    this.cookButton.addEventListener('click', () => this.cook())
    buttonRow.appendChild(this.cookButton)

    const closeButton = document.createElement('button')
    closeButton.textContent = '离开'
    closeButton.style.cssText = [
      'padding:8px 24px', 'font-size:13px', 'cursor:pointer',
      'background:rgba(60,80,100,0.5)', 'color:#cfe3f5',
      'border:1px solid rgba(120,150,180,0.35)', 'border-radius:8px',
    ].join(';')
    closeButton.addEventListener('click', () => this.close())
    buttonRow.appendChild(closeButton)
    this.root.appendChild(buttonRow)

    const hint = document.createElement('div')
    hint.textContent = 'Esc 关闭 · 做饭时世界不会暂停，小心背后的狼'
    hint.style.cssText = 'text-align:center;margin-top:10px;font-size:11px;color:#6d849c'
    this.root.appendChild(hint)

    document.body.appendChild(this.root)
  }

  get isOpen(): boolean {
    return this.root.style.display !== 'none'
  }

  open(inventory: Inventory): void {
    if (this.isOpen) return
    this.pot.length = 0
    this.root.style.display = 'block'
    this.render(inventory)
    this.onOpenChange?.(true)
  }

  close(): void {
    if (!this.isOpen) return
    // 锅里的食材退回背包由外部处理：onOpenChange(false) 时
    // 外部读 pendingIngredients 退还
    this.root.style.display = 'none'
    this.onOpenChange?.(false)
  }

  /** 锅里还没结算的食材（关闭时要退还给玩家） */
  get pendingIngredients(): readonly ItemId[] {
    return this.pot
  }

  clearPot(): void {
    this.pot.length = 0
  }

  /** 背包变化后刷新界面（烹饪结算完继续煮下一锅） */
  refresh(inventory: Inventory): void {
    if (this.isOpen) this.render(inventory)
  }

  private render(inventory: Inventory): void {
    // ── 锅 ──
    this.potSlots.textContent = ''
    for (let i = 0; i < POT_SLOTS; i++) {
      const slot = document.createElement('div')
      const id = this.pot[i]
      slot.style.cssText = [
        'width:86px', 'height:64px', 'border-radius:10px',
        'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center', 'gap:4px',
        id
          ? 'background:rgba(60,44,30,0.9);border:1px solid rgba(232,162,60,0.6);cursor:pointer'
          : 'background:rgba(30,40,52,0.6);border:1px dashed rgba(120,150,180,0.35)',
      ].join(';')
      if (id) {
        const def = ITEM_DEFS[id]
        const dot = document.createElement('div')
        dot.style.cssText = `width:22px;height:22px;border-radius:50%;background:#${def.color.toString(16).padStart(6, '0')};box-shadow:0 0 8px rgba(255,200,120,0.4)`
        const name = document.createElement('div')
        name.textContent = def.name
        name.style.cssText = 'font-size:11px'
        slot.append(dot, name)
        // 点锅里的食材拿回来
        slot.title = '点一下拿回来'
        slot.addEventListener('click', () => {
          inventory.add(id)
          this.pot.splice(i, 1)
          this.render(inventory)
        })
      } else {
        slot.textContent = '空'
        slot.style.color = '#5d748c'
        slot.style.fontSize = '12px'
      }
      this.potSlots.appendChild(slot)
    }

    // ── 预览 ──
    const plan = planDish(this.pot)
    this.previewBox.textContent = plan
      ? `${plan.preview} → ${ITEM_DEFS[plan.dish].name}`
      : '点选下面的食材放进锅里'
    this.previewBox.style.color = plan ? '#ffe9a8' : '#9fc3e8'

    // ── 食材架 ──
    this.shelf.textContent = ''
    let any = false
    for (const def of Object.values(ITEM_DEFS)) {
      if (!def.cookable) continue
      const count = inventory.count(def.id)
      if (count <= 0) continue
      any = true
      const item = document.createElement('div')
      item.style.cssText = [
        'padding:6px 10px', 'border-radius:8px', 'cursor:pointer',
        'background:rgba(30,42,56,0.85)', 'border:1px solid rgba(120,150,180,0.3)',
        'display:flex', 'align-items:center', 'gap:7px', 'user-select:none',
      ].join(';')
      const dot = document.createElement('span')
      dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:#${def.color.toString(16).padStart(6, '0')}`
      const label = document.createElement('span')
      label.textContent = `${def.name} ×${count}`
      item.append(dot, label)
      item.title = def.desc
      item.addEventListener('click', () => {
        if (this.pot.length >= POT_SLOTS) return
        if (!inventory.remove(def.id)) return
        this.pot.push(def.id)
        this.render(inventory)
      })
      this.shelf.appendChild(item)
    }
    if (!any) {
      this.shelf.textContent = '背包里没有能下锅的东西——去摘点果子、打只野兽再来'
      this.shelf.style.color = '#6d849c'
    }

    this.cookButton.disabled = this.pot.length === 0
    this.cookButton.style.opacity = this.pot.length === 0 ? '0.4' : '1'
  }

  private cook(): void {
    const plan = planDish(this.pot)
    if (!plan) return
    const ingredients = [...this.pot]
    this.pot.length = 0
    this.onCook?.(ingredients, plan.dish)
    // 界面由 onCook 回调关闭（它要刷新背包显示）
  }
}
