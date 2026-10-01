/**
 * 敌人头顶的小血条。
 *
 * 塞尔达的做法有两个要点，这里都照搬了：
 *
 * 1. **只在挨打之后才出现**，几秒后自己淡出。全程挂着一排血条会把
 *    草原变成血条展览，也失去"这一下打得疼不疼"的即时反馈。
 * 2. **血条永远正面朝向镜头**。它是 UI 不是场景物件，跟着敌人转身的话
 *    侧着看就成了一条线。
 *
 * 用两个面片（底色 + 前景）而不是 Sprite：Sprite 在 EffectComposer 下
 * 的色调映射行为不好控制，而面片可以走和其他物体一样的管线。颜色给到
 * HDR 量级，免得被 ACES 压成灰扑扑的暗红。
 */

import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Camera,
} from 'three'

/** 血条尺寸（米） */
const BAR_WIDTH = 0.86
const BAR_HEIGHT = 0.1
/** 挂在敌人头顶多高 */
const BAR_OFFSET_Y = 2.05
/** 挨打后显示多久（秒） */
const SHOW_DURATION = 3.2

export class EnemyHealthBar {
  readonly object = new Group()

  private readonly fill: Mesh
  private readonly fillMaterial: MeshBasicMaterial
  private readonly back: Mesh
  private readonly backMaterial: MeshBasicMaterial
  private ratio = 1
  private showTimer = 0

  constructor() {
    // 底色：深到接近黑，才能衬出前景的红
    const backGeo = new BoxGeometry(BAR_WIDTH, BAR_HEIGHT, 0.02)
    this.backMaterial = new MeshBasicMaterial({ color: new Color(0.05, 0.03, 0.03) })
    this.back = new Mesh(backGeo, this.backMaterial)
    this.back.renderOrder = 10

    // 前景：用 HDR 红（>1）对抗 ACES 的去饱和，暗处也能一眼看清
    const fillGeo = new BoxGeometry(BAR_WIDTH, BAR_HEIGHT * 0.72, 0.02)
    this.fillMaterial = new MeshBasicMaterial({ color: new Color(2.6, 0.35, 0.3) })
    this.fill = new Mesh(fillGeo, this.fillMaterial)
    this.fill.renderOrder = 11

    // 前景靠缩放表达比例。几何体原点在中心，所以要从中心往左缩，
    // 否则血条会从两头一起缩短
    this.fill.position.z = 0.015

    this.object.add(this.back, this.fill)
    this.object.position.y = BAR_OFFSET_Y
    this.object.visible = false
  }

  /** 血条在父节点里的挂点高度，外部据此摆放 */
  static get offsetY(): number {
    return BAR_OFFSET_Y
  }

  setRatio(ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio))
    this.ratio = r
    this.fill.scale.x = Math.max(0.001, r)
    // 缩放后要重新贴合左端：-半宽 × (1 - 比例)
    this.fill.position.x = (-BAR_WIDTH * (1 - r)) / 2
    // 残血时颜色更红更亮，给一点"快死了"的提示
    const heat = 1 - r
    this.fillMaterial.color.setRGB(2.2 + heat * 1.4, 0.32 - heat * 0.18, 0.28 - heat * 0.16)
  }

  get currentRatio(): number {
    return this.ratio
  }

  /** 挨打时调用：重新显示并计时 */
  flash(): void {
    this.showTimer = SHOW_DURATION
    this.object.visible = true
  }

  /** 立刻隐藏（比如敌人还没被发现时） */
  hide(): void {
    this.showTimer = 0
    this.object.visible = false
  }

  update(dt: number, camera: Camera): void {
    if (this.showTimer > 0) {
      this.showTimer -= dt
      if (this.showTimer <= 0) {
        this.object.visible = false
        return
      }
      // 最后 0.8 秒淡出，比"啪"地消失柔和
      const fade = Math.min(1, this.showTimer / 0.8)
      this.backMaterial.opacity = fade
      this.fillMaterial.opacity = fade
      this.backMaterial.transparent = fade < 1
      this.fillMaterial.transparent = fade < 1
    }

    if (!this.object.visible) return

    // 始终面向镜头。血条是 UI，不该跟着敌人转身
    this.object.quaternion.copy(camera.quaternion)
  }

  dispose(): void {
    this.back.geometry.dispose()
    this.fill.geometry.dispose()
    this.backMaterial.dispose()
    this.fillMaterial.dispose()
  }
}
