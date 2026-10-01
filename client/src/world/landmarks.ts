/**
 * 地标：三座元素祭坛、封印之门、Boss 竞技场、贤者的营地。
 *
 * ── 位置是扫描出来的，不是手填的 ──
 *
 * 地形是程序生成的，写死坐标迟早会撞上"祭坛悬在半空"或者"门淹在水里"。
 * 所以每次开局都按地形条件重新找点：火之祭坛要在高处的平地上、冰之祭坛
 * 要挨着水、风之祭坛要占着最高的山头。条件本身也承担了关卡设计——
 * **玩家能不能到达，取决于他有没有对应的能力**：
 *
 *  - 冰之祭坛在湖心岛，不冻出一条冰桥就过不去
 *  - 风之祭坛在山顶，只能靠攀爬或者滑翔上升气流
 *  - 火之祭坛在半山腰，路上有野兽
 *
 * 这就是塞尔达式的能力门：不写"需要 XX 道具"的提示，直接把东西放在
 * 玩家当下到不了的地方。
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
  type BufferGeometry,
} from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'
import type { NatureGeometry } from './natureLibrary.ts'
import type { ObstacleGrid } from '../physics/obstacleGrid.ts'
import type { LandmarkSites, SealKind } from '../gameplay/quest.ts'

/** 找点时的采样半径范围（米）。火之祭坛、门、营地都在这一圈里 */
const SEARCH_MIN_RADIUS = 90
const SEARCH_MAX_RADIUS = 300

/**
 * 冰之祭坛单独用一圈更远的范围。
 *
 * 出生点落在一片内陆高地上——实测 300 米内一滴水都没有，最近的湖在 500 米
 * 开外。硬要在近处找水边，只会让扫描落空、退回兜底位置，结果就是冰之祭坛
 * 被丢在一片内陆草地上，"不冻出冰桥就过不去"的关卡设计整个失效。
 *
 * 所以干脆认下这个地形事实：让冰之祭坛成为一趟远征。500 米按跑速算约
 * 一分半，任务栏一直有距离读数，不至于迷路。
 */
const WATER_SEARCH_MIN_RADIUS = 380
const WATER_SEARCH_MAX_RADIUS = 560

export interface Landmark {
  id: string
  kind: 'altar' | 'gate' | 'arena' | 'camp'
  seal?: SealKind
  position: Vector3
  /** 触发半径（米） */
  radius: number
  /** 已激活（祭坛点亮 / 门开启） */
  activated: boolean
}

/**
 * 按地形条件挑位置。
 *
 * 用「分区 + 打分」而不是直接取极值：取极值会让三个祭坛挤在同一片高地，
 * 玩家跑一趟就全收了，失去探索。按方位角切成六个扇区，每个扇区只出一个
 * 候选，三个祭坛自然散开。
 */
export function findLandmarkSites(
  hf: Heightfield,
  spawn: { x: number; z: number },
): LandmarkSites {
  const sectors = 6
  const best: Array<{ x: number; z: number; score: number; h: number }> = []
  for (let s = 0; s < sectors; s++) {
    best.push({ x: 0, z: 0, score: -Infinity, h: 0 })
  }

  // 沿环带扫描。步长取得比块尺寸大，几千次采样就够覆盖整圈
  for (let r = SEARCH_MIN_RADIUS; r <= SEARCH_MAX_RADIUS; r += 12) {
    for (let a = 0; a < 72; a++) {
      const angle = (a / 72) * Math.PI * 2
      const x = spawn.x + Math.cos(angle) * r
      const z = spawn.z + Math.sin(angle) * r
      const h = hf.height(x, z)
      if (h < WATER_LEVEL + 0.5) continue

      const slope = hf.slope(x, z)
      // 陡坡上立不住祭坛，也站不住玩家
      if (slope > 0.42) continue

      const sector = Math.floor(((angle + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / sectors))
      const entry = best[sector]
      // 打分以海拔为主。距离只给很小的权重：给大了会让所有地标都收敛到
      // 搜索半径的最大值上，三个地点挤在同一个环带里，一眼就看出是程序
      // 生成的。海拔高的地方少，天然就散得开
      const score = h * 1.0 + r * 0.08 - slope * 40

      if (score > entry.score) {
        entry.x = x
        entry.z = z
        entry.h = h
        entry.score = score
      }
    }
  }

  const usable = best.filter((b) => b.score > -Infinity)
  // 按海拔从高到低分配：最高处给风之祭坛，次高给火，再次给门
  usable.sort((a, b) => b.h - a.h)

  const wind = usable[0] ?? { x: spawn.x + 200, z: spawn.z }
  const fire = usable[1] ?? usable[0] ?? { x: spawn.x - 200, z: spawn.z }
  const gateSite = usable[2] ?? usable[1] ?? { x: spawn.x, z: spawn.z + 180 }

  // 冰之祭坛要找有水的方向：扫一圈找第一个大面积水域，放在它岸边
  const ice = findWaterside(hf, spawn)

  // 竞技场在门的另一侧再往外推一段，进门之后是另一片场地
  const dirX = gateSite.x - spawn.x
  const dirZ = gateSite.z - spawn.z
  const len = Math.hypot(dirX, dirZ) || 1
  const arena = {
    x: gateSite.x + (dirX / len) * 55,
    z: gateSite.z + (dirZ / len) * 55,
  }

  return {
    sage: { x: spawn.x + 8, z: spawn.z + 6 },
    altars: {
      fire: { x: fire.x, z: fire.z },
      ice: { x: ice.x, z: ice.z },
      wind: { x: wind.x, z: wind.z },
    },
    gate: { x: gateSite.x, z: gateSite.z },
    arena,
  }
}

/**
 * 找一处「岸边」：站得住，但四周有水。
 *
 * 第一版是从水面往里退，退到岸上就算数——结果一次都没命中，直接落到兜底
 * 分支上，冰之祭坛被放在了一片内陆草地，"不冻冰桥就过不去"的关卡设计
 * 整个落空。原因是它假设了水域外面紧挨着平缓的岸，而这片地形里水多半
 * 被崖壁围着，退多少步都是陡坡。
 *
 * 所以换个方向来找：不追着水跑，而是**逐点评估"这里像不像岸边"**——
 * 站得住、海拔在水位之上，且周围一圈里有相当比例是水。30% 左右是理想
 * 岸边：水够多、路没被淹。
 */
function findWaterside(hf: Heightfield, spawn: { x: number; z: number }): { x: number; z: number } {
  let best: { x: number; z: number } | null = null
  let bestScore = -Infinity

  /** 周围 45 米内的水面占比 */
  const sampleWaterPct = (x: number, z: number): number => {
    let water = 0
    let total = 0
    for (let r = 5; r <= 45; r += 5) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2
        total++
        if (hf.height(x + Math.cos(ang) * r, z + Math.sin(ang) * r) < WATER_LEVEL) water++
      }
    }
    return total > 0 ? water / total : 0
  }

  // 分两轮找。理想情况是**湖心小岛**——四周都是水，不冻出一条冰桥就走不过去，
  // 这才叫能力门槛；退而求其次是岸边半岛，玩家蹚水也能到，门槛就只剩
  // "水有点深"这种程度。所以先把岛找遍，找不到再降级。
  for (const [target, label] of [
    [0.62, '湖心岛'],
    [0.32, '水岸'],
  ] as const) {
    bestScore = -Infinity
    best = null

    for (let r = WATER_SEARCH_MIN_RADIUS; r <= WATER_SEARCH_MAX_RADIUS; r += 12) {
      for (let a = 0; a < 72; a++) {
        const angle = (a / 72) * Math.PI * 2
        const x = spawn.x + Math.cos(angle) * r
        const z = spawn.z + Math.sin(angle) * r
        const h = hf.height(x, z)
        // 初筛很便宜，先把"站不住"和"泡在水里"的点排除掉，再去做贵的取样
        if (h < WATER_LEVEL + 1.2 || h > WATER_LEVEL + 14) continue
        if (hf.slope(x, z) > 0.36) continue

        const pct = sampleWaterPct(x, z)
        if (pct < target - 0.18) continue
        const score = -Math.abs(pct - target) * 120 - r * 0.05
        if (score > bestScore) {
          bestScore = score
          best = { x, z }
        }
      }
    }

    if (best) {
      console.log(
        `[地标] 冰之祭坛定在${label} (${best.x.toFixed(0)}, ${best.z.toFixed(0)})，周围水域 ${(sampleWaterPct(best.x, best.z) * 100).toFixed(0)}%`,
      )
      return best
    }
  }

  console.warn('[地标] 560 米内没找到合适的水域，冰之祭坛退回兜底位置')
  // 这片地形没有水的话，退化成随便找个平地，至少不会让流程卡死
  return { x: spawn.x - 150, z: spawn.z + 150 }
}

// ─────────────────────────── 渲染 ───────────────────────────

/** 三种封印各自的代表色，祭坛、光柱、HUD 用同一套 */
export const SEAL_COLORS: Record<SealKind, number> = {
  fire: 0xff7a2a,
  ice: 0x5ec8ff,
  wind: 0x8ef0a8,
}

export class LandmarkField {
  readonly group = new Group()
  readonly sites: LandmarkSites
  readonly landmarks: Landmark[] = []

  private readonly material: MeshLambertMaterial
  /** 会随时间脉动的部件（光柱、封印晶体） */
  private readonly pulses: Array<{ mesh: Mesh; base: number; speed: number; phase: number }> = []
  private elapsed = 0

  constructor(
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    sites: LandmarkSites,
    obstacles?: ObstacleGrid,
  ) {
    this.sites = sites
    this.group.name = 'landmarks'
    this.material = new MeshLambertMaterial({ vertexColors: true })

    this.buildAltar('fire', 'fire', hf, nature, obstacles)
    this.buildAltar('ice', 'ice', hf, nature, obstacles)
    this.buildAltar('wind', 'wind', hf, nature, obstacles)
    this.buildGate(hf, nature, obstacles)
    this.buildCamp(hf, nature, obstacles)
  }

  /** 在某处放一个素材模型，按 targetHeight 缩放到世界尺寸 */
  private place(
    nature: ReadonlyMap<string, NatureGeometry>,
    name: string,
    x: number,
    y: number,
    z: number,
    scale: number,
    rotY = 0,
  ): Mesh | null {
    const geo = nature.get(name)
    if (!geo) return null
    const mesh = new Mesh(geo.geometry, this.material)
    mesh.position.set(x, y, z)
    mesh.rotation.y = rotY
    mesh.scale.setScalar(scale)
    mesh.castShadow = true
    mesh.receiveShadow = false
    return mesh
  }

  /** 祭坛：环形石台 + 一圈石柱 + 中央的封印晶体 */
  private buildAltar(
    id: string,
    kind: SealKind,
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    obstacles?: ObstacleGrid,
  ): void {
    const site = this.sites.altars[kind]
    const baseY = hf.height(site.x, site.z)
    const group = new Group()
    group.position.set(site.x, baseY, site.z)

    // 地面石台。scale 传 1 表示"按清单里标的目标高度来"（0.5 米），
    // 而不是"再放大一倍"——这个参数是倍数不是尺寸，看错一位就是几十米的大饼
    const platform = this.place(nature, 'platform_stone', 0, 0.05, 0, 1)
    if (platform) group.add(platform)

    // 一圈石柱。损坏的柱子混两根进去，看不出是复制品。
    // 朝向各自转向圆心，柱子才像"围"着祭坛而不是随便插的
    const columns = 6
    for (let i = 0; i < columns; i++) {
      const angle = (i / columns) * Math.PI * 2
      const radius = 4.4
      const cx = Math.cos(angle) * radius
      const cz = Math.sin(angle) * radius
      const damaged = i === 2 || i === 5
      const column = this.place(
        nature,
        damaged ? 'statue_columnDamaged' : 'statue_column',
        cx,
        0,
        cz,
        1,
        angle + Math.PI,
      )
      if (column) group.add(column)
      obstacles?.insert(site.x + cx, site.z + cz, 0.45)
    }

    // 中央的封印晶体：一根悬空旋转的八面体，颜色区分元素
    const crystal = new Mesh(
      new CylinderGeometry(0.001, 0.9, 1.6, 6),
      new MeshBasicMaterial({ color: SEAL_COLORS[kind], transparent: true, opacity: 0.85 }),
    )
    crystal.position.y = 2.2
    crystal.rotation.x = Math.PI
    group.add(crystal)
    this.pulses.push({ mesh: crystal, base: 2.2, speed: 1.6, phase: Math.random() * 6 })

    // 晶体底下的光晕，远处一眼能看见
    const halo = new Mesh(
      new CylinderGeometry(1.3, 1.3, 8, 8, 1, true),
      new MeshBasicMaterial({
        color: SEAL_COLORS[kind],
        transparent: true,
        opacity: 0.16,
        side: DoubleSide,
        depthWrite: false,
      }),
    )
    halo.position.y = 4
    group.add(halo)

    this.group.add(group)
    this.landmarks.push({
      id,
      kind: 'altar',
      seal: kind,
      position: new Vector3(site.x, baseY, site.z),
      radius: 6,
      activated: false,
    })
  }

  /** 封印之门：两根方尖碑夹一道光幕 */
  private buildGate(
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    obstacles?: ObstacleGrid,
  ): void {
    const site = this.sites.gate
    const baseY = hf.height(site.x, site.z)
    const group = new Group()
    group.position.set(site.x, baseY, site.z)

    const pillars = 2
    for (let i = 0; i < pillars; i++) {
      const side = i === 0 ? -1 : 1
      const pillar = this.place(nature, 'statue_obelisk', side * 3.4, 0, 0, 2.6)
      if (pillar) group.add(pillar)
      obstacles?.insert(site.x + side * 3.4, site.z, 1.0)
    }

    // 门楣：一根横跨两根方尖碑的石梁。
    // 材质开了 vertexColors，自建几何体必须带上 color 属性，
    // 否则顶点色默认是 (0,0,0)，整根梁会渲染成纯黑
    const lintelGeo = new BoxGeometry(9, 0.9, 1.4)
    paintGeometry(lintelGeo, 0x8a8b85)
    const lintel = new Mesh(lintelGeo, this.material)
    lintel.position.y = 12
    lintel.castShadow = true
    group.add(lintel)

    // 门里的光幕。未开启时几乎看不见，开启后是一道亮墙
    const barrier = new Mesh(
      new BoxGeometry(6.4, 11, 0.3),
      new MeshBasicMaterial({ color: 0x6ad8ff, transparent: true, opacity: 0.12, depthWrite: false }),
    )
    barrier.position.y = 5.6
    group.add(barrier)
    this.barrier = barrier

    this.group.add(group)
    this.landmarks.push({
      id: 'gate',
      kind: 'gate',
      position: new Vector3(site.x, baseY, site.z),
      radius: 9,
      activated: false,
    })
  }

  /** 贤者的营地：帐篷 + 篝火 + 几件杂物，让 NPC 有个"站在这里"的理由 */
  private buildCamp(
    hf: Heightfield,
    nature: ReadonlyMap<string, NatureGeometry>,
    obstacles?: ObstacleGrid,
  ): void {
    const site = this.sites.sage
    const baseY = hf.height(site.x, site.z)
    const group = new Group()
    group.position.set(site.x, baseY, site.z)

    const tent = this.place(nature, 'tent_smallClosed', -2.6, 0, -1.2, 1, 0.6)
    if (tent) group.add(tent)
    obstacles?.insert(site.x - 2.6, site.z - 1.2, 1.4)

    const fire = this.place(nature, 'campfire_logs', 0.4, 0, -1.8, 1)
    if (fire) group.add(fire)
    const stones = this.place(nature, 'campfire_stones', 0.4, 0, -1.8, 1)
    if (stones) group.add(stones)

    const pot = this.place(nature, 'pot_large', 2.0, 0, -0.6, 1)
    if (pot) group.add(pot)

    this.group.add(group)
    this.landmarks.push({
      id: 'camp',
      kind: 'camp',
      position: new Vector3(site.x, baseY, site.z),
      radius: 5,
      activated: false,
    })
  }

  private barrier: Mesh | null = null

  /** 门开启后把光幕点亮 */
  setGateOpen(open: boolean): void {
    const gate = this.landmarks.find((l) => l.kind === 'gate')
    if (gate) gate.activated = open
    const mat = this.barrier?.material as MeshBasicMaterial | undefined
    if (mat) {
      mat.opacity = open ? 0.42 : 0.12
      mat.color.setHex(open ? 0x9df0ff : 0x6ad8ff)
    }
  }

  /** 点亮某座祭坛（拿到封印后晶体变得更亮） */
  activateAltar(kind: SealKind): void {
    const altar = this.landmarks.find((l) => l.seal === kind)
    if (altar) altar.activated = true
  }

  update(dt: number): void {
    this.elapsed += dt
    // 晶体上下浮动 + 轻微呼吸，静止的光柱看起来像贴图
    for (const p of this.pulses) {
      p.mesh.position.y = p.base + Math.sin(this.elapsed * p.speed + p.phase) * 0.28
      p.mesh.rotation.y += dt * 0.6
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) {
        // 几何体来自共享素材库，只销毁自建的
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose()
      }
    })
    this.material.dispose()
  }
}

/** 供调用方复用的工具：把几何体的顶点全刷成一个颜色 */
export function paintGeometry(geometry: BufferGeometry, hex: number): void {
  const color = new Color(hex)
  const count = geometry.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
}
