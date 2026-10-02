/**
 * 小地图。
 *
 * 两个关键取舍：
 *
 * 1. **地形底图分帧采样**。按 64×64 采样一次要跑四千多次噪声查询，
 *    一口气做完会造成肉眼可见的卡顿。改成每帧只扫 4 行，十几帧铺满，
 *    总代价相同但没有一帧超预算。
 *
 * 2. **只在玩家走远时重采样**。底图按世界坐标绘制，玩家在小范围内
 *    移动时它依然有效；走超过一定距离才需要重新采样。每帧重算纯属浪费。
 *
 * 标记（玩家/敌人/火/冰）每帧重绘，它们数量少、开销可以忽略。
 */

import { Vector3 } from 'three'
import { WATER_LEVEL, type Heightfield } from '../terrain/heightfield.ts'

export interface MinimapMarkers {
  playerPos: Vector3
  playerYaw: number
  /** 敌人位置（含死亡动画中的） */
  enemies: readonly Vector3[]
  /**
   * 燃烧格子的世界坐标，扁平存放 [x0,z0,x1,z1,...]。
   * 用扁平数字数组而不是 Vector2[]，是为了每帧重建时零对象分配——
   * 火场可能有上百个格子，每帧 new 上百个 Vector2 会持续给 GC 施压。
   */
  fires: readonly number[]
  /** 冰面格子的世界坐标，同样是扁平数组 */
  ice: readonly number[]
  /**
   * 当前任务目标。地图会把它画成一颗金色菱形，目标在视野外时贴边指方向。
   * 塞尔达式的引导不靠堆文字，靠"地图上那个一直亮着的点"。
   */
  questTarget: { x: number; z: number } | null
  /** 神庙标记：未通关的亮青色，通关后转金。位置固定，由 main 构建一次 */
  shrines?: readonly { x: number; z: number; cleared: boolean }[]
}

const RESOLUTION = 64
const DEFAULT_RANGE = 240
const ROWS_PER_FRAME = 4
/** 扫描节流间隔（秒）：约等于 60fps 下的每帧一次 */
const SCAN_INTERVAL = 0.016
/** 玩家离开底图中心超过这个距离就重新采样 */
const RESAMPLE_DISTANCE = 55
/** 拖动结束后过多久自动回中（秒） */
const RECENTER_DELAY = 2.6
/** 玩家标记的上限 */
const PINS_MAX = 12

export class Minimap {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly range: number
  private readonly pixelSize: number

  /** 底图缓存的像素颜色（RGBA），按 RESOLUTION² 展开 */
  private readonly terrainPixels = new Uint8ClampedArray(RESOLUTION * RESOLUTION * 4)
  private scanRow = 0
  private scanning = false
  private scanAccum = 0
  /** 底图中心的世界坐标 */
  private centerX = Number.NaN
  private centerZ = 0

  /** 点击小地图的回调，用来打开大地图 */
  onClick: (() => void) | null = null

  /**
   * 拖动查看时的偏移（相对玩家）。松手几秒后自动归零。
   *
   * 塞尔达的小地图可以拖出去看别处，但不会一直停在那里——不自动回中的话，
   * 玩家跑一段之后会忘了自己看的不是当前位置。
   */
  private viewOffsetX = 0
  private viewOffsetZ = 0
  private dragging = false
  private dragStartX = 0
  private dragStartY = 0
  private dragStartOffsetX = 0
  private dragStartOffsetZ = 0
  /** 按下期间移动了多少像素，用来区分"点击"和"拖动" */
  private dragDistance = 0
  private recenterDelay = 0
  /** 玩家自己打的标记，最多留这么多个 */
  private readonly pins: Array<{ x: number; z: number }> = []

  constructor(size = 168, range = DEFAULT_RANGE) {
    this.range = range
    this.pixelSize = size

    this.canvas = document.createElement('canvas')
    this.canvas.id = 'minimap'
    this.canvas.width = size
    this.canvas.height = size
    // 放在左下角、帮助按钮的正上方
    this.canvas.style.cssText = [
      'position:fixed', 'left:22px', 'bottom:80px',
      `width:${size}px`, `height:${size}px`,
      'border-radius:50%', 'border:1px solid rgba(130,180,225,0.45)',
      'background:rgba(8,14,20,0.7)', 'z-index:1010',
      'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
      // 可点击才能打开大地图。加 title 提示，否则没人会想到地图能点。
      'cursor:pointer',
    ].join(';')
    this.canvas.title = '拖动查看别处 · 右键打标记 · 单击打开大地图'
    // 不再用 click：要区分"点一下打开地图"和"拖出去看别处"
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    document.body.appendChild(this.canvas)

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建小地图的 2D 上下文')
    this.ctx = ctx
  }

  private onPointerDown = (e: PointerEvent): void => {
    // 只处理左键拖动；右键留给打标记
    if (e.button !== 0) return
    e.preventDefault()
    this.dragging = true
    this.dragDistance = 0
    this.dragStartX = e.clientX
    this.dragStartY = e.clientY
    this.dragStartOffsetX = this.viewOffsetX
    this.dragStartOffsetZ = this.viewOffsetZ
    this.recenterDelay = 0
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return
    const dx = e.clientX - this.dragStartX
    const dy = e.clientY - this.dragStartY
    this.dragDistance = Math.hypot(dx, dy)

    // 屏幕位移换算成世界位移。地图是上北下南：x 向右、z 向下，
    // 拖动方向与视野移动方向相反（像在地图上"推"）
    const perPixel = this.range / this.pixelSize
    this.viewOffsetX = this.dragStartOffsetX - dx * perPixel
    this.viewOffsetZ = this.dragStartOffsetZ - dy * perPixel
  }

  private onPointerUp = (): void => {
    if (!this.dragging) return
    this.dragging = false
    // 几乎没动就算点击：打开大地图
    if (this.dragDistance < 5) {
      this.viewOffsetX = 0
      this.viewOffsetZ = 0
      this.onClick?.()
      return
    }
    // 拖过之后停留一会儿再回中，让玩家看清刚才拖到哪
    this.recenterDelay = RECENTER_DELAY
  }

  /** 右键在指针位置打一个标记；同一个位置再点一次则取消 */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const perPixel = this.range / this.pixelSize
    const cx = this.centerX + this.viewOffsetX
    const cz = this.centerZ + this.viewOffsetZ
    const wx = cx + (sx - this.pixelSize / 2) * perPixel
    const wz = cz + (sy - this.pixelSize / 2) * perPixel

    // 附近已有标记就删掉它，否则加一个（上限 PINS_MAX，超出挤掉最旧的）
    const near = this.pins.findIndex((p) => Math.hypot(p.x - wx, p.z - wz) < perPixel * 10)
    if (near >= 0) {
      this.pins.splice(near, 1)
      return
    }
    this.pins.push({ x: wx, z: wz })
    if (this.pins.length > PINS_MAX) this.pins.shift()
  }

  /** 导出玩家标记，供存档用 */
  getPins(): Array<{ x: number; z: number }> {
    return this.pins.map((p) => ({ x: p.x, z: p.z }))
  }

  /** 读档时恢复标记 */
  setPins(pins: ReadonlyArray<{ x: number; z: number }>): void {
    this.pins.length = 0
    for (const p of pins.slice(0, PINS_MAX)) {
      if (Number.isFinite(p?.x) && Number.isFinite(p?.z)) this.pins.push({ x: p.x, z: p.z })
    }
  }

  /** 强制重新采样底图（传送、换区域时用） */
  invalidate(): void {
    this.centerX = Number.NaN
  }

  update(dt: number, terrain: Heightfield, markers: MinimapMarkers): void {
    const px = markers.playerPos.x
    const pz = markers.playerPos.z

    // 拖动结束后先停一会儿，再平滑回到玩家身上
    if (!this.dragging && (this.viewOffsetX !== 0 || this.viewOffsetZ !== 0)) {
      if (this.recenterDelay > 0) {
        this.recenterDelay -= dt
      } else {
        const k = Math.min(1, dt * 3.2)
        this.viewOffsetX -= this.viewOffsetX * k
        this.viewOffsetZ -= this.viewOffsetZ * k
        if (Math.abs(this.viewOffsetX) < 0.5 && Math.abs(this.viewOffsetZ) < 0.5) {
          this.viewOffsetX = 0
          this.viewOffsetZ = 0
        }
      }
    }

    // 首次或走远时，把底图中心移到玩家脚下并开始分帧采样
    if (!Number.isFinite(this.centerX)) {
      this.beginResample(px, pz)
    } else if (Math.hypot(px - this.centerX, pz - this.centerZ) > RESAMPLE_DISTANCE) {
      this.beginResample(px, pz)
    }

    // 按时间节流而不是按帧：帧率掉到 30 时底图不该跟着慢一半
    if (this.scanning) {
      this.scanAccum += dt
      const steps = Math.floor(this.scanAccum / SCAN_INTERVAL)
      if (steps > 0) {
        this.scanAccum -= steps * SCAN_INTERVAL
        this.scanRows(terrain, steps * ROWS_PER_FRAME)
      }
    }

    this.draw(markers)
  }

  private beginResample(cx: number, cz: number): void {
    this.centerX = cx
    this.centerZ = cz
    this.scanRow = 0
    this.scanning = true
  }

  /** 一次只扫几行，避免一次性四千次噪声查询造成的掉帧 */
  private scanRows(terrain: Heightfield, rows: number): void {
    const half = this.range / 2
    const step = this.range / RESOLUTION

    for (let n = 0; n < rows; n++) {
      const row = this.scanRow
      const wz = this.centerZ - half + (row + 0.5) * step

      for (let col = 0; col < RESOLUTION; col++) {
        const wx = this.centerX - half + (col + 0.5) * step
        const h = terrain.height(wx, wz)
        const idx = (row * RESOLUTION + col) * 4
        this.colorForHeight(h, this.terrainPixels, idx)
      }

      this.scanRow++
      if (this.scanRow >= RESOLUTION) {
        this.scanning = false
        this.scanRow = 0
        break
      }
    }
  }

  /**
   * 高度 → 地貌色。刻意用与 3D 场景一致的配色规则，
   * 这样地图上看到的颜色和实地看到的是对得上的。
   */
  private colorForHeight(h: number, out: Uint8ClampedArray, idx: number): void {
    colorForHeight(h, out, idx)
  }

  private draw(markers: MinimapMarkers): void {
    drawMap(this.ctx, {
      size: this.pixelSize,
      range: this.range,
      centerX: this.centerX + this.viewOffsetX,
      centerZ: this.centerZ + this.viewOffsetZ,
      terrainPixels: this.terrainPixels,
      resolution: RESOLUTION,
      markers,
      hasTerrain: !this.scanning || this.scanRow > 0,
      markerScale: 1,
      pins: this.pins,
      playerCentered: this.viewOffsetX === 0 && this.viewOffsetZ === 0,
    })
  }

  dispose(): void {
    this.canvas.remove()
  }
}

/**
 * 高度 → 地貌色。与 3D 场景用同一套配色规则，地图上的颜色和实地能对上。
 * 独立导出是为了让大地图复用同一套配色，不至于两张图颜色不一致。
 */
export function colorForHeight(h: number, out: Uint8ClampedArray, idx: number): void {
  const rel = h - WATER_LEVEL
  let r: number
  let g: number
  let b: number

  if (rel < 0) {
    // 水：越深越暗
    const depth = Math.min(1, -rel / 20)
    r = 40 - depth * 20
    g = 90 - depth * 45
    b = 130 - depth * 55
  } else if (rel < 4) {
    r = 214; g = 203; b = 160 // 沙滩
  } else if (rel < 34) {
    // 草地：从浅绿到深绿
    const t = Math.min(1, (rel - 4) / 30)
    r = 111 - t * 40
    g = 154 - t * 32
    b = 74 - t * 22
  } else if (rel < 52) {
    r = 122; g = 114; b = 104 // 岩石
  } else {
    r = 232; g = 238; b = 242 // 雪
  }

  out[idx] = r
  out[idx + 1] = g
  out[idx + 2] = b
  out[idx + 3] = 255
}

export interface MapDrawOptions {
  /** 画布边长（CSS 像素） */
  size: number
  /** 覆盖的世界范围（米） */
  range: number
  centerX: number
  centerZ: number
  terrainPixels: Uint8ClampedArray
  /** 底图的分辨率（方形边长） */
  resolution: number
  markers: MinimapMarkers
  /** 底图是否已就绪，未就绪时只画标记 */
  hasTerrain: boolean
  /** 标记的尺寸倍率：大地图上要画得更大 */
  markerScale: number
  /** 玩家自打的标记 */
  pins?: ReadonlyArray<{ x: number; z: number }>
  /** 视野中心是否就是玩家所在，false 时画一圈提示"正在查看别处" */
  playerCentered?: boolean
}

/**
 * 把地图画到任意 2D 上下文。小地图与大地图共用这一份实现——
 * 两处各写一套迟早会出现"同一片湖在两张图上颜色不一样"的问题。
 */
export function drawMap(ctx: CanvasRenderingContext2D, opts: MapDrawOptions): void {
  const { size, range, centerX, centerZ, resolution, markers, markerScale } = opts
  const half = range / 2

  ctx.clearRect(0, 0, size, size)

  if (opts.hasTerrain) {
    const off = document.createElement('canvas')
    off.width = resolution
    off.height = resolution
    const offCtx = off.getContext('2d')
    if (offCtx) {
      // 用 createImageData + set 而不是 new ImageData(data,...)：
      // 后者的类型要求 ArrayBuffer，而我们持有的是泛型的 Uint8ClampedArray
      const img = offCtx.createImageData(resolution, resolution)
      img.data.set(opts.terrainPixels)
      offCtx.putImageData(img, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(off, 0, 0, size, size)
    }
  }

  // 正在查看别处时描一圈，提醒玩家"这不是你所在的位置"
  if (opts.playerCentered === false) {
    ctx.strokeStyle = 'rgba(255,190,120,0.75)'
    ctx.lineWidth = 2.5
    ctx.strokeRect(1.25, 1.25, size - 2.5, size - 2.5)
  }

  const scale = size / range
  const toScreen = (wx: number, wz: number): [number, number] => [
    (wx - (centerX - half)) * scale,
    (wz - (centerZ - half)) * scale,
  ]

  // 冰面
  if (markers.ice.length > 0) {
    ctx.fillStyle = 'rgba(190,228,242,0.85)'
    for (let i = 0; i < markers.ice.length; i += 2) {
      const [x, y] = toScreen(markers.ice[i], markers.ice[i + 1])
      const s = 1.5 * markerScale
      ctx.fillRect(x - s, y - s, s * 2, s * 2)
    }
  }

  // 火
  if (markers.fires.length > 0) {
    ctx.fillStyle = 'rgba(255,150,40,0.95)'
    for (let i = 0; i < markers.fires.length; i += 2) {
      const [x, y] = toScreen(markers.fires[i], markers.fires[i + 1])
      ctx.beginPath()
      ctx.arc(x, y, 2.2 * markerScale, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // 敌人
  ctx.fillStyle = '#e8544a'
  for (const e of markers.enemies) {
    const [x, y] = toScreen(e.x, e.z)
    ctx.beginPath()
    ctx.arc(x, y, 2.6 * markerScale, 0, Math.PI * 2)
    ctx.fill()
  }

  // 神庙：小三角塔形。没通关的是青色（还等着你去试炼），
  // 通关后转成沉下来的金色——地图上也读得出"这里毕业了"
  if (markers.shrines) {
    for (const s of markers.shrines) {
      const [sx, sy] = toScreen(s.x, s.z)
      if (sx < -12 || sx > size + 12 || sy < -12 || sy > size + 12) continue
      const r = 3.4 * markerScale
      ctx.save()
      ctx.translate(sx, sy)
      ctx.fillStyle = s.cleared ? 'rgba(240,200,90,0.85)' : 'rgba(120,220,235,0.95)'
      ctx.strokeStyle = 'rgba(8,20,28,0.85)'
      ctx.lineWidth = 1.1 * markerScale
      ctx.beginPath()
      ctx.moveTo(0, -r)
      ctx.lineTo(r * 0.86, r * 0.7)
      ctx.lineTo(-r * 0.86, r * 0.7)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  // 任务目标：金色菱形。它是玩家唯一需要主动去找的东西，所以要画得
  // 比敌人标记更显眼；出了地图范围就贴边，指出该往哪个方向走
  if (markers.questTarget) {
    const [tx, ty] = toScreen(markers.questTarget.x, markers.questTarget.z)
    const inside = tx >= 0 && tx <= size && ty >= 0 && ty <= size
    let mx = tx
    let my = ty
    if (!inside) {
      const dx = tx - size / 2
      const dy = ty - size / 2
      const len = Math.hypot(dx, dy) || 1
      const limit = size / 2 - 13
      mx = size / 2 + (dx / len) * limit
      my = size / 2 + (dy / len) * limit
    }

    const r = (inside ? 4.4 : 3.8) * markerScale
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(Math.PI / 4)
    ctx.fillStyle = '#f5c542'
    ctx.strokeStyle = 'rgba(46,32,0,0.92)'
    ctx.lineWidth = 1.3 * markerScale
    ctx.beginPath()
    ctx.rect(-r, -r, r * 2, r * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  // 玩家自打的标记：小旗子形状，和任务目标的金色菱形区分开
  if (opts.pins && opts.pins.length > 0) {
    ctx.strokeStyle = '#ff9a5c'
    ctx.fillStyle = 'rgba(255,154,92,0.9)'
    ctx.lineWidth = 1.3 * markerScale
    for (const pin of opts.pins) {
      const [gx, gy] = toScreen(pin.x, pin.z)
      if (gx < -20 || gx > size + 20 || gy < -20 || gy > size + 20) continue
      // 一条竖杆 + 一面三角旗
      ctx.beginPath()
      ctx.moveTo(gx, gy)
      ctx.lineTo(gx, gy - 8 * markerScale)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(gx, gy - 8 * markerScale)
      ctx.lineTo(gx + 6 * markerScale, gy - 5.5 * markerScale)
      ctx.lineTo(gx, gy - 3 * markerScale)
      ctx.closePath()
      ctx.fill()
    }
  }

  // 玩家：指向朝向的三角
  const [px, py] = toScreen(markers.playerPos.x, markers.playerPos.z)
  ctx.save()
  ctx.translate(px, py)
  // 屏幕 y 轴向下、世界 z 轴也朝"下"，所以取负角即可对齐
  // 箭头默认画成朝上（顶点在 -y）。要让它指向角色的实际朝向，转角是 π - yaw
  // 而不是 -yaw——差这一个 π，箭头会一直指着身后。
  //
  // 推一遍：画布 x 向右、y 向下，而世界 +X 映射到画布 +x、世界 +Z 映射到
  // 画布 +y。角色朝向由 yaw = atan2(dx, dz) 定义，所以画布里的方向向量是
  // (sin yaw, cos yaw)。把 (0,-1) 顺时针转 θ 得到 (sinθ, -cosθ)，令它等于
  // (sin yaw, cos yaw) 就解出 θ = π - yaw。
  ctx.rotate(Math.PI - markers.playerYaw)
  ctx.scale(markerScale, markerScale)
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = 'rgba(0,0,0,0.65)'
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(0, -6.5)
  ctx.lineTo(4.5, 5)
  ctx.lineTo(0, 2.6)
  ctx.lineTo(-4.5, 5)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}
