/**
 * 武器栏 HUD。
 *
 * 右下角竖排的一列格子：玩家随时要知道三件事——手上拿的是什么、
 * 还能砍几下、袋里还有什么备选。塞尔达把武器放在轮盘里，那是
 * 手柄的交互；键盘上数字键直选更顺手，所以格子要够小、够靠边，
 * 不挡画面但一眼能扫到。
 */

import { WEAPON_DEFS, type WeaponBag } from '../gameplay/weapons.ts'

/** 稀有度对应的边框色。和地图上的光柱颜色一致，玩家能把两者对上 */
const RARITY_BORDER: Record<string, string> = {
  common: 'rgba(150,160,150,0.55)',
  rare: 'rgba(90,170,255,0.8)',
  epic: 'rgba(255,190,90,0.9)',
}

export class WeaponHud {
  private readonly root: HTMLDivElement
  private lastVersion = -1

  constructor() {
    this.root = document.createElement('div')
    this.root.id = 'weapon-hud'
    this.root.style.cssText = [
      'position:fixed', 'right:22px', 'bottom:80px',
      'display:flex', 'flex-direction:column-reverse', 'gap:8px',
      'z-index:1010', 'pointer-events:none',
      'font:12px/1.4 -apple-system,"PingFang SC",system-ui,sans-serif',
    ].join(';')
    document.body.appendChild(this.root)
  }

  /** 背包版本变了才重排 DOM——每帧重建会闪烁 */
  update(bag: WeaponBag): void {
    if (bag.version === this.lastVersion) return
    this.lastVersion = bag.version

    this.root.textContent = ''
    const slots = bag.all

    if (slots.length === 0) {
      this.root.appendChild(this.slot('空手', null, 0, 0, true, 'unarmed'))
      return
    }

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]
      const def = WEAPON_DEFS[slot.id]
      this.root.appendChild(
        this.slot(
          def.name,
          `${i + 1}`,
          slot.durability / def.durability,
          slot.durability,
          i === bag.index,
          def.rarity,
          // 远程武器：弹药数比耐久更要紧，直接标在名字后面
          def.moveset === 'shoot' ? bag.arrows : null,
        ),
      )
    }
  }

  private slot(
    name: string,
    key: string | null,
    durabilityRatio: number,
    durability: number,
    active: boolean,
    rarity: string,
    arrows: number | null = null,
  ): HTMLDivElement {
    const box = document.createElement('div')
    box.style.cssText = [
      'min-width:118px', 'padding:7px 10px', 'border-radius:8px',
      `background:${active ? 'rgba(26,40,54,0.92)' : 'rgba(10,16,22,0.72)'}`,
      `border:1px solid ${active ? RARITY_BORDER[rarity] : 'rgba(90,110,130,0.28)'}`,
      `color:${active ? '#eaf2fb' : '#8ba2b8'}`,
      active ? 'box-shadow:0 0 14px rgba(90,170,255,0.25)' : '',
      'transition:border-color 0.2s',
    ].join(';')

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:8px'
    const label = document.createElement('span')
    label.textContent = arrows !== null ? `${name} · 箭 ${arrows}` : name
    label.style.cssText = active ? 'font-weight:600' : ''
    row.appendChild(label)
    if (key) {
      const k = document.createElement('span')
      k.textContent = key
      k.style.cssText = [
        'font-size:10px', 'color:#7d94ac', 'border:1px solid rgba(120,150,180,0.4)',
        'border-radius:3px', 'padding:0 4px',
      ].join(';')
      row.appendChild(k)
    }
    box.appendChild(row)

    // 耐久条：只在当前武器上展开。非当前武器显示一条细线提示还剩多少
    const bar = document.createElement('div')
    bar.style.cssText = [
      'margin-top:5px', 'height:3px', 'border-radius:2px',
      'background:rgba(60,80,100,0.5)', 'overflow:hidden',
    ].join(';')
    const fill = document.createElement('div')
    // 快碎的时候变红：玩家扫一眼就知道该换武器了
    const hue = durabilityRatio > 0.35 ? '#7fd08a' : durabilityRatio > 0.15 ? '#e8c25a' : '#e06a5a'
    fill.style.cssText = `height:100%;width:${Math.round(durabilityRatio * 100)}%;background:${hue};border-radius:2px`
    bar.appendChild(fill)
    box.appendChild(bar)

    if (active && durability > 0) {
      const num = document.createElement('div')
      num.textContent = `耐久 ${durability}`
      num.style.cssText = 'margin-top:3px;font-size:10px;color:#8ba2b8;text-align:right'
      box.appendChild(num)
    }
    return box
  }
}
