/**
 * 冰面渲染。
 *
 * 每格一块薄板，用 InstancedMesh 画——一整片冰只需要一个 draw call。
 * 材质带自发光：冰面浮在水位高度、下方是深色的水，只有靠自发光才能
 * 一眼看出"这里可以站人"，否则会和水面糊在一起。
 */

import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'
import { CELL_SIZE, ElementGrid } from '../world/elementGrid.ts'
import { WATER_LEVEL } from '../terrain/heightfield.ts'

const MAX_ICE_CELLS = 600

export class IceRenderer {
  readonly group = new Object3D()

  private readonly mesh: InstancedMesh
  private readonly material: MeshLambertMaterial
  private readonly geometry: BoxGeometry
  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly quaternion = new Quaternion()
  private readonly scale = new Vector3(1, 1, 1)
  private readonly color = new Color()

  constructor() {
    // 略小于格子边长，格与格之间留一道细缝，冰面看起来是一块块结成的
    this.geometry = new BoxGeometry(CELL_SIZE * 0.96, 0.14, CELL_SIZE * 0.96)

    this.material = new MeshLambertMaterial({
      color: 0xbfe4f2,
      transparent: true,
      opacity: 0.88,
      flatShading: true,
    })
    // 淡蓝自发光：让冰面在深色水面上依然清晰可辨
    this.material.emissive = new Color(0x4a7f9c).multiplyScalar(0.5)

    this.mesh = new InstancedMesh(this.geometry, this.material, MAX_ICE_CELLS)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    this.mesh.receiveShadow = true
    this.group.add(this.mesh)
    this.group.name = 'ice'
  }

  update(cells: Iterable<number>): void {
    let i = 0
    for (const key of cells) {
      if (i >= MAX_ICE_CELLS) break
      const { x, z } = ElementGrid.keyToWorld(key)

      this.position.set(x, WATER_LEVEL - 0.02, z)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.mesh.setMatrixAt(i, this.matrix)

      // 每块冰的色调略有差异，整片冰面不会像一块塑料板
      const tint = 0.9 + ((key * 2654435761) % 1000) / 1000 * 0.16
      this.color.setRGB(tint * 0.94, tint * 0.98, tint)
      this.mesh.setColorAt(i, this.color)

      i++
    }

    this.mesh.count = i
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.dispose()
  }
}
