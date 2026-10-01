/**
 * 烹饪配方。
 *
 * 塞尔达的锅是个"组合即惊喜"的系统：玩家往锅里扔什么、
 * 出来什么，规则简单但有发现感。这里也一样——不列配方表
 * 让玩家背，而是几条直觉规则：
 *
 *   有向阳果 → 阳光炖菜（回满）。向阳果金贵，值得这个效果
 *   肉 + 蘑菇 → 鲜肉蘑菇串。山珍配肉，经典搭配
 *   只有肉   → 烤肉串，肉越多串越大
 *   只有菌   → 烤蘑菇串
 *   水果们   → 水果拼盘
 *   剩下的   → 大杂烩，回血 = 食材总和 × 1.5
 *
 * 纯逻辑模块，不碰渲染与 DOM，方便验证脚本直接调。
 */

import { ITEM_DEFS, type ItemId } from './inventory.ts'

/** 一锅最多下几样食材。太多会让"乱炖"成为唯一最优解 */
export const POT_SLOTS = 3

export interface DishPlan {
  /** 产出的料理 */
  dish: ItemId
  /** 恢复的心数（99 = 完全恢复，由 useItem 特殊处理） */
  heal: number
  /** 给玩家看的一句话，烹饪界面实时预览 */
  preview: string
}

const countOf = (list: readonly ItemId[], id: ItemId): number =>
  list.reduce((n, x) => n + (x === id ? 1 : 0), 0)

/**
 * 按下锅的食材算产物。返回 null 表示锅里是空的。
 */
export function planDish(ingredients: readonly ItemId[]): DishPlan | null {
  if (ingredients.length === 0) return null

  const meat = countOf(ingredients, 'raw_meat')
  const mushroom = countOf(ingredients, 'mushroom')
  const berry = countOf(ingredients, 'berry')
  const apple = countOf(ingredients, 'apple')
  const sunny = countOf(ingredients, 'sunfruit')

  if (sunny > 0) {
    return {
      dish: 'dish_sunny',
      heal: ITEM_DEFS.dish_sunny.heal,
      preview: '金色汤汁翻滚——是阳光炖菜！',
    }
  }

  if (meat > 0 && mushroom > 0) {
    return {
      dish: 'dish_meat_mushroom',
      heal: ITEM_DEFS.dish_meat_mushroom.heal,
      preview: '肉和蘑菇的香味缠在一起',
    }
  }

  if (meat > 0 && mushroom === 0) {
    // 纯肉下锅就是烤肉串。多放肉不多回血——收益递减是锅的规则，
    // 想回血多就得换搭配，而不是堆同一种食材
    return {
      dish: 'dish_skewer',
      heal: ITEM_DEFS.dish_skewer.heal,
      preview: '肉串在火上滋滋作响（4 颗心）',
    }
  }

  if (mushroom >= 2 && meat === 0) {
    return {
      dish: 'dish_mushroom',
      heal: ITEM_DEFS.dish_mushroom.heal,
      preview: '蘑菇烤出了焦香（3 颗心）',
    }
  }

  if (meat === 0 && apple + berry >= 2 && mushroom === 0) {
    return {
      dish: 'dish_fruit',
      heal: ITEM_DEFS.dish_fruit.heal,
      preview: '水果的甜味飘出来了（3 颗心）',
    }
  }

  // 大杂烩：回血比生吃略赚一点，鼓励玩家"什么都试试"
  return {
    dish: 'dish_mixed',
    heal: ITEM_DEFS.dish_mixed.heal,
    preview: '香味……有点复杂（4 颗心）',
  }
}

/** 背包装得下的可下锅食材清单 */
export function cookableItems(
  counts: (id: ItemId) => number,
): Array<{ def: (typeof ITEM_DEFS)[ItemId]; count: number }> {
  const out: Array<{ def: (typeof ITEM_DEFS)[ItemId]; count: number }> = []
  for (const def of Object.values(ITEM_DEFS)) {
    if (!def.cookable) continue
    const n = counts(def.id)
    if (n > 0) out.push({ def, count: n })
  }
  return out
}
