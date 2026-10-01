/**
 * 支线任务。
 *
 * 主线是"世界要你做的事"，支线是"某个人要你做的事"。两者的差别不在
 * 大小，而在**谁在说**——主线里贤者讲的是大陆的命运，支线里樵夫只关心
 * 自己的斧头。有这几句闲话，世界才不像一个只等你通关的布景。
 *
 * 结构上刻意做得很小：一个 NPC、一样东西、几句对话。够短，玩家听完就
 * 知道该去干嘛；也够轻，不需要为它加任何新的 UI——复用主线的对话框和
 * 任务栏。
 */

import type { ItemId } from './inventory.ts'
import type { DialogueLine } from '../ui/dialogue.ts'

export type SideQuestState = 'unmet' | 'active' | 'ready' | 'done'

export interface SideQuestDef {
  id: string
  /** 发布这条支线的 NPC */
  npcId: string
  title: string
  /** 交付所需的物品 */
  requires: ReadonlyArray<{ id: ItemId; count: number }>
  /** 完成后的报酬 */
  reward: ReadonlyArray<{ id: ItemId; count: number }>
  lines: {
    /** 第一次搭话：交代来意 */
    offer: readonly DialogueLine[]
    /** 已经接了但东西还没凑齐 */
    progress: readonly DialogueLine[]
    /** 东西齐了，交付 */
    deliver: readonly DialogueLine[]
    /** 完成之后的闲聊 */
    done: readonly DialogueLine[]
  }
}

/** 需求写成中文，显示在任务栏上 */
export function describeNeeds(def: SideQuestDef): string {
  const NAMES: Partial<Record<ItemId, string>> = {
    bone: '骷髅骨',
    berry: '野莓',
    sunfruit: '向阳果',
    mushroom: '野蘑菇',
  }
  return def.requires
    .map((r) => `${NAMES[r.id] ?? r.id} ×${r.count}`)
    .join('、')
}

export class SideQuestLog {
  private readonly accepted = new Set<string>()
  private readonly completed = new Set<string>()

  constructor(private readonly defs: readonly SideQuestDef[]) {}

  get all(): readonly SideQuestDef[] {
    return this.defs
  }

  byNpc(npcId: string): SideQuestDef | null {
    return this.defs.find((d) => d.npcId === npcId) ?? null
  }

  /**
   * 当前状态。`ready` 需要传入背包才能算出来——它取决于玩家手上有多少东西，
   * 而那是个一直在变的外部状态
   */
  stateOf(id: string, has: (item: ItemId, count: number) => boolean): SideQuestState {
    if (this.completed.has(id)) return 'done'
    if (!this.accepted.has(id)) return 'unmet'
    const def = this.defs.find((d) => d.id === id)
    if (!def) return 'unmet'
    return def.requires.every((r) => has(r.id, r.count)) ? 'ready' : 'active'
  }

  isAccepted(id: string): boolean {
    return this.accepted.has(id)
  }

  accept(id: string): void {
    this.accepted.add(id)
  }

  complete(id: string): void {
    this.accepted.add(id)
    this.completed.add(id)
  }

  /** 还没完成的支线里，挑一条给任务栏用 */
  activeDefs(): SideQuestDef[] {
    return this.defs.filter((d) => this.accepted.has(d.id) && !this.completed.has(d.id))
  }

  get completedCount(): number {
    return this.completed.size
  }

  toSave(): { accepted: string[]; completed: string[] } {
    return { accepted: [...this.accepted], completed: [...this.completed] }
  }

  restore(data: { accepted?: string[]; completed?: string[] } | undefined): void {
    this.accepted.clear()
    this.completed.clear()
    // 只认当前定义里存在的 id：删掉某条支线之后，旧存档不该把它带回来
    const known = new Set(this.defs.map((d) => d.id))
    for (const id of data?.accepted ?? []) if (known.has(id)) this.accepted.add(id)
    for (const id of data?.completed ?? []) if (known.has(id)) this.completed.add(id)
  }
}

/**
 * 两条支线。
 *
 * 一条要"打来的东西"（骨头），一条要"捡来的东西"（蘑菇）——让玩家把
 * 战斗和采集两种玩法各走一遍，而不是两条都去砍怪。
 */
export const SIDE_QUESTS: readonly SideQuestDef[] = [
  {
    id: 'woodcutter-handle',
    npcId: 'woodcutter',
    title: '樵夫的斧柄',
    requires: [{ id: 'bone', count: 3 }],
    reward: [
      { id: 'sunfruit', count: 2 },
      { id: 'berry', count: 2 },
    ],
    lines: {
      offer: [
        { speaker: '樵夫', text: '哎，正好。我那把斧头的柄裂了，砍不动柴。' },
        { speaker: '樵夫', text: '这林子里到处是骷髅，它们的骨头结实。给我带三块回来，我给你点好东西。' },
      ],
      progress: [
        { speaker: '樵夫', text: '三块骨头，从骷髅身上敲下来就行。它们最近挺多的，小心点。' },
      ],
      deliver: [
        { speaker: '樵夫', text: '就是这块料！你看这纹路，比什么木头都结实。' },
        { speaker: '樵夫', text: '拿去吧，我老婆晒的果干。路上饿了啃一口。' },
      ],
      done: [
        { speaker: '樵夫', text: '新柄好使得很。等我把这片林子清出来，就盖间屋子。' },
      ],
    },
  },
  {
    id: 'sage-mushrooms',
    npcId: 'sage',
    title: '贤者的药草',
    requires: [{ id: 'mushroom', count: 5 }],
    reward: [
      { id: 'sunfruit', count: 3 },
    ],
    lines: {
      offer: [
        { speaker: '贤者', text: '你手上的伤，光靠果子是压不住的。' },
        { speaker: '贤者', text: '林子里的野蘑菇能熬药。给我采五个来，我多给你备些干粮。' },
      ],
      progress: [
        { speaker: '贤者', text: '蘑菇在林子深处，红色的那种。五个，不急。' },
      ],
      deliver: [
        { speaker: '贤者', text: '够新鲜。放在火上焙一焙，能存很久。' },
        { speaker: '贤者', text: '答应你的干粮，拿好。' },
      ],
      done: [
        { speaker: '贤者', text: '药我熬上了。你自己也多留神，暗蚀的东西不睡觉。' },
      ],
    },
  },
]
