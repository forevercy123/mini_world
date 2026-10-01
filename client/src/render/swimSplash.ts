/**
 * 游泳时水面上的涟漪。
 *
 * 没有这一层，游泳看起来像"一个模型贴着水面平移"——水面本身没有反应，
 * 玩家读不出自己在划水。真实的青蛙泳会有明显的蹬水动作，水面上是一圈圈
 * 向外扩的波。
 *
 * 实现上是一小撮循环复用的圆环：预分配、轮流启用，绝不在运行时 new。
 * 涟漪本身很轻（每个环就几十个三角形），贵的是每帧新建对象。
 */

import { Group, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, Vector3 } from 'three'

/** 同时存在的涟漪上限 */
const RING_COUNT = 8
/** 划水时多久冒一圈（秒） */
const EMIT_INTERVAL = 0.26
/** 一圈涟漪从出现到散尽的时间 */
const RING_LIFE = 1.1
/** 起始与终止半径（米） */
const RING_FROM = 0.28
const RING_TO = 1.05

interface Ring {
  mesh: Mesh
  material: MeshBasicMaterial
  /** 剩余寿命，<= 0 表示空闲 */
  life: number
}

export class SwimSplash {
  readonly group = new Group()

  private readonly rings: Ring[] = []
  /** 摊平到水面上：环的几何默认在 XY 平面，要转到 XZ */
  private readonly flat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)
  private emitTimer = 0
  private cursor = 0

  constructor() {
    this.group.name = 'swim-splash'
    // 环很薄，用同一份几何体；每个环单独一份材质是为了单独控制透明度
    const geometry = new RingGeometry(0.82, 1, 20, 1)
    for (let i = 0; i < RING_COUNT; i++) {
      const material = new MeshBasicMaterial({
        color: 0xdff2ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const mesh = new Mesh(geometry, material)
      mesh.quaternion.copy(this.flat)
      mesh.visible = false
      mesh.renderOrder = 5
      this.group.add(mesh)
      this.rings.push({ mesh, material, life: 0 })
    }
  }

  /**
   * @param swimming 玩家是否在游泳
   * @param speed 水平速度，决定冒泡的密度
   */
  update(dt: number, swimming: boolean, x: number, y: number, z: number, speed: number): void {
    for (const ring of this.rings) {
      if (ring.life <= 0) continue
      ring.life -= dt
      if (ring.life <= 0) {
        ring.mesh.visible = false
        continue
      }
      // 归一化进度：0 刚出现，1 散尽
      const t = 1 - ring.life / RING_LIFE
      const radius = RING_FROM + (RING_TO - RING_FROM) * t
      ring.mesh.scale.setScalar(radius)
      // 先亮起再淡出，比线性淡出更有"涌出来"的感觉
      ring.material.opacity = Math.sin(Math.min(1, t * 1.6) * Math.PI) * 0.34
    }

    if (!swimming) {
      this.emitTimer = 0
      return
    }

    // 划得越快，涟漪冒得越密
    this.emitTimer -= dt * (0.7 + Math.min(1.4, speed * 0.35))
    if (this.emitTimer > 0) return
    this.emitTimer = EMIT_INTERVAL

    // 轮流取一个空闲的环；全都在用就跳过这一次
    for (let i = 0; i < RING_COUNT; i++) {
      const ring = this.rings[(this.cursor + i) % RING_COUNT]
      if (ring.life > 0) continue
      this.cursor = (this.cursor + i + 1) % RING_COUNT
      ring.life = RING_LIFE
      ring.mesh.visible = true
      ring.mesh.position.set(x, y + 0.06, z)
      ring.mesh.scale.setScalar(RING_FROM)
      ring.material.opacity = 0
      break
    }
  }

  /** 上岸时立刻收干净，免得涟漪留在草上 */
  clear(): void {
    for (const ring of this.rings) {
      ring.life = 0
      ring.mesh.visible = false
    }
  }

  dispose(): void {
    for (const ring of this.rings) {
      ring.material.dispose()
    }
    this.rings[0]?.mesh.geometry.dispose()
    this.rings.length = 0
  }
}
