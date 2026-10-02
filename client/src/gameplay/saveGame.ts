/**
 * 存档。
 *
 * 之前刷新页面就是从零开始——对一条二十分钟的主线来说，这个代价太大了。
 * 玩家打到第二座祭坛时误触刷新，一切归零，之后再也不会打开这个游戏。
 *
 * ── 为什么用 localStorage 而不是 IndexedDB ──
 *
 * 一份存档就是几 KB 的 JSON：进度、位置、背包、地图标记。localStorage
 * 的同步 API 对这点数据毫无压力，而 IndexedDB 要写一堆异步样板。
 * 等以后存档里要放地形改动（会到 MB 级）再换也来得及。
 *
 * ── 版本号是必需的 ──
 *
 * 读档时字段对不上会静默地得到一个半损坏的状态（比如任务卡在没有目标的
 * 阶段）。所以存一个版本号，不匹配就直接丢弃重来——丢掉一次进度，
 * 好过让玩家卡在一个走不下去的世界里。
 */

import type { SealKind, QuestStage } from './quest.ts'
import type { ItemId } from './inventory.ts'
import type { WeaponId } from './weapons.ts'

const STORAGE_KEY = 'lightland-save'
/** 存档格式版本。改动字段含义时必须递增 */
const SAVE_VERSION = 1

export interface SaveData {
  version: number
  /** 保存时刻（毫秒时间戳），用于在界面上显示"上次游玩" */
  savedAt: number
  /** 累计游玩时长（秒） */
  playtime: number

  quest: {
    stage: QuestStage
    /** 已收集的封印 */
    seals: SealKind[]
    sageTalked: boolean
    bossDefeated: boolean
  }

  player: {
    x: number
    z: number
    yaw: number
    /** 当前生命值（心数） */
    health: number
  }

  inventory: Partial<Record<ItemId, number>>
  /** 玩家在地图上打的标记 */
  pins: Array<{ x: number; z: number }>
  /**
   * 已开启的宝箱 id。
   * 做成可选字段是为了兼容旧存档——缺这一项时按"全都还没开"处理，
   * 比直接判版本不符把玩家进度丢掉温和得多
   */
  treasures?: string[]
  /** 支线进度。同样可选，旧存档按"一条都没接"处理 */
  sideQuests?: { accepted?: string[]; completed?: string[] }
  /** 武器袋：每把武器自己的耐久。旧存档没有它，开局给一根树枝 */
  weapons?: { slots?: Array<{ id: WeaponId; durability: number }>; current?: number }
  /** 已被拔走的武器点编号。旧存档按"都在原地"处理 */
  weaponSpawnsTaken?: number[]
  /** 已通关的神庙 id。旧存档按"都没打过"处理 */
  shrines?: string[]
  /** 心之容器撑起来的生命上限。旧存档缺省为初始 6 */
  maxHearts?: number
}

/** 存档是否可用的判断结果 */
export type LoadResult =
  | { ok: true; data: SaveData }
  | { ok: false; reason: 'empty' | 'corrupt' | 'version' }

export class SaveManager {
  /** 距离上次写入过了多久（秒），用于节流 */
  private sinceWrite = 0
  private playtime = 0

  /** 自动保存间隔。太密会频繁触发同步 IO，太疏丢的进度多 */
  static readonly INTERVAL = 25

  constructor(private readonly enabled = true) {}

  get isEnabled(): boolean {
    return this.enabled
  }

  /** 本次会话累计的游玩时长（秒）。通关结算要显示它 */
  get elapsedSeconds(): number {
    return this.playtime
  }

  /**
   * 每帧推进计时，到点就调 collect 拿数据写盘。
   * @param collect 由调用方组装当前世界状态
   */
  tick(dt: number, collect: () => Omit<SaveData, 'version' | 'savedAt' | 'playtime'>): void {
    if (!this.enabled) return
    this.playtime += dt
    this.sinceWrite += dt
    if (this.sinceWrite < SaveManager.INTERVAL) return
    this.sinceWrite = 0
    this.save(collect())
  }

  /** 立即保存（关键节点：拿到封印、通关、离开页面时调用） */
  save(data: Omit<SaveData, 'version' | 'savedAt' | 'playtime'>): boolean {
    if (!this.enabled) return false
    const payload: SaveData = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      playtime: Math.round(this.playtime),
      ...data,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      return true
    } catch (err) {
      // 隐私模式、配额用尽都会抛。存档失败不该让游戏崩掉
      console.warn('[存档] 写入失败：', err)
      return false
    }
  }

  load(): LoadResult {
    if (!this.enabled) return { ok: false, reason: 'empty' }
    let raw: string | null = null
    try {
      raw = localStorage.getItem(STORAGE_KEY)
    } catch {
      return { ok: false, reason: 'empty' }
    }
    if (!raw) return { ok: false, reason: 'empty' }

    try {
      const data = JSON.parse(raw) as SaveData
      if (typeof data !== 'object' || data === null) return { ok: false, reason: 'corrupt' }
      if (data.version !== SAVE_VERSION) {
        console.warn(`[存档] 版本不匹配（存档 ${data.version}，当前 ${SAVE_VERSION}），已忽略`)
        return { ok: false, reason: 'version' }
      }
      if (!data.quest || !data.player) return { ok: false, reason: 'corrupt' }
      this.playtime = data.playtime ?? 0
      return { ok: true, data }
    } catch (err) {
      console.warn('[存档] 解析失败：', err)
      return { ok: false, reason: 'corrupt' }
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 清不掉也无所谓
    }
    this.playtime = 0
    this.sinceWrite = 0
  }

  /** 存档摘要，用于在标题或帮助面板里显示"上次玩到哪" */
  peek(): SaveData | null {
    const result = this.load()
    return result.ok ? result.data : null
  }
}

/** 把秒数写成"1 小时 23 分"这样的中文 */
export function formatPlaytime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
