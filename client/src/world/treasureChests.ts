/**
 * 宝箱。
 *
 * 主线只有三座祭坛和一条通往 Boss 的路，玩家除了赶路没有别的理由拐弯。
 * 宝箱的作用是**给"拐弯"一个回报**——山顶、水边、林间空地上的箱子，
 * 是玩家自己发现的，不是任务栏指给他的。
 *
 * ── 位置是扫描出来的 ──
 *
 * 和地标同一套思路：按地形特征找"值得放东西的地方"。高点、水岸、
 * 密林深处各有各的诱惑力，写死坐标做不到这一点。
 *
 * ── 开过的箱子要记住 ──
 *
 * 已开启的状态进存档。不记的话，每次读档宝箱都会重新合上，
 * 玩家会以为自己的进度没保存。
 */

import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  Vector3,
} from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'
import type { ObstacleGrid } from '../physics/obstacleGrid.ts'
import type { ItemId } from '../gameplay/inventory.ts'

/** 一次开箱给几件东西 */
const LOOT_MIN = 2
const LOOT_MAX = 3
/** 走到多近能开 */
export const CHEST_RANGE = 2.6

export interface Chest {
  id: string
  position: Vector3
  opened: boolean
  /** 盖子绕后边缘转动的枢轴 */
  lid: Group
  /** 开盖动画进度 0–1 */
  openProgress: number
}

/** 一个箱子的掉落。确定性：同一个箱子每次开出同样的东西 */
function lootFor(index: number): ItemId[] {
  // 用箱子序号做种子，保证读档后开同一个箱子拿到同样的奖励
  const roll = (n: number): number => {
    let x = Math.imul(index * 2654435761 + n * 40503, 2246822519)
    x = (x ^ (x >>> 13)) >>> 0
    return x / 4294967296
  }
  const count = LOOT_MIN + Math.floor(roll(1) * (LOOT_MAX - LOOT_MIN + 1))
  const out: ItemId[] = []
  for (let i = 0; i < count; i++) {
    const r = roll(i + 10)
    // 骨头是硬通货，果子是补血——多数箱子两样都给一点
    out.push(r < 0.42 ? 'bone' : r < 0.82 ? 'berry' : 'sunfruit')
  }
  return out
}

export class TreasureField {
  readonly group = new Group()
  readonly chests: Chest[] = []

  private readonly woodMaterial: MeshLambertMaterial
  private readonly metalMaterial: MeshLambertMaterial
  private elapsed = 0

  constructor(
    hf: Heightfield,
    count: number,
    obstacles?: ObstacleGrid,
  ) {
    this.group.name = 'treasures'
    // 箱子不吃光照变化，但它要能被阴影正确遮蔽；用 Lambert + 顶点色
    // 太麻烦，这里直接用固定色材质（箱子就两个颜色）
    this.woodMaterial = new MeshLambertMaterial({ color: new Color(0x8a5a30) })
    this.metalMaterial = new MeshLambertMaterial({ color: new Color(0xc9a24a) })

    for (const site of findChestSites(hf, count)) {
      this.buildChest(site.x, site.y, site.z, site.rot, obstacles)
    }
  }

  private buildChest(
    x: number,
    y: number,
    z: number,
    rot: number,
    obstacles?: ObstacleGrid,
  ): void {
    const id = `chest-${this.chests.length}`
    const root = new Group()
    root.position.set(x, y, z)
    root.rotation.y = rot

    // 箱身
    const body = new Mesh(new BoxGeometry(0.92, 0.5, 0.62), this.woodMaterial)
    body.position.y = 0.25
    body.castShadow = true
    body.receiveShadow = true
    root.add(body)

    // 箱身上两道金属箍
    for (const offset of [-0.22, 0.22]) {
      const band = new Mesh(new BoxGeometry(0.06, 0.53, 0.65), this.metalMaterial)
      band.position.set(offset, 0.25, 0)
      band.castShadow = true
      root.add(band)
    }

    // 盖子挂在后边缘的枢轴上，开箱时绕它转
    const lid = new Group()
    lid.position.set(0, 0.5, -0.31)
    const lidMesh = new Mesh(new BoxGeometry(0.92, 0.17, 0.62), this.woodMaterial)
    lidMesh.position.set(0, 0.085, 0.31)
    lidMesh.castShadow = true
    lid.add(lidMesh)
    const lidBand = new Mesh(new BoxGeometry(0.96, 0.19, 0.1), this.metalMaterial)
    lidBand.position.set(0, 0.085, 0.31)
    lid.add(lidBand)
    // 锁扣
    const lock = new Mesh(new BoxGeometry(0.16, 0.14, 0.08), this.metalMaterial)
    lock.position.set(0, 0.02, 0.33)
    lid.add(lock)
    root.add(lid)

    this.group.add(root)

    // 树桩那么大的碰撞体，玩家不会走进箱子里
    obstacles?.insert(x, z, 0.45)

    this.chests.push({
      id,
      position: new Vector3(x, y + 0.5, z),
      opened: false,
      lid,
      openProgress: 0,
    })
  }

  /** 找到离玩家最近、还没开的箱子（在交互距离内） */
  nearestUnopened(pos: Vector3): Chest | null {
    let best: Chest | null = null
    let bestDist = CHEST_RANGE
    for (const c of this.chests) {
      if (c.opened) continue
      const d = Math.hypot(c.position.x - pos.x, c.position.z - pos.z)
      // 高度也要接近，否则站在崖顶会隔着几十米"开到"崖底的箱子
      if (Math.abs(c.position.y - pos.y) > 3) continue
      if (d < bestDist) {
        bestDist = d
        best = c
      }
    }
    return best
  }

  /** 开箱，返回掉落物。重复调用返回空数组 */
  open(chest: Chest): ItemId[] {
    if (chest.opened) return []
    chest.opened = true
    const index = this.chests.indexOf(chest)
    return lootFor(index < 0 ? 0 : index)
  }

  /** 导出已开启的箱子，供存档用 */
  toSave(): string[] {
    return this.chests.filter((c) => c.opened).map((c) => c.id)
  }

  /** 读档时恢复开启状态。箱子编号按生成顺序固定，所以按 id 匹配即可 */
  restore(openedIds: readonly string[]): void {
    const set = new Set(openedIds)
    for (const c of this.chests) {
      const wasOpen = set.has(c.id)
      c.opened = wasOpen
      // 直接跳到开合终态，不播动画——读档时满地图的盖子一起掀开很怪
      c.openProgress = wasOpen ? 1 : 0
      c.lid.rotation.x = wasOpen ? -1.9 : 0
    }
  }

  update(dt: number): void {
    this.elapsed += dt
    for (const c of this.chests) {
      const target = c.opened ? 1 : 0
      if (c.openProgress === target) continue
      // 开盖带一点回弹：直接线性推到 100% 像是被谁一把掀开的
      c.openProgress += (target - c.openProgress) * Math.min(1, dt * 6)
      if (Math.abs(target - c.openProgress) < 0.01) c.openProgress = target
      const t = c.openProgress
      c.lid.rotation.x = -1.9 * (t * t * (3 - 2 * t)) + Math.sin(t * Math.PI) * 0.12
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) m.geometry.dispose()
    })
    this.woodMaterial.dispose()
    this.metalMaterial.dispose()
  }
}

interface ChestSite {
  x: number
  y: number
  z: number
  rot: number
}

/**
 * 挑放箱子的地方。
 *
 * 三种地形各挑一批：**高处**（爬上去能俯瞰，箱子是奖励）、
 * **水岸**（绕路过去才看得到）、**坡地**（顺路撞见的）。
 * 只挑一种的话，玩家很快就会摸清规律——"箱子都在山顶"，
 * 那探索就变成打卡了。
 */
function findChestSites(hf: Heightfield, count: number): ChestSite[] {
  const sites: ChestSite[] = []
  const perKind = Math.max(1, Math.floor(count / 3))
  const rand = mulberry32(20261001)

  const push = (x: number, z: number): void => {
    const slope = hf.slope(x, z)
    if (slope > 0.3) return
    const y = hf.height(x, z)
    if (y < WATER_LEVEL + 1) return
    // 别挨着别的箱子放
    for (const s of sites) {
      if (Math.hypot(s.x - x, s.z - z) < 60) return
    }
    sites.push({ x, y, z, rot: rand() * Math.PI * 2 })
  }

  // ── 高处：海拔最高的一批 ──
  let best: { x: number; z: number; h: number }[] = []
  for (let r = 60; r < 320; r += 14) {
    for (let a = 0; a < 40; a++) {
      const ang = (a / 40) * Math.PI * 2
      const x = Math.cos(ang) * r
      const z = Math.sin(ang) * r
      const h = hf.height(x, z)
      if (hf.slope(x, z) > 0.28) continue
      best.push({ x, z, h })
    }
  }
  best.sort((a, b) => b.h - a.h)
  for (const p of best) {
    if (sites.length >= perKind) break
    push(p.x, p.z)
  }

  // ── 水岸 ──
  let placed = 0
  for (let r = 100; r < 520 && placed < perKind; r += 16) {
    for (let a = 0; a < 48 && placed < perKind; a++) {
      const ang = (a / 48) * Math.PI * 2
      const x = Math.cos(ang) * r
      const z = Math.sin(ang) * r
      const h = hf.height(x, z)
      if (h < WATER_LEVEL + 1.2 || h > WATER_LEVEL + 6) continue
      if (hf.slope(x, z) > 0.3) continue
      const before = sites.length
      push(x, z)
      if (sites.length > before) placed++
    }
  }

  // ── 坡地：随机撒，只要站得住 ──
  let tries = 0
  while (sites.length < count && tries++ < 900) {
    const ang = rand() * Math.PI * 2
    const r = 70 + rand() * 260
    push(Math.cos(ang) * r, Math.sin(ang) * r)
  }

  return sites.slice(0, count)
}

/** 确定性伪随机，保证每次生成的宝箱位置一致 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
