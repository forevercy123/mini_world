/**
 * 敌人的生成与生命周期管理。
 *
 * 生成点会避开水面与陡坡——把怪刷在湖中央或崖壁上，玩家既够不着也打不了，
 * 只会让人困惑。死亡的敌人播完倒地动画后从场景移除并释放资源。
 */

import { Group, Vector3, type Camera } from 'three'
import { Enemy, type EnemyConfig } from './enemy.ts'
import type { SkeletonTemplate } from './enemySkeleton.ts'
import { EnemyHealthBar } from './enemyHealthBar.ts'
import { ENEMY_KINDS, type EnemyKind } from './enemyKind.ts'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'

export interface SpawnOptions {
  /** 生成数量 */
  count: number
  /** 生成区域中心 */
  center: Vector3
  /** 生成区域半径 */
  radius: number
  /** 与中心的最近距离，避免刷在玩家脸上 */
  minRadius?: number
}

export class EnemyManager {
  readonly group = new Group()
  private readonly enemies: Enemy[] = []
  /**
   * 骨骼模型模板。异步加载，比世界构建晚到；没到之前生成的敌人用
   * 手写外观，到货之后新生成的才是骷髅。实际玩法里敌人是在启动时
   * 一次性生成的，所以调用方会等模板就位再 spawn。
   */
  private readonly skeletons = new Map<'minion' | 'warrior', SkeletonTemplate>()

  constructor() {
    this.group.name = 'enemies'
  }

  /** 注入骷髅模板。必须在 spawn 之前调用才会生效 */
  setSkeleton(kind: 'minion' | 'warrior', template: SkeletonTemplate | null): void {
    if (template) this.skeletons.set(kind, template)
  }

  /** 有几种模型就报几种，用于启动日志 */
  get loadedKinds(): string[] {
    return [...this.skeletons.keys()]
  }

  /** 当前存活（未死亡）的敌人，供战斗判定使用 */
  get alive(): readonly Enemy[] {
    return this.enemies
  }

  get totalCount(): number {
    return this.enemies.length
  }

  /**
   * 生成敌人。
   * @param kind 种类，决定模型、体型、数值与掉落
   */
  spawn(
    terrain: Heightfield,
    opts: SpawnOptions,
    kind: EnemyKind = 'minion',
    configOverride: Partial<EnemyConfig> = {},
  ): number {
    const def = ENEMY_KINDS[kind]
    // 种类自带的配置打底，调用方传的覆盖它（剧情里的守卫、Boss 走这条路）
    const config: Partial<EnemyConfig> = { ...def.config, ...configOverride }
    const template = this.skeletons.get(def.model) ?? null
    const minR = opts.minRadius ?? 12
    let spawned = 0
    // 随机撒点的失败率不低（可能落在水里或陡坡上），设置尝试上限避免死循环
    const maxAttempts = opts.count * 30
    let attempts = 0

    while (spawned < opts.count && attempts < maxAttempts) {
      attempts++
      const angle = Math.random() * Math.PI * 2
      const r = minR + Math.random() * Math.max(1, opts.radius - minR)
      const x = opts.center.x + Math.cos(angle) * r
      const z = opts.center.z + Math.sin(angle) * r

      if (!this.isSpawnable(terrain, x, z)) continue

      const enemy = new Enemy(config, template)
      // 体型差异用世界缩放表达。碰撞体不跟着放大——放大会让精英怪
      // 卡在树间过不来，而玩家看得出它"大一圈"就够了
      if (def.scale !== 1) enemy.object.scale.setScalar(def.scale)
      enemy.spawnAt(x, z, terrain)
      enemy.kind = kind
      this.enemies.push(enemy)
      this.group.add(enemy.object)
      // 血条挂在这一层：这里的节点没有旋转，血条才能自己朝向镜头
      this.group.add(enemy.healthBar.object)
      spawned++
    }

    return spawned
  }

  private isSpawnable(terrain: Heightfield, x: number, z: number): boolean {
    const h = terrain.height(x, z)
    // 水面之下不刷（会变成泡在水里的怪），陡坡也不刷
    if (h < WATER_LEVEL + 1.5) return false
    if (terrain.slopeAngle(x, z) > MAX_SPAWN_SLOPE) return false
    return true
  }

  update(
    dt: number,
    playerPos: Vector3,
    terrain: Heightfield,
    onDamagePlayer: (amount: number, fromPos: Vector3) => void,
    camera?: Camera,
  ): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]
      enemy.update(dt, playerPos, terrain, onDamagePlayer)

      // 血条按敌人的世界坐标摆放，再朝向镜头
      const bar = enemy.healthBar
      bar.object.position.set(
        enemy.position.x,
        enemy.position.y + EnemyHealthBar.offsetY,
        enemy.position.z,
      )
      if (camera) bar.update(dt, camera)

      if (enemy.expired) {
        this.group.remove(enemy.object)
        this.group.remove(bar.object)
        enemy.dispose()
        this.enemies.splice(i, 1)
      }
    }
  }

  /** 存活敌人数（不含正在播死亡动画的） */
  get livingCount(): number {
    let n = 0
    for (const e of this.enemies) if (!e.health.isDead) n++
    return n
  }

  dispose(): void {
    for (const e of this.enemies) {
      this.group.remove(e.object)
      this.group.remove(e.healthBar.object)
      e.dispose()
    }
    this.enemies.length = 0
  }
}

/** 陡坡上不刷怪：玩家够不着，敌人自己也会卡住 */
const MAX_SPAWN_SLOPE = (35 * Math.PI) / 180
