/**
 * 火焰与烟雾的渲染。
 *
 * 用 InstancedMesh 而不是粒子系统：燃烧的格子数量可能有几十到几百个，
 * 每个格子一个实例，整片火场只占两个 draw call（火焰 + 烟雾）。粒子系统
 * 在这里既没必要也更贵——火焰的形状是风格化的锥体，不需要逐粒子模拟。
 *
 * 火焰本身是自发光物体，用 MeshBasicMaterial 而不是 Lambert：
 * 让它们参与场景光照会让火焰在阴影里变暗，那不符合直觉。
 */

import {
  Color,
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { FireCell } from '../world/elementGrid.ts'

const MAX_FIRES = 320

export class FireRenderer {
  readonly group = new Object3D()

  private readonly flames: InstancedMesh
  private readonly smoke: InstancedMesh
  private readonly flameMaterial: MeshBasicMaterial
  private readonly smokeMaterial: MeshBasicMaterial
  private readonly flameGeometry: ConeGeometry
  private readonly smokeGeometry: ConeGeometry

  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly quaternion = new Quaternion()
  private readonly scale = new Vector3()
  private readonly color = new Color()
  private readonly up = new Vector3(0, 1, 0)

  constructor() {
    this.flameGeometry = new ConeGeometry(0.85, 2.0, 5)
    // 锥体默认以原点为中心，抬高半高让底边贴地
    this.flameGeometry.translate(0, 1.0, 0)

    this.smokeGeometry = new ConeGeometry(1.15, 3.2, 5)
    this.smokeGeometry.translate(0, 1.6, 0)

    this.flameMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
    this.smokeMaterial = new MeshBasicMaterial({
      color: 0x3a3430,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    })

    // 注意：toneMapped = false 在本项目里**不起作用**——渲染走的是
    // EffectComposer，OutputPass 是全屏后处理，它无从知道哪个物体该跳过
    // 色调映射。所以火焰改用 HDR 颜色（分量 > 1）来对抗 ACES 的去饱和，
    // 亮度超过 bloom 阈值后还会自带光晕，正好是火该有的样子。
    // 这一行保留着：将来若关掉 bloom 直接渲染，它能立刻生效。
    this.flameMaterial.toneMapped = false

    this.flames = new InstancedMesh(this.flameGeometry, this.flameMaterial, MAX_FIRES)
    this.smoke = new InstancedMesh(this.smokeGeometry, this.smokeMaterial, MAX_FIRES)
    for (const mesh of [this.flames, this.smoke]) {
      // 火焰跟着相机满天飞，剔除计算没意义，而且包围球不好维护
      mesh.frustumCulled = false
      mesh.renderOrder = 6
      this.group.add(mesh)
    }
    // 烟在火的上层，避免被火焰完全遮住
    this.smoke.renderOrder = 7
    this.group.name = 'fire'
  }

  /**
   * @param cells 当前燃烧的格子
   * @param elapsed 累计时间，用于脉动
   * @param groundHeightAt 取地面高度，火焰要贴着地形
   */
  update(
    cells: Iterable<FireCell>,
    elapsed: number,
    groundHeightAt: (x: number, z: number) => number,
  ): void {
    let i = 0
    for (const cell of cells) {
      if (i >= MAX_FIRES) break

      const groundY = groundHeightAt(cell.x, cell.z)

      // 燃料越少火越小，快烧完时会自然萎下去
      const fuelFactor = Math.min(1, cell.fuel * 2.2)
      // 每个格子用坐标做相位偏移，整片火场不会整齐划一地一起闪
      const phase = cell.x * 0.7 + cell.z * 0.53
      const pulse = 0.86 + Math.sin(elapsed * 8.5 + phase) * 0.14
      const flicker = 0.92 + Math.sin(elapsed * 21 + phase * 1.7) * 0.08

      const s = fuelFactor * pulse
      this.position.set(cell.x, groundY, cell.z)
      this.quaternion.setFromAxisAngle(this.up, cell.age * 2.2 + phase)
      this.scale.set(s * flicker, s * 1.45 * flicker, s * flicker)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.flames.setMatrixAt(i, this.matrix)

      // HDR 颜色：红色分量给到 3 以上，ACES 压缩后仍是饱和的橙而不是米黄。
      // 绿色分量必须压得很低，否则一过色调映射就偏黄。
      // 新烧起来的偏亮橙，快烧完的转暗红。
      this.color.setRGB(
        0.7 + fuelFactor * 3.1,
        0.12 + fuelFactor * 0.5,
        0.05 + fuelFactor * 0.06,
      )
      this.flames.setColorAt(i, this.color)

      // 烟雾：更大、更慢、随时间上升并淡出
      const rise = Math.min(1.6, cell.age * 0.5)
      this.scale.set(s * 1.15, s * 1.1, s * 1.15)
      this.position.set(cell.x, groundY + rise, cell.z)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.smoke.setMatrixAt(i, this.matrix)

      i++
    }

    this.flames.count = i
    this.smoke.count = i
    this.flames.instanceMatrix.needsUpdate = true
    this.smoke.instanceMatrix.needsUpdate = true
    if (this.flames.instanceColor) this.flames.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.flameGeometry.dispose()
    this.smokeGeometry.dispose()
    this.flameMaterial.dispose()
    this.smokeMaterial.dispose()
    this.flames.dispose()
    this.smoke.dispose()
  }
}
