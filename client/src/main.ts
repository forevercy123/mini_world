/**
 * 游戏主入口。
 *
 * 两种控制模式，通过面板切换：
 *  - play（默认）：第三人称角色控制，正式玩法
 *  - fly：自由飞行，用于调试取景与性能巡检
 *
 * 自动巡检始终以 fly 模式运行——它需要把相机精确摆到指定机位，
 * 与角色控制互斥。
 */

import { Box3, Color, Mesh, Vector2, Vector3, type Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GameLoop } from './core/loop.ts'
import { PerfHUD, PerfMonitor } from './core/perf.ts'
import { RenderPipeline } from './render/pipeline.ts'
import { FlyController } from './core/flyControls.ts'
import { KeyboardInput } from './core/input.ts'
import { BenchmarkWorld } from './benchmark/world.ts'
import { Autopilot, BENCH_CASES, formatReport, type BenchResult } from './benchmark/autopilot.ts'
import { createGui, type GuiState } from './benchmark/gui.ts'
import { CharacterController, type MoveState } from './gameplay/characterController.ts'
import { ThirdPersonCamera } from './gameplay/thirdPersonCamera.ts'
import { PlayerAvatar, type AvatarLike } from './gameplay/playerAvatar.ts'
import { ModelAvatar, type RecolorRule } from './gameplay/modelAvatar.ts'
import { PlayerCombat, type AttackTarget } from './gameplay/playerCombat.ts'
import { Health } from './gameplay/health.ts'
import { EnemyManager } from './entities/enemyManager.ts'
import { loadSkeletonTemplate } from './entities/enemySkeleton.ts'
import { Npc, SAGE_INTRO, sageProgress, type NpcDef } from './entities/npc.ts'
import { Quest, SEAL_INFO } from './gameplay/quest.ts'
import { StoryDirector, type StoryEvent } from './gameplay/story.ts'
import { LandmarkField, findLandmarkSites } from './world/landmarks.ts'
import { TreasureField } from './world/treasureChests.ts'
import { DialogueBox, InteractPrompt, ObjectiveBanner } from './ui/dialogue.ts'
import { SaveManager, formatPlaytime } from './gameplay/saveGame.ts'
import { Sfx } from './audio/sfx.ts'
import { SIDE_QUESTS, SideQuestLog, describeNeeds } from './gameplay/sideQuests.ts'
import { ElementGrid } from './world/elementGrid.ts'
import { FireRenderer } from './render/fireRenderer.ts'
import { IceRenderer } from './render/iceRenderer.ts'
import { SwimSplash } from './render/swimSplash.ts'
import { HitSparks, ShockRing, SlashTrail } from './render/combatEffects.ts'
import { ArrowField, type ArrowHit } from './render/projectiles.ts'
import { StaminaRing } from './ui/staminaRing.ts'
import { HealthHud } from './ui/healthHud.ts'
import { HelpPanel } from './ui/helpPanel.ts'
import { Minimap, type MinimapMarkers } from './ui/minimap.ts'
import { WorldMap } from './ui/worldMap.ts'
import { InventoryHud } from './ui/inventoryHud.ts'
import { Inventory, PickupManager, ITEM_DEFS, type ItemId } from './gameplay/inventory.ts'
import { loadNature } from './world/vegetation.ts'
import { WATER_LEVEL, Heightfield } from './terrain/heightfield.ts'
import { RoadNetwork } from './world/roads.ts'
import { WeaponBag, WEAPON_DEFS, UNARMED, type Moveset } from './gameplay/weapons.ts'
import { WeaponSpawnField, makeWeaponVisual, DISPLAY_LENGTH } from './world/weaponSpawns.ts'
import { WeaponHud } from './ui/weaponHud.ts'
import { WildlifeManager, Animal } from './entities/wildlife.ts'
import { CampfireField } from './world/campfires.ts'
import { CookingMenu } from './ui/cookingMenu.ts'
import { ShrineField, type Shrine } from './world/shrines.ts'
import type { Enemy } from './entities/enemy.ts'
import { RegionTitle } from './ui/regionTitle.ts'

const PLAYER_MAX_HEARTS = 6
/** 玩家无敌帧时长，与 HUD 闪烁的节奏一致 */
const PLAYER_INVULN = 0.9
/** 环境伤害（灼烧）不产生击退：给单位方向但力度为 0 */
const NO_KNOCKBACK = new Vector3(0, 0, 1)

/**
 * 顿帧时长（秒）。
 *
 * 命中瞬间把世界时间压慢几帧，是格斗游戏让打击"实"起来的通用手法：
 * 画面短暂凝滞，玩家的大脑会把那一刻读成"撞上了硬东西"。没有它，
 * 挥剑就只是一段平滑的动画，打中了和擦过去看起来一样。
 *
 * 55 毫秒是反复试出来的：短于 40 感觉不到，长于 80 会让连招发黏。
 */
const HIT_STOP_SECONDS = 0.055
/** 顿帧期间世界时间的倍率。压到 0 会变成卡顿，留一点才像"慢镜头" */
const HIT_STOP_SCALE = 0.12

const STATE_LABEL: Record<MoveState, string> = {
  ground: '地面',
  air: '空中',
  climb: '攀爬',
  glide: '滑翔',
  swim: '游泳',
}

/** 斩击轨迹的稀有度配色：默认冷白，稀有泛蓝，史诗透金 */
const TRAIL_RARE = new Color(1.4, 2.2, 3.0)
const TRAIL_EPIC = new Color(2.8, 2.1, 0.9)

/**
 * 主角的模型与配色。
 *
 * KayKit 冒险者包里的 Rogue_Hooded：绿兜帽、绿束腰外衣、棕色皮带和短靴、
 * 腰间别着匕首——低多边形风格里最接近林克的一身。同包的 Knight 是全罩
 * 板甲，Mage 是长袍，都不像。
 *
 * 只有肤色要改：这套素材的原始肤色是深棕（a9674d / 884835），而林克是
 * 浅肤色。贴图是纯色块图集，按颜色距离替换即可，不会糊掉边界。
 */
const PLAYER_MODEL = '/assets/models/Rogue_Hooded.glb'
const PLAYER_RECOLOR: RecolorRule[] = [
  { from: 0xa9674d, to: 0xf6cda4 },
  { from: 0x884835, to: 0xdcae86 },
]

/** 盾牌模型加载：KayKit 圆盾，归一化到直径 0.62 米 */
async function loadShield(): Promise<Object3D | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync('/assets/weapons/shield_round.gltf')
    const shield = gltf.scene
    const box = new Box3().setFromObject(shield)
    const raw = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    shield.scale.setScalar(0.62 / Math.max(0.001, raw))
    shield.traverse((child) => {
      const mesh = child as Mesh
      if (mesh.isMesh) mesh.castShadow = true
    })
    return shield
  } catch (err) {
    console.warn('[角色] 盾牌加载失败：', err)
    return null
  }
}

const START_VIEW_DISTANCE = 320
/**
 * 散布物件总数（树、灌木、岩石、花草合计）。
 *
 * 换成 Kenney 素材后单个物件便宜得多（手写阔叶树 216 面，Kenney 的树
 * 平均 150 面），所以从 1400 一路提到 2200 换来了成片的林子。
 * 收到 1900 是配合三角形预算：这一档在林相上几乎看不出差别，
 * 但能匀出几万个三角形给阴影 pass。
 */
const START_TREE_COUNT = 2800

type ControlMode = 'play' | 'fly'

async function boot(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null
  if (!canvas) throw new Error('找不到 #app 画布')

  const setLoadProgress = (percent: number, hint: string): void => {
    const bar = document.getElementById('loadbar')
    const text = document.getElementById('loadhint')
    if (bar) bar.style.width = `${percent}%`
    if (text) text.textContent = hint
  }

  // 外部素材必须先于世界构建：散布是同步生成的，拿到空素材库就只能
  // 长出一片光地。
  //
  // 自然素材（56 个小模型）和敌人骨架（一个 4.8MB 的大模型）并行拉，
  // 不是串行——骨架那一个文件比全部自然素材加起来还大，串行等于把它的
  // 下载时间白加在启动路径上。
  setLoadProgress(6, '加载素材…')
  const [nature, minionTpl, warriorTpl] = await Promise.all([
    loadNature((done, total) => {
      setLoadProgress(6 + (done / total) * 34, `加载自然素材 ${done}/${total}`)
    }),
    loadSkeletonTemplate('/assets/models/Skeleton_Minion.glb'),
    loadSkeletonTemplate('/assets/models/Skeleton_Warrior.glb'),
  ])
  const skeletons = { minion: minionTpl, warrior: warriorTpl }
  console.log(
    `[素材] 自然模型 ${nature.size} 个，敌人骨架 ${[minionTpl ? '小兵' : '', warriorTpl ? '战士' : ''].filter(Boolean).join('+') || '缺失'}`,
  )

  setLoadProgress(42, '构建世界…')

  // 道路要在世界装配**之前**修好：植被散布是同步生成的，树一旦落地
  // 就不会再挪，后补的路会从树林里穿过去。祭坛选址只依赖高度场，
  // 用同一个种子先建一张"规划图"扫出所有点位，路与世界再一起落地。
  const planHf = new Heightfield({ seed: 20260930 })
  const spawn = findFlatSpawn(planHf)
  const sites = findLandmarkSites(planHf, spawn)
  const roads = new RoadNetwork()
  // 营地出发，通向三座祭坛与封印之门——玩家出门就有路可走
  for (const target of [sites.altars.fire, sites.altars.ice, sites.altars.wind, sites.gate]) {
    roads.addPath(sites.sage, target)
  }

  const world = new BenchmarkWorld(
    {
      viewDistance: START_VIEW_DISTANCE,
      treeCount: START_TREE_COUNT,
      shadows: true,
      shadowMapSize: 2048,
      roads,
    },
    nature,
  )

  setLoadProgress(58, '初始化渲染器…')
  const pipeline = new RenderPipeline(canvas, world.scene, world.camera)

  setLoadProgress(70, '放置角色…')

  // ── 角色 ──
  // 水位必须与地形用同一个常量，否则会出现"站在水里但没在游泳"的错位
  const player = new CharacterController({ waterLevel: WATER_LEVEL })
  player.teleportTo(spawn.x, spawn.z, world.heightfield)

  // 先用代码拼的角色顶上，glTF 模型加载完成后无缝替换。
  // 放在外面声明为 let，是因为 loop 里每帧都要读它。
  let avatar: AvatarLike = new PlayerAvatar()
  world.scene.add(avatar.object)
  const staminaRing = new StaminaRing()

  // ── 战斗 ──
  const playerHealth = new Health(PLAYER_MAX_HEARTS)
  const healthHud = new HealthHud(PLAYER_MAX_HEARTS)
  const combat = new PlayerCombat()

  // ── 武器 ──
  const weaponBag = new WeaponBag()
  const weaponHud = new WeaponHud()
  const weaponSpawns = new WeaponSpawnField()
  world.scene.add(weaponSpawns.group)

  /**
   * 把当前武器同步到角色外观和战斗参数。
   *
   * 换武器、武器碎裂、读档、模型异步加载完成，都会走到这里。
   * 所有属性从 WEAPON_DEFS 一张表读，不会出现"手上拿着大剑、
   * 伤害还是树枝"的错位。
   */
  const syncWeapon = (): void => {
    const def = weaponBag.currentDef
    const moveset: Moveset | 'unarmed' = def ? def.moveset : 'unarmed'
    const duration = def ? def.duration : UNARMED.duration

    // 换武器打断进行中的攻击：收刀再拔刀，不可能"剑挥到一半
    // 变成斧头砍出去"。不打断的话，命中帧会拿新武器的参数
    // 去结算一次旧武器发起的挥砍
    combat.reset()

    // 战斗参数跟着武器走：大剑慢而痛，匕首快而轻
    combat.config.damage = def ? def.damage : UNARMED.damage
    combat.config.duration = duration
    combat.config.range = def ? def.range : UNARMED.range
    combat.config.knockbackForce = def ? def.knockback : UNARMED.knockback
    // 命中帧保持在出招的 47% 处——挥砍的"刃到肉"时刻按比例缩放
    combat.config.hitMoment = duration * 0.47
    combat.config.windup = duration * 0.34

    const visual = def ? makeWeaponVisual(def.id, DISPLAY_LENGTH[def.id]) : null
    avatar.setWeapon?.(visual, moveset, duration)
    weaponHud.update(weaponBag)
  }

  const enemies = new EnemyManager()
  for (const [kind, tpl] of Object.entries(skeletons)) {
    enemies.setSkeleton(kind as 'minion' | 'warrior', tpl)
  }
  world.scene.add(enemies.group)

  // 野外混编：小兵多、战士少、精英偶尔。全放同一种的话，玩家打完第一只
  // 就摸清了所有敌人的套路
  const spawnOpts = { center: new Vector3(0, 0, 0), radius: 120, minRadius: 28 }
  let spawned = 0
  spawned += enemies.spawn(world.heightfield, { ...spawnOpts, count: 6 }, 'minion')
  spawned += enemies.spawn(world.heightfield, { ...spawnOpts, count: 3 }, 'warrior')
  spawned += enemies.spawn(world.heightfield, { ...spawnOpts, count: 2 }, 'elite')

  // ── 主线剧情 ──
  // 地标位置按地形条件现场扫描：地形是程序生成的，写死坐标迟早会撞上
  // "祭坛悬在半空"。扫描结果同时决定了玩家的路线——冰之祭坛在水边、
  // 风之祭坛在最高处，能不能到取决于有没有对应的能力
  // 地标选址在世界装配前就用同种子高度场扫好了（为了修路），直接用
  const landmarks = new LandmarkField(world.heightfield, nature, sites, world.obstacles)
  world.scene.add(landmarks.group)
  const quest = new Quest(sites)
  const story = new StoryDirector(quest, landmarks, enemies)

  // 宝箱：撒在世界的兴趣点上，给"拐个弯"一个回报
  const treasures = new TreasureField(world.heightfield, 12, world.obstacles)
  world.scene.add(treasures.group)

  // 武器点：扫描平缓干燥的草地，插上十把等着被拔走的武器。
  // 异步加载模型，完成后刷新一次手持武器（读档恢复的可能是 glb 武器，
  // 那时缓存里才有模型可挂）
  {
    const sites: Array<{ x: number; z: number }> = []
    let tries = 0
    while (sites.length < 10 && tries++ < 400) {
      const a = Math.random() * Math.PI * 2
      const r = 26 + Math.random() * 190
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const h = world.heightfield.height(x, z)
      if (h < WATER_LEVEL + 2 || h > 52) continue
      if (world.heightfield.slopeAngle(x, z) > 0.42) continue
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < 42)) continue
      sites.push({ x, z })
    }
    void weaponSpawns.populate(world.heightfield, sites).then((n) => {
      console.log(`[武器] 插下 ${n} 把野外武器`)
      syncWeapon()
    })
  }

  // ── 野兽 ──
  const wildlife = new WildlifeManager()
  world.scene.add(wildlife.group)
  void wildlife
    .populate(world.heightfield, player.position, [
      { kind: 'deer', count: 3 },
      { kind: 'stag', count: 2 },
      { kind: 'fox', count: 2 },
      { kind: 'wolf', count: 2 },
      { kind: 'boar', count: 3 },
      { kind: 'rabbit', count: 3 },
    ])
    .then((n) => console.log(`[野兽] 放出 ${n} 只野生动物`))

  // ── 篝火烹饪点：贤者营地一处 + 野外几处 ──
  const campfires = new CampfireField()
  world.scene.add(campfires.group)
  campfires.populate(world.heightfield, nature, { x: sites.sage.x, z: sites.sage.z }, 4)

  const cookingMenu = new CookingMenu()

  // ── 神庙：四座试炼场守着四个方向 ──
  const shrines = new ShrineField()
  world.scene.add(shrines.group)
  shrines.populate(world.heightfield, nature, new Vector3(spawn.x, 0, spawn.z), world.obstacles)
  /** 进行中的神庙挑战：哪座庙、这一波刷出来的怪 */
  let shrineChallenge: { shrine: Shrine; waveEnemies: Enemy[] } | null = null

  /** 刷一波神庙守卫：从四根柱子的位置现身 */
  const spawnShrineWave = (shrine: Shrine): void => {
    const kinds = shrines.waveOf(shrine)
    const positions = kinds.map((_, i) => {
      const a = (i / kinds.length) * Math.PI * 2 + Math.PI / 4
      return {
        x: shrine.position.x + Math.cos(a) * 3.4,
        z: shrine.position.z + Math.sin(a) * 3.4,
      }
    })
    const spawned: Enemy[] = []
    kinds.forEach((kind, i) => {
      // 神庙守卫不恋战也不逃跑：活动范围锁死在神庙周围
      spawned.push(
        ...enemies.spawnAtPositions(world.heightfield, [positions[i]], kind, {
          aggroRange: 40,
          leashRange: 16,
        }),
      )
    })
    shrineChallenge = { shrine, waveEnemies: spawned }
    toast(`${shrine.name} 第 ${shrine.wave + 1} 波守卫现身`)
  }

  const dialogue = new DialogueBox()
  const objectiveBanner = new ObjectiveBanner()
  const interactPrompt = new InteractPrompt()

  // ── NPC ──
  const sideQuests = new SideQuestLog(SIDE_QUESTS)
  const npcs: Npc[] = []

  /** 樵夫：站在营地外侧，玩家出门就能碰见 */
  const woodcutterX = sites.sage.x + 22
  const woodcutterZ = sites.sage.z + 14
  const NPC_DEFS: NpcDef[] = [
    { id: 'sage', name: '贤者', model: '/assets/models/Mage.glb', x: sites.sage.x, z: sites.sage.z },
    {
      id: 'woodcutter',
      name: '樵夫',
      model: '/assets/models/Barbarian.glb',
      x: woodcutterX,
      z: woodcutterZ,
      yaw: Math.atan2(sites.sage.x - woodcutterX, sites.sage.z - woodcutterZ),
    },
  ]

  // 模型各 3 MB 上下，不挡住启动，加载完再挂进场景
  for (const def of NPC_DEFS) {
    void Npc.load(def, world.heightfield).then((npc) => {
      if (!npc) return
      npcs.push(npc)
      world.scene.add(npc.group)
    })
  }

  /** 按 id 取 NPC。测试脚本和对话逻辑都用它 */
  const npcById = (id: string): Npc | null => npcs.find((n) => n.def.id === id) ?? null
  /** 离玩家最近、且在对话距离内的 NPC */
  const npcNear = (pos: Vector3): Npc | null => {
    let best: Npc | null = null
    let bestD = Infinity
    for (const n of npcs) {
      if (!n.canTalk(pos)) continue
      const d = Math.hypot(n.position.x - pos.x, n.position.z - pos.z)
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    return best
  }

  // ── 元素系统 ──
  const elements = new ElementGrid()
  const fireRenderer = new FireRenderer()
  const iceRenderer = new IceRenderer()
  const swimSplash = new SwimSplash()
  const hitSparks = new HitSparks()
  const slashTrail = new SlashTrail()
  const shockRing = new ShockRing()
  const arrows = new ArrowField()
  const arrowHits: ArrowHit[] = []
  const arrowStart = new Vector3()
  const hitDir = new Vector3()
  const sfx = new Sfx()

  // 浏览器的自动播放策略要求音频在用户手势里解锁，而且要一次就够。
  // 挂在 pointerdown 和 keydown 上是因为玩家可能用鼠标也可能用键盘开场
  const unlockAudio = (): void => {
    sfx.unlock()
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('keydown', unlockAudio)
  }
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('keydown', unlockAudio)
  world.scene.add(fireRenderer.group)
  world.scene.add(iceRenderer.group)
  world.scene.add(swimSplash.group)
  world.scene.add(hitSparks.group)
  world.scene.add(slashTrail.object)
  world.scene.add(shockRing.object)
  world.scene.add(arrows.group)
  // 把火堆当作滑翔的上升气流来源
  player.updraftSource = elements
  // 地形之上还有两类额外表面：结冰的水面，以及石头/树桩/倒木的顶面。
  //
  // 两者取最高的那个。它们都是"踏上去才成立"的——石头顶面只有跳到那么高
  // 才会被采纳，所以这个回调必须拿到脚底高度，不能只按平面位置判断
  player.extraSurfaceAt = (x, z, feetY) => {
    const ice = elements.iceHeightAt(x, z)
    const solid = world.obstacles.surfaceAt(x, z, feetY, 0.4)
    if (ice === null) return solid
    if (solid === null) return ice
    return Math.max(ice, solid)
  }
  // 树干碰撞：没有这一项时角色会直接走进树里
  player.obstacles = world.obstacles

  const windDir = new Vector2(1, 0)
  let elementElapsed = 0
  const groundHeightAt = (x: number, z: number): number => world.heightfield.height(x, z)
  const igniteAhead = (): boolean => {
    // 点在角色身前 2 米，而不是脚下——脚下滑坡上点火会烧到自己
    const fx = player.position.x + Math.sin(player.yaw) * 2
    const fz = player.position.z + Math.cos(player.yaw) * 2
    return elements.ignite(fx, fz, world.heightfield)
  }

  // 鼠标短按攻击，拖拽仍然是转视角。用「按下到抬起的时长 + 位移」
  // 区分两者：只要移动超过几像素就认定用户在拖视角，不触发攻击。
  // 按住不动则进入蓄力——蓄力斩由 input.consumeChargeAttack 在循环里判
  let pointerDownAt = 0
  let pointerDownX = 0
  let pointerDownY = 0
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    pointerDownAt = performance.now()
    pointerDownX = e.clientX
    pointerDownY = e.clientY
    input.mouseChargeStart = performance.now()
  })
  canvas.addEventListener('pointermove', (e) => {
    // 拖动起来就不是蓄力了——那是在转视角
    if (input.mouseChargeStart > 0 && pointerDownAt > 0) {
      if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) > 8) {
        input.mouseChargeStart = 0
      }
    }
  })
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return
    input.mouseChargeStart = 0
    const held = performance.now() - pointerDownAt
    const moved = Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY)
    if (held < 260 && moved < 6) input.attackQueued = true
  })

  // ── 右键格挡：举盾 ──
  // 塞尔达的盾挡：正面来袭的伤害完全格掉，代价是移动变慢、不能攻击。
  // 右键的浏览器菜单要拦掉，不然玩家里昂盾时会弹菜单
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  let blocking = false
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2 && mode === 'play' && !dialogue.isOpen && !cookingMenu.isOpen) {
      blocking = true
      avatar.setShieldRaised?.(true)
    }
  })
  window.addEventListener('pointerup', (e) => {
    if (e.button === 2 && blocking) {
      blocking = false
      avatar.setShieldRaised?.(false)
    }
  })

  let respawning = false
  /** 连击段数与上次出招时刻（游戏内秒，用 elementElapsed 这个一直在走的钟） */
  let comboIndex = 0
  let lastAttackAt = -10
  /** 本招是不是蓄力旋风斩（参数被临时改过，收招后要恢复） */
  let chargedSwing = false
  /** 蓄力到点的时刻（0 = 无待发）。到点后在 0.9s 窗口内手空即放 */
  let chargePendingAt = 0
  /** 攻击目标复用数组：敌人 + 野兽，每帧重建但不再分配 */
  const attackTargets: AttackTarget[] = []
  const handleDeath = (): void => {
    if (respawning) return
    respawning = true
    document.getElementById('death-overlay')?.remove()
    const overlay = document.createElement('div')
    overlay.id = 'death-overlay'
    overlay.textContent = '你倒下了…'
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'display:flex', 'align-items:center',
      'justify-content:center', 'background:rgba(8,4,4,0.72)', 'color:#e8b0a8',
      'font:20px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif',
      'z-index:95', 'pointer-events:none', 'transition:opacity 0.4s',
    ].join(';')
    document.body.appendChild(overlay)

    // 不用即死即重生：留一段时间让玩家看清自己是怎么死的
    setTimeout(() => {
      playerHealth.refill()
      healthHud.update(playerHealth.current)
      player.teleportTo(spawn.x, spawn.z, world.heightfield)
      thirdPerson.snapTo(player.position)
      combat.reset()
      overlay.style.opacity = '0'
      setTimeout(() => overlay.remove(), 420)
      respawning = false
    }, 1600)
  }

  /**
   * 完美闪避（Flurry Rush）的剩余时间。
   *
   * 敌人的攻击落下的瞬间玩家正在闪避无敌帧里——这一帧不受伤，
   * 而是进入子弹时间：世界慢下来、玩家保持原速，反打一波。
   */
  let flurryTimer = 0
  const FLURRY_SECONDS = 1.6
  const FLURRY_SCALE = 0.28
  const FLURRY_COLOR = new Color(2.2, 2.5, 3.0)

  const onDamagePlayer = (amount: number, fromPos: Vector3): void => {
    if (respawning) return
    // 料理防御增益：伤害打折（倍率可叠加式的最小 1 结算）
    if (defenseBuff < 1) amount = Math.max(1, Math.round(amount * defenseBuff))
    // 格挡：正面来袭的伤害被盾完全挡掉。盾不是万能的——侧后方
    // 的攻击挡不住，所以格挡时要面朝威胁，这是它的操作含量
    if (blocking && !player.isDodging) {
      const dx = fromPos.x - player.position.x
      const dz = fromPos.z - player.position.z
      const len = Math.hypot(dx, dz) || 1
      const facing = Math.sin(player.yaw) * (dx / len) + Math.cos(player.yaw) * (dz / len)
      if (facing > 0.35) {
        sfx.block()
        hitSparks.spawn(
          player.position.x + Math.sin(player.yaw) * 0.7,
          player.position.y + 1.1,
          player.position.z + Math.cos(player.yaw) * 0.7,
        )
        return
      }
    }
    // 闪避的无敌帧：这段时间内完全免疫，连击退都不吃
    if (player.isInvulnerable) {
      // 无敌帧里被命中 = 完美闪避。判定的本质是"攻击落下时你刚好
      // 在滚"，这正是塞尔达 Flurry Rush 的判定方式
      if (flurryTimer <= 0 && player.isDodging) {
        flurryTimer = FLURRY_SECONDS
        sfx.perfect()
        shockRing.fire(player.position.x, player.position.y, player.position.z, 3.6, FLURRY_COLOR)
        flurryVignette(true)
        toast('完美闪避！')
      }
      return
    }
    if (!playerHealth.damage(amount, PLAYER_INVULN)) return

    healthHud.update(playerHealth.current)
    healthHud.flash()
    // 挨打也在玩家身上炸一下，让"我被打了"这件事在画面正中有反馈。
    // 顿帧比打中敌人时更长一点——挨打的分量该更重
    hitStop = HIT_STOP_SECONDS * 1.6
    sfx.hurt()
    hitSparks.spawn(player.position.x, player.position.y + 1.1, player.position.z)

    // 从敌人方向把玩家推开。没有击退的话，被围住时会连续挨打却无法脱身。
    const dx = player.position.x - fromPos.x
    const dz = player.position.z - fromPos.z
    const len = Math.hypot(dx, dz) || 1
    player.velocity.x += (dx / len) * 7
    player.velocity.z += (dz / len) * 7

    if (playerHealth.isDead) handleDeath()
  }

  const thirdPerson = new ThirdPersonCamera(world.camera, canvas, world.terrain)
  // 初始朝向：沿相机默认方位看向角色前方
  thirdPerson.snapTo(player.position)
  const regionTitle = new RegionTitle()

  const input = new KeyboardInput()
  const fly = new FlyController(world.camera, canvas, world.terrain)

  const monitor = new PerfMonitor(90)
  const hud = new PerfHUD(monitor)
  const helpPanel = new HelpPanel()
  const minimap = new Minimap()
  const worldMap = new WorldMap(world.heightfield)

  // 小地图的标记数据每帧重建，复用这两个数组避免持续的 GC 压力
  const enemyMarkers: Vector3[] = []
  const fireCoords: number[] = []
  const iceCoords: number[] = []

  // 两张地图共用这一份标记数据，字段在每帧渲染前刷新
  const shrineMarkers = shrines.shrines.map((s) => ({
    x: s.position.x,
    z: s.position.z,
    cleared: s.state === 'cleared',
  }))
  const mapMarkers: MinimapMarkers = {
    playerPos: player.position,
    playerYaw: 0,
    enemies: enemyMarkers,
    fires: fireCoords,
    ice: iceCoords,
    questTarget: null,
    shrines: shrineMarkers,
  }
  minimap.onClick = () => worldMap.toggle(mapMarkers)

  // ── 背包与地上的可拾取物 ──
  const inventory = new Inventory()
  const pickups = new PickupManager()
  world.scene.add(pickups.group)
  const inventoryHud = new InventoryHud()

  const scattered = pickups.scatter(
    world.heightfield,
    28,
    new Vector3(0, 0, 0),
    150,
    (x, z) =>
      world.heightfield.height(x, z) > WATER_LEVEL + 3 &&
      world.heightfield.slopeAngle(x, z) < 0.6,
  )

  /** 吃东西回血。料理优先（回得多），果子垫后——好东西不该压箱底 */
  const EAT_ORDER: readonly ItemId[] = [
    'dish_sunny',
    'dish_meat_mushroom',
    'dish_skewer',
    'dish_mixed',
    'roast_meat',
    'dish_fruit',
    'dish_mushroom',
    'sunfruit',
    'apple',
    'berry',
    'mushroom',
  ]
  const useItem = (): void => {
    if (playerHealth.current >= playerHealth.max) {
      toast('生命已满，先留着')
      return
    }
    for (const id of EAT_ORDER) {
      if (inventory.count(id) <= 0) continue
      const def = ITEM_DEFS[id]
      inventory.remove(id)
      playerHealth.heal(def.heal)
      healthHud.update(playerHealth.current)
      // 料理增益：攻击/防御，计时走游戏内时钟
      if (def.buff) {
        if (def.buff.attack) {
          combat.damageMultiplier = def.buff.attack
          attackBuffUntil = elementElapsed + def.buff.seconds
        }
        if (def.buff.defense) {
          defenseBuff = def.buff.defense
          defenseBuffUntil = elementElapsed + def.buff.seconds
        }
        buffHudDirty = true
      }
      toast(
        def.heal >= 99
          ? `吃掉${def.name}，完全恢复！`
          : `吃掉${def.name}，恢复 ${def.heal} 颗心${def.buff?.attack ? '，攻击提升了' : def.buff?.defense ? '，身体硬朗了' : ''}`,
      )
      return
    }
    toast('背包里没有能吃的东西')
  }

  // H 键开关性能信息。用独立监听而不是走 KeyboardInput：
  // 那个是给角色移动用的，会被控制模式切换禁用，而调试信息应该随时可用。
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    if (e.code === 'KeyH') hud.toggle()
    // Esc 关烹饪界面
    if (e.code === 'Escape' && cookingMenu.isOpen) cookingMenu.close()
    // 数字键 1-4 直选武器。对话/烹饪打开时禁用——打字和点食材
    // 不该顺手把武器换了
    if (dialogue.isOpen || cookingMenu.isOpen) return
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5))
      if (n >= 1 && n <= 4 && weaponBag.switchTo(n - 1)) {
        syncWeapon()
        sfx.equip()
        const def = weaponBag.currentDef
        if (def) toast(`换上 ${def.name}`)
      }
    }
  })

  // ── 烹饪界面接线 ──
  cookingMenu.onCook = (_ingredients, dish) => {
    // 食材在下锅那一刻已经从背包扣掉（界面里点的瞬间），这里只管发料理
    inventory.add(dish)
    inventoryHud.update(inventory)
    sfx.cook()
    toast(`做好了：${ITEM_DEFS[dish].name}！`)
    // 锅留着继续煮——塞尔达里一锅接一锅是常态
    cookingMenu.refresh(inventory)
    save.save(collectSave())
  }
  cookingMenu.onOpenChange = (open) => {
    if (!open) {
      // 没结算的食材退回来，关界面不能吞掉玩家的东西
      for (const id of cookingMenu.pendingIngredients) inventory.add(id)
      cookingMenu.clearPot()
      inventoryHud.update(inventory)
      input.clearHeld()
    }
  }

  let mode: ControlMode = 'play'

  const applyMode = (next: ControlMode): void => {
    mode = next
    const play = next === 'play'
    thirdPerson.enabled = play
    input.enabled = play
    fly.enabled = !play
    avatar.object.visible = play

    if (play) {
      // 从飞行切回来时把相机重新贴到角色背后，避免镜头停在天上
      thirdPerson.snapTo(player.position)
    } else {
      // 反向切换时保留当前视线朝向，手感更连续
      fly.syncFrom(world.camera)
      // 自由飞行时角色不参与逻辑，体力环留着会误导
      staminaRing.forceHide()
    }
  }
  applyMode('play')

  // 异步加载 glTF 角色模型，加载完成后替换掉代码拼的那套外观。
  // 放在 applyMode 之后是因为回调里要读 mode；失败时静默保留原外观，
  // 不影响游玩。
  ModelAvatar.load(PLAYER_MODEL, PLAYER_RECOLOR, 'player-model', 0xe8c66a).then((model) => {
    if (!model) return
    world.scene.remove(avatar.object)
    avatar.dispose()
    avatar = model
    model.object.visible = mode === 'play'
    world.scene.add(model.object)
    // 新外观上没有武器：重新挂一次当前武器
    syncWeapon()
    // 盾牌也挂上：平时背在背后，格挡时上手
    void loadShield().then((shield) => {
      if (shield) model.setShield(shield)
    })
    console.log(`[角色] 已切换到 glTF 模型，可用动画 ${model.animationCount} 段`)
  })

  const resize = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    world.camera.aspect = w / h
    world.camera.updateProjectionMatrix()
    pipeline.setSize(w, h)
  }
  resize()
  window.addEventListener('resize', resize)

  // ── 自动巡检 ──
  let lastResults: BenchResult[] = []
  const autopilot = new Autopilot(BENCH_CASES, {
    onCaseStart: () => {
      // 巡检需要独自掌控相机
      if (mode !== 'fly') applyMode('fly')
    },
    onPose: (position, target) => {
      world.camera.position.copy(position)
      world.camera.lookAt(target)
    },
    onCaseEnd: (result) => {
      console.log(
        `[巡检] ${result.name} 完成 · avg ${result.stats.fps.avg.toFixed(1)} FPS · draw ${Math.round(result.stats.drawCalls.avg)}`,
      )
    },
    onFinish: (results) => {
      lastResults = results
      fly.syncFrom(world.camera)
      const report = formatReport(results, buildMeta(pipeline))
      console.log(report)
      showReport(report)
      toast('巡检完成 · 点报告右上角关闭 · 可「导出报告」保存')
    },
  })

  const guiState: GuiState = {
    playMode: true,
    pixelRatio: 1,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    bloomStrength: 0.35,
    exposure: 0.55,
    viewDistance: START_VIEW_DISTANCE,
    treeCount: START_TREE_COUNT,
    speed: fly.speed,
    groundFollow: false,
    timeOfDay: world.dayCycle.timeOfDay,
    autoAdvance: world.dayCycle.config.autoAdvance,
    dayLength: world.dayCycle.config.dayLength,
    windStrength: 0.22,
    soundVolume: sfx.masterVolume,
  }

  const resetCamera = (): void => {
    if (mode === 'play') {
      thirdPerson.snapTo(player.position)
      return
    }
    const y = world.heightfield.height(0, 0) + 30
    world.camera.position.set(0, y, 0)
    world.camera.lookAt(80, y - 10, 140)
    fly.syncFrom(world.camera)
  }

  createGui(
    pipeline,
    world,
    fly,
    {
      runBenchmark: () => {
        if (autopilot.isRunning) {
          autopilot.stop()
          toast('巡检已停止')
          return
        }
        toast('开始自动巡检，期间请不要操作相机')
        autopilot.start()
      },
      exportReport: () => {
        const results = lastResults.length > 0 ? lastResults : autopilot.getResults()
        if (results.length === 0) {
          toast('还没有巡检数据，请先点「开始自动巡检」')
          return
        }
        downloadText(formatReport(results, buildMeta(pipeline)), reportFilename())
      },
      resetCamera,
      toggleHUD: () => hud.toggle(),
      setMode: (play: boolean) => applyMode(play ? 'play' : 'fly'),
      setSoundVolume: (v: number) => sfx.setVolume(v),
    },
    guiState,
  )

  // ── 剧情事件 ──
  /** 骨头换向阳果：3 换 1。让打怪的掉落有去处，而不是堆在背包里 */
  const BONE_PER_FRUIT = 3

  /** 玩家手上有没有这么多某样东西 */
  const hasItem = (id: ItemId, count: number): boolean => inventory.count(id) >= count

  /** 给背包加减一组东西，并刷新 HUD */
  const grantItems = (items: ReadonlyArray<{ id: ItemId; count: number }>, take: boolean): void => {
    for (const it of items) {
      if (take) inventory.remove(it.id, it.count)
      else for (let i = 0; i < it.count; i++) inventory.add(it.id)
    }
    inventoryHud.update(inventory)
  }

  /**
   * 和 NPC 说话。支线优先于主线——玩家凑齐了东西站在对方面前，
   * 想听的是"东西给我"，不是"你还有两座祭坛没去"。
   */
  const talkToNpc = (npc: Npc): void => {
    const def = sideQuests.byNpc(npc.def.id)
    const state = def ? sideQuests.stateOf(def.id, hasItem) : null

    // ── 1. 东西齐了，交付 ──
    if (def && state === 'ready') {
      dialogue.show(def.lines.deliver, () => {
        grantItems(def.requires, true)
        grantItems(def.reward, false)
        sideQuests.complete(def.id)
        const gained = def.reward
          .map((r) => `${ITEM_DEFS[r.id].name} ×${r.count}`)
          .join('、')
        toast(`「${def.title}」完成　获得 ${gained}`)
        save.save(collectSave())
      })
      input.clearHeld()
      return
    }

    // ── 2. 贤者：主线 + 骨头换果子 ──
    if (npc.def.id === 'sage') {
      const bones = inventory.count('bone')
      const trades = Math.floor(bones / BONE_PER_FRUIT)
      if (trades > 0 && quest.currentStage !== 'awaken') {
        for (let i = 0; i < trades; i++) inventory.remove('bone', BONE_PER_FRUIT)
        for (let i = 0; i < trades; i++) inventory.add('sunfruit')
        inventoryHud.update(inventory)
        toast(`贤者收下了 ${trades * BONE_PER_FRUIT} 块骨头，给你 ${trades} 颗向阳果`)
      }

      if (quest.currentStage === 'awaken') {
        dialogue.show(SAGE_INTRO, () => {
          quest.completeIntroduction()
          toast('目标已更新：收集三枚元素封印')
        })
      } else if (quest.currentStage === 'cleared') {
        dialogue.show([
          { speaker: '贤者', text: '暗蚀散了。你看，光又回来了。' },
          { speaker: '贤者', text: '这片大陆会记住你的名字。' },
        ])
      } else {
        const pages = [
          { speaker: '贤者', text: sageProgress(quest.collectedCount, 3) },
          { speaker: '贤者', text: quest.objective.text },
        ]
        // 支线还没接的话顺口提一句，省得玩家满地图找 NPC 搭话
        const mushroomQuest = sideQuests.byNpc('sage')
        if (mushroomQuest && sideQuests.stateOf(mushroomQuest.id, hasItem) === 'unmet') {
          pages.push(mushroomQuest.lines.offer[0])
        } else if (shrines.toSave().length < 2) {
          // 前期玩家最缺的是血上限：指给他神庙的方向
          pages.push({
            speaker: '贤者',
            text: '荒野的四个方向各立着一座神庙，光柱直冲天际。通过试炼的人会得到祝福——你的心会变得更强韧。',
          })
        } else {
          pages.push({
            speaker: '贤者',
            text: `暗蚀的爪牙身上有骨头，那是好东西。攒够 ${BONE_PER_FRUIT} 块拿来给我，我换你向阳果。`,
          })
        }
        dialogue.show(pages)
      }
      input.clearHeld()
      return
    }

    // ── 3. 支线的其他状态 ──
    if (def) {
      if (state === 'unmet') {
        dialogue.show(def.lines.offer, () => {
          sideQuests.accept(def.id)
          toast(`接受支线：${def.title}（需要 ${describeNeeds(def)}）`)
          save.save(collectSave())
        })
      } else if (state === 'done') {
        dialogue.show(def.lines.done)
      } else {
        dialogue.show([
          ...def.lines.progress,
          { speaker: npc.def.name, text: `还差：${describeNeeds(def)}` },
        ])
      }
      input.clearHeld()
      return
    }

    // ── 4. 兜底 ──
    dialogue.show([{ speaker: npc.def.name, text: '……' }])
    input.clearHeld()
  }

  /** 保留旧的入口名：验证脚本和历史调用都走它 */
  const talkToSage = (): void => {
    const sage = npcById('sage')
    if (sage) talkToNpc(sage)
  }

  /** 剩余顿帧时间 */
  let hitStop = 0

  // ── 料理增益状态 ──
  /** 攻击增益的结束时刻（游戏内秒）；damageMultiplier 挂在 combat 上 */
  let attackBuffUntil = 0
  /** 防御增益（受伤倍率）与结束时刻 */
  let defenseBuff = 1
  let defenseBuffUntil = 0
  /** buff 条需要重绘 */
  let buffHudDirty = true
  /** buff 倒计时刷新节流 */
  let buffTick = 0.5
  const buffHud = document.createElement('div')
  buffHud.id = 'buff-hud'
  buffHud.style.cssText = [
    'position:fixed', 'left:14px', 'top:184px', 'z-index:55',
    'display:flex', 'gap:8px', 'pointer-events:none',
    'font:12px/1.4 -apple-system,"PingFang SC",system-ui,sans-serif',
    'text-shadow:0 1px 3px rgba(0,0,0,0.7)',
  ].join(';')
  document.body.appendChild(buffHud)

  /** 电击：站在水里放一道电流，把周围水中的敌人一并放倒 */
  const SHOCK_RANGE = 12
  const SHOCK_STAMINA = 20

  const inWaterAt = (x: number, z: number): boolean =>
    world.heightfield.height(x, z) < WATER_LEVEL - 0.4

  const discharge = (): void => {
    // 脚不在水里就放不出电。这条限制是刻意的：电击强（范围大、伤害高），
    // 代价就是"得先把敌人引到水边"，而不是随时能按的万能键
    if (!inWaterAt(player.position.x, player.position.z)) {
      toast('要站在水里才能导电')
      return
    }
    if (!player.stamina.canAfford(SHOCK_STAMINA)) {
      toast('体力不够')
      return
    }

    player.stamina.consume(SHOCK_STAMINA)
    sfx.shock()
    shockRing.fire(player.position.x, WATER_LEVEL, player.position.z, SHOCK_RANGE)

    let hit = 0
    for (const enemy of enemies.alive) {
      if (enemy.health.isDead) continue
      const d = Math.hypot(
        enemy.position.x - player.position.x,
        enemy.position.z - player.position.z,
      )
      if (d > SHOCK_RANGE) continue
      // 只有站在水里的敌人才被电到——电流顺着水面走，岸上是安全的
      if (!inWaterAt(enemy.position.x, enemy.position.z)) continue
      enemy.onHit(2, NO_KNOCKBACK, 0)
      hitSparks.spawn(enemy.position.x, enemy.position.y + 1.0, enemy.position.z, true)
      hit++
    }

    hitStop = HIT_STOP_SECONDS * 1.4
    toast(hit > 0 ? `电流击中了 ${hit} 个敌人` : '电流散开了，附近没有站在水里的敌人')
  }

  /** 起风：吹散周围的火焰，滑翔时给自己一个推力 */
  const GUST_RANGE = 10
  const GUST_STAMINA = 12
  const GUST_PUSH = 6.5
  const GUST_COLOR = new Color(2.8, 3.0, 2.9)

  const gust = (): void => {
    if (!player.stamina.canAfford(GUST_STAMINA)) {
      toast('体力不够')
      return
    }
    player.stamina.consume(GUST_STAMINA)
    sfx.gust()
    shockRing.fire(player.position.x, player.position.y, player.position.z, GUST_RANGE, GUST_COLOR)

    // 吹散火焰：这是风和火的克制关系——火能蔓延，风能让它灭
    const doused = elements.douse(player.position.x, player.position.z, GUST_RANGE)

    // 滑翔时顺风推一把。这是"用能力赶路"的设计：从山顶起跳、
    // 半路起一阵风，能多滑很远
    let pushed = false
    if (player.state === 'glide') {
      player.velocity.x += Math.sin(player.yaw) * GUST_PUSH
      player.velocity.z += Math.cos(player.yaw) * GUST_PUSH
      pushed = true
    }

    if (doused > 0) toast(`风吹散了 ${doused} 处火焰`)
    else if (pushed) toast('借风滑得更远了')
    else toast('一阵风吹过')
  }

  const handleStoryEvents = (events: StoryEvent[]): void => {
    for (const ev of events) {
      switch (ev.type) {
        case 'guardians':
          toast(`${SEAL_INFO[ev.seal].title}的守卫苏醒了 —— 击败 ${ev.count} 只骷髅`)
          break
        case 'seal':
          toast(
            quest.collectedCount >= 3
              ? `获得${SEAL_INFO[ev.seal].name} —— 三枚已集齐，前往封印之门`
              : `获得${SEAL_INFO[ev.seal].name}（${quest.collectedCount}/3）`,
          )
          sfx.seal()
          // 关键节点立刻落盘。等下一次自动保存的话，玩家在这一刻关掉页面
          // 就得重打一场守卫战——这是最容易被记住的那种挫败
          save.save(collectSave())
          break
        case 'gate-opened':
          toast('封印之门开启了')
          save.save(collectSave())
          break
        case 'boss':
          toast(`${ev.name} 拦住了去路`)
          break
        case 'cleared':
          showEnding()
          save.save(collectSave())
          break
      }
    }
  }

  /**
   * 通关画面。
   *
   * 不切场景、不清进度——玩家刚解锁了全部能力，这时候把他踢回主菜单
   * 是最亏的做法。所以这里只是一层可关闭的幕布，底下的大陆照常运转。
   *
   * 顺带把这一趟的账算给玩家看：走了多久、开了几个箱子、帮了几个人。
   * 通关那一刻是最想知道"我这一路都干了什么"的时候。
   */
  const showEnding = (): void => {
    const overlay = document.createElement('div')
    overlay.id = 'ending'
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'gap:20px',
      'background:radial-gradient(circle at 50% 40%, rgba(72,96,128,0.94), rgba(6,10,16,0.98))',
      'color:#eaf2fb', 'z-index:130', 'transition:opacity 1.2s',
      'font:16px/1.9 -apple-system,"PingFang SC",system-ui,sans-serif',
      'opacity:0',
    ].join(';')

    const title = document.createElement('div')
    title.textContent = '光之大陆恢复了宁静'
    title.style.cssText = 'font-size:30px;letter-spacing:0.22em;color:#ffe9a8;font-weight:300'

    const body = document.createElement('div')
    body.textContent = '三枚封印归位，暗蚀之源消散。你可以留在这里，继续走完这片大陆。'
    body.style.cssText = 'opacity:0.86;text-align:center;max-width:min(560px,84vw)'

    // 统计：三行数字，横排
    const stats = document.createElement('div')
    stats.style.cssText = [
      'display:flex', 'gap:38px', 'margin-top:8px', 'padding:16px 30px',
      'border-top:1px solid rgba(150,190,230,0.22)',
      'border-bottom:1px solid rgba(150,190,230,0.22)',
    ].join(';')

    const stat = (value: string, label: string): HTMLDivElement => {
      const box = document.createElement('div')
      box.style.cssText = 'text-align:center;min-width:78px'
      const v = document.createElement('div')
      v.textContent = value
      v.style.cssText = 'font-size:22px;color:#ffe9a8;font-weight:300'
      const l = document.createElement('div')
      l.textContent = label
      l.style.cssText = 'font-size:11px;color:#8fb0cc;letter-spacing:0.14em;margin-top:2px'
      box.append(v, l)
      return box
    }

    const openedChests = treasures.toSave().length
    const doneSide = sideQuests.completedCount
    stats.append(
      stat(formatPlaytime(save.elapsedSeconds), '用时'),
      stat(`${openedChests} / ${treasures.chests.length}`, '宝箱'),
      stat(`${doneSide} / ${sideQuests.all.length}`, '支线'),
    )

    const hint = document.createElement('div')
    hint.textContent = '点击任意处继续'
    hint.style.cssText = 'margin-top:6px;font-size:13px;color:#8fb0cc;letter-spacing:0.1em'

    overlay.append(title, body, stats, hint)
    document.body.appendChild(overlay)
    // 下一帧再改透明度，让 transition 有起点
    requestAnimationFrame(() => { overlay.style.opacity = '1' })

    const dismiss = (): void => {
      overlay.style.opacity = '0'
      setTimeout(() => overlay.remove(), 1300)
      window.removeEventListener('pointerdown', dismiss)
    }
    // 延后一拍再挂监听，避免触发通关的那次点击顺手把它关掉
    setTimeout(() => window.addEventListener('pointerdown', dismiss), 700)
  }

  // ── 存档 ──
  // ?fresh=1 跳过读档，用来从零验证流程（自动化测试也走这条路）
  const saveParams = new URLSearchParams(location.search)
  const save = new SaveManager(!saveParams.has('fresh'))

  /** 组装当前世界状态。所有要存的东西都从这里走，避免两处字段对不上 */
  const collectSave = () => ({
    quest: quest.toSave(),
    player: {
      x: player.position.x,
      z: player.position.z,
      yaw: player.yaw,
      health: playerHealth.current,
    },
    inventory: inventory.toSave(),
    pins: minimap.getPins(),
    treasures: treasures.toSave(),
    sideQuests: sideQuests.toSave(),
    weapons: weaponBag.toSave(),
    weaponSpawnsTaken: weaponSpawns.toSave(),
    shrines: shrines.toSave(),
    maxHearts: playerHealth.max,
  })

  // 读档。放在这里而不是开头，是因为它要动的东西（角色、背包、地图标记）
  // 分散在好几个系统里，得等它们都建好
  const restored = save.load()
  if (restored.ok) {
    const d = restored.data
    quest.restore(d.quest)
    inventory.restore(d.inventory)
    player.teleportTo(d.player.x, d.player.z, world.heightfield)
    player.yaw = d.player.yaw
    playerHealth.set(d.player.health)
    healthHud.update(playerHealth.current)
    minimap.setPins(d.pins)
    // 旧存档没有这一项，按"都还没开"处理
    if (d.treasures) treasures.restore(d.treasures)
    sideQuests.restore(d.sideQuests)
    // 武器：旧存档没有这项时 WeaponBag.restore 会塞一根树枝
    weaponBag.restore(d.weapons)
    if (d.weaponSpawnsTaken) weaponSpawns.restore(d.weaponSpawnsTaken)
    syncWeapon()
    // 神庙与心之容器：旧档没有这两项就保持初始
    if (d.shrines) shrines.restore(d.shrines)
    if (typeof d.maxHearts === 'number' && d.maxHearts > PLAYER_MAX_HEARTS) {
      playerHealth.max = d.maxHearts
      healthHud.setMax(d.maxHearts)
      playerHealth.set(Math.min(d.player.health, d.maxHearts))
      healthHud.update(playerHealth.current)
    }
    thirdPerson.snapTo(player.position)
    console.log(
      `[存档] 已读取：阶段 ${d.quest.stage}，封印 ${d.quest.seals.length}/3，游玩 ${formatPlaytime(d.playtime)}`,
    )
  } else if (restored.reason !== 'empty') {
    // 版本不符或损坏：明确告诉玩家进度没了，而不是让他自己发现
    toast('存档无法读取（格式已更新），从头开始')
  }
  // 无条件同步一次：新开局（或模型尚未加载完）时 HUD 也该显示手里的树枝
  syncWeapon()

  // 关页面/刷新前抢存一次。25 秒的自动保存意味着最多丢 25 秒进度，
  // 但"刚拿到封印就刷新"这种最气人的情况能被这一手兜住
  window.addEventListener('beforeunload', () => {
    save.save(collectSave())
  })

  // ── 主循环 ──
  const loop = new GameLoop({
    update: (dt) => {
      // 顿帧：把世界时间压慢，但 UI、存档计时、相机仍走真实时间——
      // 否则血条和对话也会跟着卡一下，那看起来像掉帧而不是打击感
      let worldDt = dt
      if (hitStop > 0) {
        hitStop = Math.max(0, hitStop - dt)
        worldDt = dt * HIT_STOP_SCALE
      }
      // 完美闪避的子弹时间：世界慢、玩家不慢。两个减速取更强的那个，
      // 玩家自己的时间轴单独算——这就是"敌人慢动作、我照常输出"
      if (flurryTimer > 0) {
        flurryTimer = Math.max(0, flurryTimer - dt)
        worldDt = Math.min(worldDt, dt * FLURRY_SCALE)
        if (flurryTimer <= 0) flurryVignette(false)
      }
      const playerDt = flurryTimer > 0 ? dt : worldDt

      if (autopilot.isRunning) {
        // 巡检接管相机，角色保持静止
      } else if (mode === 'play') {
        // 开场镜头：玩家一动就交出控制权
        if (introState.active) {
          const mv = input.read()
          if (mv.forward !== 0 || mv.right !== 0 || mv.jump || introState.t > 2.6) {
            introState.active = false
          }
        }
        // E 键：翻对话页 / 开宝箱 / 开火做饭 / 和 NPC 搭话。
        // 宝箱排在最前——箱子就在脚边时，玩家按 E 想开的是箱子；
        // 锅排在 NPC 前——站在锅边想做饭，不想听贤者讲道理
        if (input.consumeInteract()) {
          if (dialogue.isOpen) {
            sfx.blip()
            dialogue.advance()
          } else if (cookingMenu.isOpen) {
            // 烹饪中：E 不做事（防止误触），关闭用按钮或 Esc
          } else {
            const chest = treasures.nearestUnopened(player.position)
            const shrineReward = shrines.nearestReward(player.position)
            if (chest) {
              const loot = treasures.open(chest)
              for (const id of loot) inventory.add(id)
              inventoryHud.update(inventory)
              sfx.chest()
              toast(`打开宝箱：${loot.map((id) => ITEM_DEFS[id].name).join('、')}`)
              save.save(collectSave())
            } else if (shrineReward) {
              // 神庙祝福：心之容器 + 一把好武器
              shrines.openReward(shrineReward)
              playerHealth.growMax(1)
              healthHud.setMax(playerHealth.max)
              healthHud.update(playerHealth.current)
              // 每座神庙镇着一件不同的宝贝：大剑、战斧、猎弩
              const bonus =
                shrineReward.id === 'shrine-nw'
                  ? 'axe2h'
                  : shrineReward.id === 'shrine-sw'
                    ? 'crossbow'
                    : 'sword2h'
              weaponBag.add(bonus)
              if (bonus === 'crossbow') weaponBag.arrows += 8
              syncWeapon()
              sfx.chest()
              sfx.seal()
              toast(`${shrineReward.name}的祝福：生命上限 +1，获得 ${WEAPON_DEFS[bonus].name}`)
              save.save(collectSave())
            } else {
              const fire = campfires.nearestPot(player.position)
              if (fire) {
                sfx.blip()
                cookingMenu.open(inventory)
              } else {
                const npc = npcNear(player.position)
                if (npc) talkToNpc(npc)
              }
            }
          }
        }

        const talking = dialogue.isOpen || cookingMenu.isOpen

        if (!talking) {
          if (input.consumeIgnite()) {
            toast(igniteAhead() ? '点燃了草地' : '这里点不着')
          }

          if (input.consumeUse()) useItem()

          if (input.consumeShock()) discharge()

          if (input.consumeGust()) gust()

          if (input.consumeDodge()) {
            // 朝当前移动输入的方向闪；没按方向键时 dodge 会自己用角色正面
            const mv = input.read()
            const dx =
              thirdPerson.forward.x * mv.forward + thirdPerson.right.x * mv.right
            const dz =
              thirdPerson.forward.z * mv.forward + thirdPerson.right.z * mv.right
            if (player.dodge(dx, dz)) sfx.dodge()
          }

          pickups.update(dt, player.position, world.heightfield, (id) => {
            inventory.add(id)
            sfx.pickup()
            toast(`拾取 ${ITEM_DEFS[id].name}`)
          })
          inventoryHud.update(inventory)

          if (input.consumeFreeze()) {
            // 冻结消耗体力：能搭桥过河的能力不该是免费的
            const frozen = elements.freeze(player.position.x, player.position.z, world.heightfield, 8)
            if (frozen > 0) {
              player.stamina.consume(14)
              toast(`冻结了 ${frozen} 格水面`)
            } else {
              toast('附近没有可冻结的水面')
            }
          }

          // 当前武器是不是远程（弩）：远程时左键是放箭，没有近战连击与蓄力
          const shootMode = weaponBag.currentDef?.moveset === 'shoot'

          // ── 蓄力斩：按住攻击键到点自动放。360° 横扫、伤害加成 ──
          // 到点那一刻普攻往往还没收招（按下瞬间普攻已出手），
          // 所以用待发窗口：到点后 0.9 秒内手一空就放。不能"松手取消"——
          // 重武器普攻要 0.85 秒才收招，玩家等不到那一刻就松手了
          if (!blocking && !shootMode && input.consumeChargeAttack(performance.now())) chargePendingAt = elementElapsed
          if (chargePendingAt > 0 && elementElapsed - chargePendingAt > 0.9) chargePendingAt = 0
          if (chargePendingAt > 0 && !chargedSwing && !combat.isBusy) {
            chargePendingAt = 0
            chargedSwing = true
            const def = weaponBag.currentDef
            combat.config.arcRadians = Math.PI * 2 // 全向
            combat.config.damage = Math.max(1, Math.round((def?.damage ?? UNARMED.damage) * 1.8))
            combat.config.duration = 0.72
            combat.config.hitMoment = 0.4
            combat.config.windup = 0.26
            combat.config.range = (def?.range ?? UNARMED.range) + 0.5
            combat.config.knockbackForce = (def?.knockback ?? UNARMED.knockback) + 4
            comboIndex = 3 // 连击表的第 4 段是旋风斩动画
            lastAttackAt = elementElapsed
            input.attackQueued = true
            sfx.spin()
          }

          // 攻击先于移动结算：这样本帧就能应用"出招时减速"。
          // 格挡时不能攻击——盾举着的时候挥不了剑（输入仍要消费掉，
          // 否则松开盾的瞬间会把憋着的那刀放出去）
          const wantAttack = input.consumeAttack()
          let attackTrigger = blocking ? false : wantAttack

          // ── 弩：装备远程武器时，左键是射箭而不是挥砍 ──
          // combat 仍然进入 attacking（驱动拉弦动画与节奏），
          // 但近战扇形被关掉——命中由箭矢的抛物线轨迹结算
          if (shootMode && wantAttack && !blocking && !combat.isBusy) {
            if (weaponBag.arrows <= 0) {
              toast('箭用完了——野外的箭捆可以捡')
              sfx.blip()
            } else {
              weaponBag.arrows--
              weaponHud.update(weaponBag)
              combat.config.range = 0.01
              combat.config.arcRadians = 0
              attackTrigger = true
              // 面向相机正对的方向放箭，俯仰角跟着镜头走
              const camYaw = thirdPerson.yaw
              player.yaw = camYaw
              arrowStart
                .set(
                  player.position.x + Math.sin(camYaw) * 0.5,
                  player.position.y + 1.35,
                  player.position.z + Math.cos(camYaw) * 0.5,
                )
              // 箭以固定小仰角离弦：第三人称的相机俯角不能拿来当
              // 射角（默认 0.32 的俯视会把箭直接压进脚边的地里），
              // 下坠交给重力，瞄准交给玩家抬高视角的直觉
              arrows.fire(arrowStart, camYaw, 0.035)
              sfx.shoot()
              // 弩也会坏：射击耗耐久
              if (weaponBag.consumeDurability() === 'broken') {
                sfx.shatter()
                toast('猎手弩散架了！')
                syncWeapon()
              }
              weaponHud.update(weaponBag)
            }
          }
          if (attackTrigger && !combat.isBusy) {
            // 连击：上一招收手后短时间内再出手，段数 +1，动画随之轮换。
            // 隔太久就从第一段重新开始——连击的手感来自"接得上"
            const now = elementElapsed
            comboIndex = now - lastAttackAt < 1.25 ? (comboIndex + 1) % 3 : 0
            lastAttackAt = now
            // 出招瞬间亮一道弧光，命中判定在后面几帧才发生。
            // 弧光颜色跟着武器稀有度走：白→蓝→金
            const rarity = weaponBag.currentDef?.rarity
            slashTrail.start(
              player.position.x,
              player.position.y,
              player.position.z,
              player.yaw,
              true,
              rarity === 'epic' ? TRAIL_EPIC : rarity === 'rare' ? TRAIL_RARE : undefined,
            )
            sfx.swing()
          }
          // 攻击目标 = 敌人 + 野兽。两者都实现了 AttackTarget，
          // 战斗系统不需要知道砍的是谁
          attackTargets.length = 0
          for (const e of enemies.alive) attackTargets.push(e)
          for (const a of wildlife.alive) attackTargets.push(a)
          const hits = combat.update(playerDt, player.position, player.yaw, attackTrigger, attackTargets)
          // 蓄力斩收招后恢复当前武器的普通参数
          if (chargedSwing && !combat.attacking) {
            chargedSwing = false
            syncWeapon()
          }

          // ── 箭矢飞行与命中结算 ──
          // 箭在命中帧前就已离弦，所以每帧都推进，不等出招节奏
          arrows.update(worldDt, world.heightfield, attackTargets, arrowHits)
          for (const hit of arrowHits) {
            const dmg = weaponBag.currentDef?.moveset === 'shoot' ? weaponBag.currentDef.damage : 2
            hitDir.set(
              hit.target.position.x - player.position.x,
              0,
              hit.target.position.z - player.position.z,
            ).normalize()
            hit.target.onHit(dmg, hitDir, 5)
            hitSparks.spawn(hit.point.x, hit.point.y, hit.point.z)
            sfx.hit()
            hitStop = HIT_STOP_SECONDS
          }
          if (hits.length > 0) {
            // 命中帧：火花、顿帧、音效一股脑在这一帧放出来
            hitStop = HIT_STOP_SECONDS
            let hitBeast = false
            for (const target of hits) {
              hitSparks.spawn(target.position.x, target.position.y + 1.0, target.position.z)
              if (target instanceof Animal) hitBeast = true
            }
            if (hitBeast) sfx.hitFlesh()
            else sfx.hit()

            // 耐久按"命中"消耗而不是按"挥砍"——挥空不该磨损武器。
            // 一招打中多个目标也只耗 1 点：那是剑的本事，不是损耗加倍的理由
            if (weaponBag.consumeDurability() === 'broken') {
              sfx.shatter()
              toast('武器碎掉了！')
              syncWeapon()
            }
            weaponHud.update(weaponBag)
          }
          // 格挡时走得慢：举盾移动是小碎步
          player.speedMultiplier = combat.moveFactor * (blocking ? 0.4 : 1)

          player.update(playerDt, input.read(), thirdPerson.forward, thirdPerson.right, world.heightfield)
          playerHealth.update(dt)
        } else {
          // 对话期间只冻结角色，不冻结世界：敌人照常行动、火照常烧，
          // 否则对话会变成一段可以拿来做安全屋的无敌时间
          player.speedMultiplier = 1
          combat.update(worldDt, player.position, player.yaw, false, enemies.alive)
        }

        thirdPerson.update(worldDt, player.position)
        avatar.update(player.position, player.yaw, playerDt, {
          grounded: player.grounded,
          speed: talking ? 0 : player.horizontalSpeed,
          state: talking ? 'ground' : player.state,
          attackProgress: combat.attacking ? combat.progress : 0,
          attacking: combat.attacking,
          attackCombo: comboIndex,
          charging: !blocking && input.isCharging(performance.now()) && !combat.isBusy,
          blocking,
          dodging: player.isDodging,
          invulnRatio: playerHealth.isInvulnerable
            ? Math.max(0, 1 - playerHealth.sinceDamage / PLAYER_INVULN)
            : 0,
        })
        staminaRing.update(player.stamina.ratio, player.stamina.draining)

        // 交互提示：宝箱 > 神庙奖励 > 锅 > NPC，与按键处理同一个优先级
        if (!talking) {
          if (treasures.nearestUnopened(player.position)) {
            interactPrompt.show('按 E 打开宝箱')
          } else if (shrines.nearestReward(player.position)) {
            interactPrompt.show('按 E 接受神庙的祝福')
          } else if (campfires.nearestPot(player.position)) {
            interactPrompt.show('按 E 生火做饭')
          } else {
            const npc = npcNear(player.position)
            if (npc) {
              // 可交付时把提示改成"交付"，玩家一眼知道该干什么
              const def = sideQuests.byNpc(npc.def.id)
              const ready = def && sideQuests.stateOf(def.id, hasItem) === 'ready'
              interactPrompt.show(
                ready ? `按 E 向${npc.def.name}交付` : `按 E 与${npc.def.name}交谈`,
              )
            } else {
              interactPrompt.hide()
            }
          }
        } else {
          interactPrompt.hide()
        }
      } else {
        fly.update(dt)
        interactPrompt.hide()
      }

      // 敌人始终更新，不随控制模式切换。这样性能巡检也能覆盖它们的
      // 渲染与 AI 开销——否则巡检测出来的是一张没有敌人的空场景。
      enemies.update(worldDt, player.position, world.heightfield, onDamagePlayer, world.camera)

      // ── 野兽 ──
      wildlife.update(worldDt, player.position, world.heightfield, onDamagePlayer, world.obstacles)
      // 尸体停留一会儿再化成掉落物：猎物倒下的瞬间玩家要知道"它死了"，
      // 立刻消失会读成"它不见了"
      for (const corpse of wildlife.collectCorpses()) {
        for (let i = 0; i < corpse.def.meat; i++) {
          const angle = (i / corpse.def.meat) * Math.PI * 2 + 0.6
          pickups.spawnAt(
            corpse.position.x + Math.cos(angle) * 0.6,
            corpse.position.y,
            corpse.position.z + Math.sin(angle) * 0.6,
            'raw_meat',
          )
        }
      }

      // ── 武器拾取：走近插着的武器自动拔起；箭捆则是弹药补给 ──
      const pickedWeapon = weaponSpawns.update(worldDt, player.position)
      if (pickedWeapon && mode === 'play') {
        if (pickedWeapon === 'arrow_bundle') {
          weaponBag.arrows += 5
          weaponHud.update(weaponBag)
          sfx.pickup()
          toast('捡起一捆箭（+5）')
          save.save(collectSave())
        } else {
          const def = WEAPON_DEFS[pickedWeapon]
          const { replaced } = weaponBag.add(pickedWeapon)
          syncWeapon()
          sfx.pickup()
          toast(
            replaced
              ? `捡起 ${def.name}（${WEAPON_DEFS[replaced.id].name} 被丢下了）`
              : `捡起 ${def.name} —— ${def.desc}`,
          )
          save.save(collectSave())
        }
      }

      // 篝火火焰脉动
      campfires.update(worldDt)

      // ── 神庙挑战 ──
      // 站上休眠神庙的石台 → 挑战开始
      const pendingShrine = shrines.pendingActivation(player.position)
      if (pendingShrine && !shrineChallenge && mode === 'play') {
        shrines.activate(pendingShrine)
        sfx.seal()
        toast(`${pendingShrine.name}的试炼开始了——击退所有守卫`)
        spawnShrineWave(pendingShrine)
      }
      // 波次推进：这一波全灭 → 下一波；全部打完 → 祝福降临
      if (shrineChallenge) {
        const allDead = shrineChallenge.waveEnemies.every((e) => e.health.isDead)
        if (allDead) {
          const { shrine } = shrineChallenge
          shrineChallenge = null
          if (shrines.advanceWave(shrine)) {
            sfx.seal()
            toast(`${shrine.name}的试炼通过！中央出现了祝福宝箱`)
            save.save(collectSave())
          } else {
            // 下一波稍停半拍，让玩家喘口气
            const s = shrine
            setTimeout(() => spawnShrineWave(s), 1200)
          }
        }
      }
      shrines.update(worldDt, elementElapsed)

      // ── 掉落 ──
      // 在死亡的那一刻结算，而不是等倒地动画播完——否则玩家要盯着尸体
      // 等两秒才看到东西掉出来
      for (const enemy of enemies.alive) {
        if (enemy.state === 'dead' && enemy.lootPending) {
          enemy.lootPending = false
          // 掉落由种类决定：小兵掉一块骨头，精英掉三块加一颗向阳果。
          // 散开一点摆放，否则几件东西会精确重叠成一个
          enemy.loot.forEach((id, i) => {
            const angle = (i / enemy.loot.length) * Math.PI * 2
            pickups.spawnAt(
              enemy.position.x + Math.cos(angle) * 0.55,
              enemy.position.y,
              enemy.position.z + Math.sin(angle) * 0.55,
              id,
            )
          })
          // 精英怪掉落武器：它生前用的那把就插在尸体旁。
          // 强敌掉好武器是塞尔达的核心循环——让玩家有理由去啃硬骨头
          if (enemy.kind === 'elite') {
            const drop = Math.random() < 0.5 ? 'sword2h' : 'axe2h'
            weaponSpawns.dropAt(
              enemy.position.x + 0.9,
              enemy.position.y,
              enemy.position.z + 0.4,
              drop,
            )
          }
        }
      }

      // 自动保存按 25 秒节流，内部会计时
      save.tick(dt, collectSave)

      // ── 战斗特效 ──
      hitSparks.update(worldDt)
      shockRing.update(worldDt)
      slashTrail.update(worldDt, player.position.x, player.position.y, player.position.z)

      // ── 剧情与收集品 ──
      treasures.update(worldDt)
      landmarks.update(worldDt)
      for (const npc of npcs) npc.update(worldDt, player.position)
      handleStoryEvents(story.update(player.position, world.heightfield))

      // ── 元素系统 ──
      elementElapsed += dt

      // 料理增益过期；倒计时 0.5s 刷一次
      buffTick -= dt
      if (buffTick <= 0) {
        buffTick = 0.5
        buffHudDirty = true
      }
      if (attackBuffUntil > 0 && elementElapsed >= attackBuffUntil) {
        attackBuffUntil = 0
        combat.damageMultiplier = 1
        buffHudDirty = true
      }
      if (defenseBuffUntil > 0 && elementElapsed >= defenseBuffUntil) {
        defenseBuffUntil = 0
        defenseBuff = 1
        buffHudDirty = true
      }
      if (buffHudDirty) {
        buffHudDirty = false
        const parts: string[] = []
        if (attackBuffUntil > elementElapsed) {
          parts.push(`<span style="color:#ffd27a">⚔ 攻击 ×${combat.damageMultiplier} · ${Math.ceil(attackBuffUntil - elementElapsed)}s</span>`)
        }
        if (defenseBuffUntil > elementElapsed) {
          parts.push(`<span style="color:#9fd0ff">🛡 受伤减半 · ${Math.ceil(defenseBuffUntil - elementElapsed)}s</span>`)
        }
        buffHud.innerHTML = parts.join('')
      }
      // 风向缓慢旋转，火线才会朝不同方向拉长，而不是永远一个朝向
      windDir.set(Math.cos(elementElapsed * 0.03), Math.sin(elementElapsed * 0.03))
      elements.update(worldDt, world.heightfield, windDir)
      fireRenderer.update(elements.cells, elementElapsed, groundHeightAt)
      iceRenderer.update(elements.iceCells)

      // 游泳涟漪：贴着水面冒，上岸立刻收干净
      if (player.state === 'swim') {
        swimSplash.update(
          dt,
          true,
          player.position.x,
          world.water.config.level,
          player.position.z,
          player.horizontalSpeed,
        )
      } else {
        swimSplash.clear()
      }

      // 火焰伤害：玩家和敌人都怕火。玩家的无敌帧天然充当了灼烧的冷却，
      // 不需要额外计时器。
      if (mode === 'play' && !respawning && elements.isBurning(player.position.x, player.position.z)) {
        onDamagePlayer(1, player.position)
      }
      for (const enemy of enemies.alive) {
        if (!enemy.health.isDead && elements.isBurning(enemy.position.x, enemy.position.z)) {
          enemy.onHit(1, NO_KNOCKBACK, 0)
        }
      }

      // 地形流式加载与阴影跟随以「关注点」为中心：游玩时是角色，
      // 巡检/飞行时是相机。用相机位置会在镜头拉远时让加载中心偏移。
      const focus: Vector3 = mode === 'play' && !autopilot.isRunning ? player.position : world.camera.position
      world.update(worldDt, focus)

      // 区域标题：玩家走进新区域时亮出地名
      if (mode === 'play') {
        regionTitle.update(dt, player.position.x, player.position.z, player.position.y)
      }
    },
    render: (dt) => {
      if (autopilot.isRunning) autopilot.beforeRender(dt)

      // 开场镜头推进：从高空俯瞰滑到肩后
      if (introState.active) {
        introState.t += dt
        const t = Math.min(1, introState.t / 2.4)
        const k = t * t * (3 - 2 * t)
        thirdPerson.config.distance = 22 + (6.5 - 22) * k
        thirdPerson.pitch = 1.1 + (0.32 - 1.1) * k
        if (t >= 1) introState.active = false
      }

      const objective = quest.objective

      pipeline.render()

      // 采样放在渲染之后：renderer.info 此时才反映这一帧的真实工作量
      const sample = monitor.push(dt * 1000, pipeline.info)
      autopilot.afterRender(sample)

      // ── 小地图 ──
      enemyMarkers.length = 0
      for (const enemy of enemies.alive) {
        // 直接引用敌人的 position 向量，不复制——省掉每帧的临时对象
        if (!enemy.health.isDead) enemyMarkers.push(enemy.position)
      }
      fireCoords.length = 0
      for (const cell of elements.cells) fireCoords.push(cell.x, cell.z)
      iceCoords.length = 0
      for (const key of elements.iceCells) {
        const p = ElementGrid.keyToWorld(key)
        iceCoords.push(p.x, p.z)
      }
      // 复用同一个 markers 对象：小地图与大地图读的是同一份数据，
      // 不会出现"小地图上有敌人、大地图上没有"的不同步
      mapMarkers.playerPos = player.position
      mapMarkers.playerYaw = player.yaw
      mapMarkers.enemies = enemyMarkers
      mapMarkers.fires = fireCoords
      mapMarkers.ice = iceCoords
      mapMarkers.questTarget = objective.target
      // 神庙通关状态会变化（位置不变），原地更新标志
      for (let i = 0; i < shrineMarkers.length; i++) {
        shrineMarkers[i].cleared = shrines.shrines[i].state === 'cleared'
      }

      minimap.update(dt, world.heightfield, mapMarkers)
      if (worldMap.isOpen) worldMap.update(mapMarkers)

      // 任务栏：目标文案 + 直线距离。距离用直线而不是路径，这一版地形
      // 没有不可逾越的障碍，直线距离足够玩家判断"还远不远"。
      // 支线挂在下面一行，只显示一条，多了会喧宾夺主
      const activeSide = sideQuests.activeDefs()
      let sideText: string | undefined
      if (activeSide.length > 0) {
        const def = activeSide[0]
        const st = sideQuests.stateOf(def.id, hasItem)
        sideText =
          st === 'ready'
            ? `支线 · ${def.title} —— 可以交付了`
            : `支线 · ${def.title}（${describeNeeds(def)}）`
        if (activeSide.length > 1) sideText += `　+${activeSide.length - 1}`
      }
      objectiveBanner.update(
        objective.text,
        objective.target
          ? Math.hypot(
              player.position.x - objective.target.x,
              player.position.z - objective.target.z,
            )
          : null,
        sideText,
      )

      const progress = autopilot.progressText
      const clock = `时刻 ${world.dayCycle.clockText}`
      const sealText = `封印 ${quest.collectedCount}/3`
      hud.setExtra(
        progress
          ? progress
          : mode === 'play'
            ? `${clock}  ${STATE_LABEL[player.state]}${player.isDodging ? '·闪避' : ''}  ${player.horizontalSpeed.toFixed(1)} m/s${player.currentUpdraft > 0.05 ? '  ↑气流' : ''}\n体力 ${player.stamina.current.toFixed(0)}%  ${sealText}  敌 ${enemies.livingCount}  火 ${elements.burningCount}  冰 ${elements.iceCount}`
            : `${clock}  自由飞行\n块 ${world.terrain.chunkCount}/${world.terrain.queueLength}  树 ${world.vegetation.treeCount}`,
      )
      hud.update(performance.now())
    },
  })

  loop.start()

  // ?hour=18 设定起始时刻，?freeze=1 冻结时间——用于截图对比不同时段的光照
  const hourParam = saveParams.get('hour')
  if (hourParam !== null) {
    const hour = Number(hourParam)
    if (Number.isFinite(hour)) {
      world.dayCycle.setHour(hour)
      guiState.timeOfDay = world.dayCycle.timeOfDay
    }
  }
  if (saveParams.has('freeze')) {
    world.dayCycle.config.autoAdvance = false
    guiState.autoAdvance = false
  }

  // ?bench=1 自动开跑巡检，用于无人值守的回归测试；
  // 延时是为了等地形流式加载完成，否则测到的是加载中的帧
  if (saveParams.has('bench')) {
    const delayMs = Number(saveParams.get('delay') ?? 6000)
    setTimeout(() => autopilot.start(), delayMs)
  }

  // 首帧渲染完成后再淡出加载页，避免出现白屏
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setLoadProgress(100, '就绪')
      const loading = document.getElementById('loading')
      loading?.classList.add('hidden')
      // 兜底：淡出结束后彻底移出布局。只靠 opacity 的话，若过渡被打断
      // （后台标签页、虚拟时间）会留下一层半透明遮罩挡在画面上。
      setTimeout(() => {
        if (loading) loading.style.display = 'none'
      }, 600)
      // 开场：塞尔达式的"从天上落下来看这个世界"——相机从高空俯冲到
      // 肩后，同时打出标题。玩家一动（任意移动键）就跳过
      if (!restored.ok) startIntro()
      toast('WASD 移动 · 左键挥武器 · 数字键换武器 · 打猎生火做饭 · 空格跳跃/滑翔')
    })
  })

  /** 开场引导镜头。读档回来的老玩家跳过——他已经认识这个世界了 */
  const introState = { t: 0, active: false }
  function startIntro(): void {
    introState.active = true
    introState.t = 0
    thirdPerson.config.distance = 22
    thirdPerson.pitch = 1.1

    const title = document.createElement('div')
    title.id = 'intro-title'
    title.style.cssText = [
      'position:fixed', 'left:50%', 'top:38%', 'transform:translate(-50%,-50%)',
      'text-align:center', 'z-index:60', 'pointer-events:none',
      'color:#f2ecd8', 'text-shadow:0 2px 24px rgba(0,0,0,0.8)',
      'opacity:0', 'transition:opacity 1.4s',
      'font:300 34px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif',
      'letter-spacing:0.5em',
    ].join(';')
    title.innerHTML = '光之大陆<div style="font-size:13px;letter-spacing:0.3em;opacity:0.75;margin-top:10px">暗蚀降临之后</div>'
    document.body.appendChild(title)
    requestAnimationFrame(() => { title.style.opacity = '1' })
    setTimeout(() => {
      title.style.opacity = '0'
      setTimeout(() => title.remove(), 1500)
    }, 3400)
  }

  // 方便在控制台里手动检查
  /** 运行中替换主角外观。挑模型/调配色时要反复对比，重启一次太慢 */
  const swapAvatar = async (url: string, recolor?: RecolorRule[]): Promise<boolean> => {
    const model = await ModelAvatar.load(url, recolor)
    if (!model) return false
    world.scene.remove(avatar.object)
    avatar.dispose()
    avatar = model
    model.object.visible = mode === 'play'
    world.scene.add(model.object)
    console.log(`[角色] 已切换到 ${url}`)
    return true
  }

  Object.assign(window as unknown as Record<string, unknown>, {
    __world: world,
    __nature: nature,
    __pipeline: pipeline,
    __setAvatar: swapAvatar,
    __input: input,
    __save: save,
    __treasures: treasures,
    __sparks: hitSparks,
    __discharge: discharge,
    __sfx: sfx,
    __damagePlayer: onDamagePlayer,
    __gust: gust,
    __avatar: () => avatar,
    __collectSave: collectSave,
    __splash: swimSplash,
    __autopilot: autopilot,
    __loop: loop,
    __player: player,
    __thirdPerson: thirdPerson,
    __combat: combat,
    __enemies: enemies,
    __playerHealth: playerHealth,
    __monitor: monitor,
    __elements: elements,
    __help: helpPanel,
    __inventory: inventory,
    __pickups: pickups,
    __minimap: minimap,
    // 武器 / 野兽 / 烹饪：验证脚本要能直接读状态和触发动作
    __weaponBag: weaponBag,
    __weaponSpawns: weaponSpawns,
    __syncWeapon: syncWeapon,
    __wildlife: wildlife,
    __campfires: campfires,
    __cookingMenu: cookingMenu,
    __shrines: shrines,
    __spawnShrineWave: spawnShrineWave,
    __isFlurry: () => flurryTimer > 0,
    __chargeState: () => ({ pending: chargePendingAt > 0, swing: chargedSwing }),
    __arrows: arrows,
    __buffs: () => ({
      attack: combat.damageMultiplier,
      attackLeft: Math.max(0, attackBuffUntil - elementElapsed),
      defense: defenseBuff,
      defenseLeft: Math.max(0, defenseBuffUntil - elementElapsed),
    }),
    // 剧情系统：自动化脚本要能推进任务、查地标坐标，不必真的走过去
    __quest: quest,
    __landmarks: landmarks,
    __story: story,
    __dialogue: dialogue,
    __sage: () => npcById('sage'),
    __npc: (id: string) => npcById(id),
    __sideQuests: sideQuests,
    // 验证脚本需要在不按键盘的前提下推进对话
    __talkToSage: () => talkToSage(),
    __talkToNpc: (npc: Npc) => talkToNpc(npc),
    // 自动化脚本（tools/shot.mjs）需要切模式才能接管相机
    __setMode: (play: boolean) => applyMode(play ? 'play' : 'fly'),
  })

  console.log(`[战斗] 生成敌人 ${spawned} 个`)
  console.log(`[物品] 撒下可拾取物 ${scattered} 个`)
}

/**
 * 找一个适合出发的出生点。
 *
 * 只按"最平坦"来选会挑到滩涂——平是平，但一片黄沙，不像能开始冒险的
 * 地方（第一版就踩了这个坑）。所以同时考虑三件事：坡度平缓、海拔落在
 * 草原带内、离原点近。
 */
function findFlatSpawn(hf: Heightfield): { x: number; z: number } {
  const GRASS_MIN = 16
  const GRASS_MAX = 45

  let best = { x: 0, z: 0 }
  let bestScore = Infinity
  for (let radius = 0; radius <= 90; radius += 12) {
    const samples = radius === 0 ? 1 : 12
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2
      const x = Math.cos(angle) * radius
      const z = Math.sin(angle) * radius
      const slope = hf.slope(x, z)
      const h = hf.height(x, z)

      // 低于草原带罚得重（避免滩涂），过高也罚但轻一些（山顶也能接受）
      const heightPenalty = h < GRASS_MIN ? (GRASS_MIN - h) * 0.06 : h > GRASS_MAX ? (h - GRASS_MAX) * 0.03 : 0
      const score = slope * 3 + heightPenalty + radius * 0.004

      if (score < bestScore) {
        bestScore = score
        best = { x, z }
      }
    }
  }
  return best
}

function buildMeta(pipeline: RenderPipeline): Record<string, string | number> {
  const gl = pipeline.renderer.getContext()
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : '未知（浏览器隐藏了 GPU 信息）'

  return {
    时间: new Date().toLocaleString('zh-CN'),
    GPU: gpu,
    UA: navigator.userAgent,
    窗口: `${window.innerWidth}×${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    分辨率倍率: pipeline.settings.pixelRatio,
    实际渲染分辨率: `${Math.round(window.innerWidth * pipeline.settings.pixelRatio)}×${Math.round(window.innerHeight * pipeline.settings.pixelRatio)}`,
    阴影: pipeline.settings.shadows ? `开 (${pipeline.settings.shadowMapSize})` : '关',
    Bloom: pipeline.settings.bloom ? `开 (${pipeline.settings.bloomStrength})` : '关',
  }
}

function reportFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `perf-report-${stamp}.txt`
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 立刻 revoke 在部分浏览器会中断下载，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  toast(`已导出 ${filename}`)
}

/**
 * 子弹时间的屏幕暗角。一层边缘泛蓝的径向渐变，flurry 期间显示——
 * 画面本身没变（角色动作照常），但"时间慢了"这件事必须有个
 * 全局视觉信号，否则玩家读不出自己进入了奖励窗口
 */
function flurryVignette(on: boolean): void {
  let el = document.getElementById('flurry-vignette')
  if (on) {
    if (el) return
    el = document.createElement('div')
    el.id = 'flurry-vignette'
    el.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:70',
      'background:radial-gradient(ellipse at center, transparent 52%, rgba(120,180,255,0.22) 100%)',
      'transition:opacity 0.12s',
    ].join(';')
    document.body.appendChild(el)
  } else {
    el?.remove()
  }
}

/** 在页面上展示巡检报告，省得每次都去翻控制台 */
function showReport(text: string): void {
  const existing = document.getElementById('report')
  if (existing) existing.remove()

  const box = document.createElement('div')
  box.id = 'report'
  box.style.cssText = [
    'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
    'max-width:min(760px, 92vw)', 'max-height:76vh', 'overflow:auto',
    'background:rgba(10,17,24,0.96)', 'color:#cfe3f5', 'padding:20px 24px',
    'border-radius:10px', 'border:1px solid rgba(120,170,220,0.3)',
    'font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre', 'z-index:90', 'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
  ].join(';')

  const close = document.createElement('div')
  close.textContent = '✕'
  close.style.cssText = [
    'position:sticky', 'top:0', 'float:right', 'cursor:pointer',
    'color:#7f9db8', 'font-size:15px', 'padding:0 4px', 'user-select:none',
  ].join(';')
  close.onclick = () => box.remove()

  const pre = document.createElement('div')
  pre.textContent = text
  pre.style.clear = 'both'

  box.appendChild(close)
  box.appendChild(pre)
  document.body.appendChild(box)
}

let toastTimer = 0
function toast(message: string): void {
  let el = document.getElementById('toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:36px', 'transform:translateX(-50%)',
      'background:rgba(12,20,28,0.9)', 'color:#cfe3f5', 'padding:10px 18px',
      'border-radius:8px', 'font:13px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif',
      'z-index:80', 'pointer-events:none', 'transition:opacity 0.35s',
      'border:1px solid rgba(120,170,220,0.25)',
    ].join(';')
    document.body.appendChild(el)
  }
  el.textContent = message
  el.style.opacity = '1'
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el!.style.opacity = '0'
  }, 3200)
}

boot().catch((err: unknown) => {
  // 把启动失败暴露到 window 上，自动化脚本（tools/verify_bench.mjs）才能诊断
  ;(window as unknown as Record<string, unknown>).__bootError = String(err)
  console.error('启动失败:', err)
})
