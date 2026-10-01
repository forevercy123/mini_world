/**
 * 剧情导演：把「玩家走到哪、该发生什么」集中在一处。
 *
 * 这些逻辑本来可以散在 main.ts 的 update 里，但那样主循环会变成一个
 * 三百行的 if 瀑布，而且每加一段剧情都要再往里面塞。这里做成一个显式的
 * 状态推进器：每帧喂它玩家位置，它吐出一串**事件**，由调用方决定怎么
 * 播报、怎么刷怪、怎么记档。
 *
 * 每座祭坛是一台独立的小状态机：
 *
 *   dormant ──玩家靠近──▶ fighting ──守卫全灭──▶ claimed
 *
 * 之所以要中间的 fighting 态，是因为"靠近即得"会让整条主线退化成
 * 跑图——祭坛必须是一场要打的仗，玩家才会记得自己夺回过什么。
 */

import { Vector3 } from 'three'
import type { Enemy, EnemyConfig } from '../entities/enemy.ts'
import type { EnemyKind } from '../entities/enemyKind.ts'
import type { EnemyManager } from '../entities/enemyManager.ts'
import type { Heightfield } from '../terrain/heightfield.ts'
import type { LandmarkField } from '../world/landmarks.ts'
import { SEALS, type Quest, type SealKind } from './quest.ts'

/** 触发祭坛守卫战的距离 */
const ALTAR_TRIGGER = 7
/** 开门需要的距离 */
const GATE_TRIGGER = 8
/** 进入竞技场的判定距离 */
const ARENA_TRIGGER = 16

export type StoryEvent =
  | { type: 'guardians'; seal: SealKind; count: number }
  | { type: 'seal'; seal: SealKind }
  | { type: 'gate-opened' }
  | { type: 'boss'; name: string }
  | { type: 'cleared' }

type AltarPhase = 'dormant' | 'fighting' | 'claimed'

interface AltarRuntime {
  phase: AltarPhase
  guardians: Enemy[]
}

/**
 * 祭坛守卫编成：两只小兵 + 一只战士。
 *
 * 清一色小兵会变成"砍三下、砍三下、砍三下"的重复劳动；混一只战士，
 * 玩家得在乱战里分辨哪只的起手更长、该先躲哪一个。
 */
const GUARDIAN_MIX: ReadonlyArray<{ kind: EnemyKind; count: number }> = [
  { kind: 'minion', count: 2 },
  { kind: 'warrior', count: 1 },
]

/** Boss 的额外强化：在精英的基础上再加一截，它是这条线的终点 */
const BOSS_CONFIG: Partial<EnemyConfig> = {
  maxHealth: 20,
  moveSpeed: 4.2,
  damage: 2,
  aggroRange: 40,
  // 脱战距离必须大于警戒距离，否则玩家一跑 boss 就在两个状态间抖动
  leashRange: 90,
}

export class StoryDirector {
  private readonly altars = new Map<SealKind, AltarRuntime>()
  private gateOpened = false
  private boss: Enemy | null = null
  private bossSpawned = false
  private cleared = false

  constructor(
    private readonly quest: Quest,
    private readonly landmarks: LandmarkField,
    private readonly enemies: EnemyManager,
  ) {
    for (const kind of SEALS) {
      this.altars.set(kind, { phase: 'dormant', guardians: [] })
    }
  }

  /** Boss 实体，供 HUD 画血条 */
  get bossEnemy(): Enemy | null {
    return this.boss
  }

  /** 某座祭坛的守卫是否还在（HUD 用来提示"先清场"） */
  guardiansRemaining(kind: SealKind): number {
    const runtime = this.altars.get(kind)
    if (!runtime || runtime.phase !== 'fighting') return 0
    return runtime.guardians.filter((g) => !g.health.isDead).length
  }

  /**
   * 推进一帧。返回这一帧发生的事件（通常是空的）。
   *
   * @param terrain 用于把怪刷在地表上
   */
  update(playerPos: Vector3, terrain: Heightfield): StoryEvent[] {
    const events: StoryEvent[] = []

    // ── 三座祭坛 ──
    for (const kind of SEALS) {
      const runtime = this.altars.get(kind)!
      if (runtime.phase === 'claimed') continue

      const site = this.landmarks.sites.altars[kind]
      const dist = Math.hypot(playerPos.x - site.x, playerPos.z - site.z)

      if (runtime.phase === 'dormant') {
        if (dist < ALTAR_TRIGGER) {
          let spawned = 0
          for (const part of GUARDIAN_MIX) {
            spawned += this.enemies.spawn(
              terrain,
              { count: part.count, center: new Vector3(site.x, 0, site.z), radius: 13, minRadius: 5 },
              part.kind,
            )
          }
          if (spawned > 0) {
            runtime.phase = 'fighting'
            // 只认刚刷出来的那几只：EnemyManager 是追加式的，
            // 取尾部 spawned 个就是本次的守卫
            const all = this.enemies.alive
            runtime.guardians = all.slice(Math.max(0, all.length - spawned))
            events.push({ type: 'guardians', seal: kind, count: spawned })
          }
        }
        continue
      }

      // fighting：等守卫全灭
      if (runtime.guardians.length > 0 && runtime.guardians.every((g) => g.health.isDead)) {
        runtime.phase = 'claimed'
        this.landmarks.activateAltar(kind)
        this.quest.collect(kind)
        events.push({ type: 'seal', seal: kind })
      }
    }

    // ── 封印之门 ──
    if (!this.gateOpened && this.quest.currentStage === 'gate') {
      const gate = this.landmarks.sites.gate
      if (Math.hypot(playerPos.x - gate.x, playerPos.z - gate.z) < GATE_TRIGGER) {
        this.gateOpened = true
        this.landmarks.setGateOpen(true)
        this.quest.openGate()
        events.push({ type: 'gate-opened' })
      }
    }

    // ── Boss ──
    if (this.quest.currentStage === 'boss' && !this.bossSpawned) {
      const arena = this.landmarks.sites.arena
      if (Math.hypot(playerPos.x - arena.x, playerPos.z - arena.z) < ARENA_TRIGGER) {
        const spawned = this.enemies.spawn(
          terrain,
          { count: 1, center: new Vector3(arena.x, 0, arena.z), radius: 10, minRadius: 8 },
          'elite',
          BOSS_CONFIG,
        )
        if (spawned > 0) {
          this.bossSpawned = true
          const all = this.enemies.alive
          this.boss = all[all.length - 1]
          // 在精英的体型上再放大一圈，远远看到就知道是它
          this.boss.object.scale.setScalar(1.6)
          events.push({ type: 'boss', name: '暗蚀骑士' })
        }
      }
    }

    if (this.bossSpawned && !this.cleared && this.boss?.health.isDead) {
      this.cleared = true
      this.quest.defeatBoss()
      events.push({ type: 'cleared' })
    }

    return events
  }
}
