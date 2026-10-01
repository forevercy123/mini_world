/**
 * 敌人的种类。
 *
 * 之前全场只有一种骷髅，血量、速度、掉落完全一样——打了十只之后，
 * 玩家就摸清了"敌人"这个词的全部含义，战斗不再有变数。
 *
 * 三种之间不是单纯的数值缩放，而是**逼玩家换打法**：
 *  - 小兵：三两下砍死，用来垫节奏
 *  - 战士：血厚、攻击慢，硬拼会亏血，得躲开它的前摇再打
 *  - 精英：又厚又疼，是"要不要打"的判断题——打赢得用好几次闪避
 *
 * 掉落也拉开档次：骨头是硬通货，精英额外掉向阳果。
 */

import type { EnemyConfig } from './enemy.ts'
import type { ItemId } from '../gameplay/inventory.ts'

export type EnemyKind = 'minion' | 'warrior' | 'elite'

export interface EnemyKindDef {
  /** 中文名，用于提示 */
  name: string
  /** 用哪个模型 */
  model: 'minion' | 'warrior'
  /** 体型倍率 */
  scale: number
  /** 覆盖默认配置的那几项 */
  config: Partial<EnemyConfig>
  /** 掉落的物品 */
  loot: ItemId[]
}

export const ENEMY_KINDS: Record<EnemyKind, EnemyKindDef> = {
  minion: {
    name: '骷髅兵',
    model: 'minion',
    scale: 1,
    config: { maxHealth: 3, moveSpeed: 3.4, damage: 1, attackDuration: 0.72 },
    loot: ['bone'],
  },
  warrior: {
    name: '骷髅战士',
    model: 'warrior',
    scale: 1.12,
    // 攻击动作拉长到 0.95 秒：前摇更长，玩家有更充裕的窗口躲开，
    // 但挨一下掉两颗心——这是"看清再打"的教学
    config: { maxHealth: 6, moveSpeed: 3.1, damage: 2, attackDuration: 0.95, attackHitTime: 0.44 },
    loot: ['bone', 'bone'],
  },
  elite: {
    name: '骸骨卫队长',
    model: 'warrior',
    scale: 1.34,
    config: {
      maxHealth: 12,
      moveSpeed: 3.8,
      damage: 2,
      attackDuration: 0.85,
      attackHitTime: 0.4,
      aggroRange: 26,
      // 脱战距离必须大于警戒距离，否则玩家一跑它就在两个状态间抖
      leashRange: 42,
    },
    loot: ['bone', 'bone', 'bone', 'sunfruit'],
  },
}
