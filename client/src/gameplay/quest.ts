/**
 * 主线任务：光之大陆的封印。
 *
 * 结构上是一条单线：醒来 → 找到贤者 → 集齐三枚元素封印 → 打开封印之门
 * → 击败暗蚀骑士。三枚封印之间没有先后要求，玩家想去哪座祭坛就去哪座，
 * 这是塞尔达式开放世界的底线——**主线可以是一条线，但线要挂在玩家自己
 * 走过去的地方**，而不是"必须先去 A 再去 B"。
 *
 * 这个类只存状态和规则，不碰渲染、不碰输入。谁触发、怎么显示都由调用方
 * 决定，所以它可以在没有浏览器的环境里单独测。
 */

export type SealKind = 'fire' | 'ice' | 'wind'

/** 三种封印的元数据。顺序就是 UI 上的显示顺序 */
export const SEALS: readonly SealKind[] = ['fire', 'ice', 'wind']

export const SEAL_INFO: Record<SealKind, { name: string; title: string; hint: string }> = {
  fire: { name: '火之封印', title: '火之祭坛', hint: '沿东北的路穿过低语森林，山坡上的石台，火盆还冷着' },
  ice: { name: '冰之封印', title: '冰之祭坛', hint: '沿南边的路到明镜湖，湖心岛上——水面挡着去路' },
  wind: { name: '风之封印', title: '风之祭坛', hint: '沿北边的路爬上苍雪峰，断崖之巅，得借风飞上去' },
}

export type QuestStage =
  /** 序章：在草原上醒来，去找贤者 */
  | 'awaken'
  /** 与贤者对话之后，三座祭坛任选 */
  | 'seals'
  /** 三枚集齐，去封印之门 */
  | 'gate'
  /** 门开了，击败暗蚀骑士 */
  | 'boss'
  /** 通关 */
  | 'cleared'

/** 当前该做什么。target 是给导航箭头用的世界坐标，null 表示没有具体地点 */
export interface Objective {
  text: string
  target: { x: number; z: number } | null
}

/** 一处地标的位置。由 landmarks 扫描地形决定，任务系统只消费它 */
export interface LandmarkSites {
  sage: { x: number; z: number }
  altars: Record<SealKind, { x: number; z: number }>
  gate: { x: number; z: number }
  arena: { x: number; z: number }
}

export class Quest {
  private stage: QuestStage = 'awaken'
  private readonly collected = new Set<SealKind>()
  /** 与贤者的对话是否已完成 */
  sageTalked = false
  /** 暗蚀骑士是否已被击败 */
  bossDefeated = false

  constructor(private readonly sites: LandmarkSites) {}

  get currentStage(): QuestStage {
    return this.stage
  }

  has(kind: SealKind): boolean {
    return this.collected.has(kind)
  }

  get remaining(): SealKind[] {
    return SEALS.filter((k) => !this.collected.has(k))
  }

  get collectedCount(): number {
    return this.collected.size
  }

  /** 收集一枚封印。返回 false 表示重复收集（调用方据此决定要不要提示） */
  collect(kind: SealKind): boolean {
    if (this.collected.has(kind)) return false
    this.collected.add(kind)

    // 集齐三枚就自动推进到"去开门"。不要求玩家回贤者那里交任务——
    // 回头路在这一版里没有任何新内容，纯粹是消耗耐心
    if (this.collected.size === SEALS.length && this.stage === 'seals') {
      this.stage = 'gate'
    }
    return true
  }

  /** 与贤者说完话 */
  completeIntroduction(): void {
    this.sageTalked = true
    if (this.stage === 'awaken') this.stage = 'seals'
  }

  /** 封印之门已开启 */
  openGate(): void {
    if (this.stage === 'gate') this.stage = 'boss'
  }

  /** 击败暗蚀骑士 */
  defeatBoss(): void {
    this.bossDefeated = true
    this.stage = 'cleared'
  }

  /** 导出进度。字段与 SaveData.quest 一一对应 */
  toSave(): { stage: QuestStage; seals: SealKind[]; sageTalked: boolean; bossDefeated: boolean } {
    return {
      stage: this.stage,
      seals: [...this.collected],
      sageTalked: this.sageTalked,
      bossDefeated: this.bossDefeated,
    }
  }

  /**
   * 从存档恢复。
   *
   * 不直接赋值 stage 而是重放"前进"动作：这样任何一条不变量（比如
   * stage 与封印数必须自洽）都由同一套代码保证，读档和正常游玩不会
   * 走出两个不同的状态
   */
  restore(data: {
    stage: QuestStage
    seals: SealKind[]
    sageTalked: boolean
    bossDefeated: boolean
  }): void {
    this.collected.clear()
    this.stage = 'awaken'
    this.sageTalked = false
    this.bossDefeated = false

    for (const seal of data.seals) this.collect(seal)
    if (data.sageTalked) this.completeIntroduction()
    if (this.collected.size === SEALS.length) {
      // collect 会把 stage 推到 gate，这里按存档继续往后推
      this.openGate()
    }
    if (data.bossDefeated) this.defeatBoss()
    // 最后以存档里的阶段为准，兜住任何顺序上的意外
    this.stage = data.stage
  }

  /** 当前目标。导航箭头与任务栏都读它 */
  get objective(): Objective {
    switch (this.stage) {
      case 'awaken':
        return { text: '和草原上的贤者谈谈', target: this.sites.sage }

      case 'seals': {
        // 指向最近的一枚未收集封印：让玩家少走冤枉路，但不限制顺序
        const nearest = this.remaining.reduce<SealKind | null>((best, kind) => {
          if (!best) return kind
          return this.sites.altars[kind].x ** 2 + this.sites.altars[kind].z ** 2 <
            this.sites.altars[best].x ** 2 + this.sites.altars[best].z ** 2
            ? kind
            : best
        }, null)

        if (!nearest) return { text: '前往封印之门', target: this.sites.gate }
        const info = SEAL_INFO[nearest]
        return {
          text: `${info.title}：${info.hint}（${this.collected.size}/3）`,
          target: this.sites.altars[nearest],
        }
      }

      case 'gate':
        return { text: '三枚封印已集齐，前往封印之门', target: this.sites.gate }

      case 'boss':
        return { text: '击败暗蚀骑士', target: this.sites.arena }

      case 'cleared':
        return { text: '光之大陆恢复了宁静', target: null }
    }
  }
}
