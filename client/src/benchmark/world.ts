/**
 * 阶段 0 的测试世界：地形 + 植被 + 天空 + 光照。
 *
 * 这里刻意采用「最终会用的方案」而非占位实现——只有测真实的场景，
 * 得到的帧率数字才有决策价值。
 */

import {
  DirectionalLight,
  Fog,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three'
import { SkyDome } from '../render/skyDome.ts'
import { WaterSurface } from '../render/waterSurface.ts'
import { DayCycle } from '../world/dayCycle.ts'
import { GrassField } from '../world/grassField.ts'
import { ObstacleGrid } from '../physics/obstacleGrid.ts'
import { Heightfield, WATER_LEVEL } from '../terrain/heightfield.ts'
import type { RoadNetwork } from '../world/roads.ts'
import { ChunkedTerrain, type TerrainConfig } from '../terrain/chunkedTerrain.ts'
import { VegetationField } from '../world/vegetation.ts'
import type { NatureGeometry } from '../world/natureLibrary.ts'

export interface WorldOptions {
  viewDistance: number
  treeCount: number
  shadows: boolean
  shadowMapSize: number
  /**
   * 道路网络。必须在构造时传入：散布是同步生成的，树一旦落地就
   * 不会再挪——后补的道路会从树林里穿过去
   */
  roads?: RoadNetwork
}

/**
 * 阴影相机覆盖半径（米）。越小阴影越精细、阴影 pass 的三角形越少，
 * 但远处会没有阴影。
 *
 * 从 70 收到 55：换成外部素材后散布物密度提高，阴影 pass 要重画一遍
 * 半径内所有植被，占了总三角形的大头。110 米见方的覆盖在第三人称视距
 * 下已经够用——再远的树本来就只有几个像素，有没有影子看不出来。
 */
export const SHADOW_RADIUS = 55

/**
 * 天空球半径（米）。必须小于相机远平面，否则整个天空会被裁掉；
 * 同时天空球每帧跟随相机，玩家走多远都在球心，所以半径取中等值即可。
 */
const SKY_RADIUS = 780

export class BenchmarkWorld {
  readonly scene = new Scene()
  readonly camera: PerspectiveCamera
  readonly heightfield: Heightfield
  readonly terrain: ChunkedTerrain
  readonly dayCycle: DayCycle
  readonly water: WaterSurface
  readonly grass: GrassField
  /** 树干等障碍物的空间索引，供角色碰撞使用 */
  readonly obstacles = new ObstacleGrid()
  vegetation: VegetationField

  private readonly sun: DirectionalLight
  private readonly moon: DirectionalLight
  private readonly hemi: HemisphereLight
  private readonly sky: SkyDome
  private readonly sunOffset = new Vector3()
  private readonly options: WorldOptions
  /**
   * 外部素材库（Kenney Nature Kit 等）。必须由调用方先异步加载好再传进来：
   * 散布是同步生成的，拿到空映射就只能长出一片光地。
   */
  private readonly nature: ReadonlyMap<string, NatureGeometry>
  /** 累计运行时间，供波浪等周期动画使用 */
  private elapsed = 0

  constructor(options: WorldOptions, nature?: ReadonlyMap<string, NatureGeometry>) {
    this.options = options
    this.nature = nature ?? new Map()

    // 昼夜循环是光照中枢，必须先于天空与灯光建好——它们都从它取初始值
    this.dayCycle = new DayCycle()

    const camera = setupSun()
    this.camera = camera

    this.sky = new SkyDome(SKY_RADIUS, this.dayCycle.sunDirection)
    this.scene.add(this.sky.mesh)
    // 雾色直接取天空的地平线色，远景地形才能无缝融进天空里
    this.scene.fog = new Fog(this.sky.horizonColor.clone(), 200, 320)

    this.sun = new DirectionalLight(0xfff1dd, 2.7)
    this.sun.castShadow = options.shadows
    this.sun.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize)
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 700
    this.sun.shadow.camera.left = -SHADOW_RADIUS
    this.sun.shadow.camera.right = SHADOW_RADIUS
    this.sun.shadow.camera.top = SHADOW_RADIUS
    this.sun.shadow.camera.bottom = -SHADOW_RADIUS
    // 阴影贴图在斜坡上容易产生条纹，用 normalBias 比 bias 更有效
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.6
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    // 月光：夜间专用的方向光。只用半球光做夜景会得到一团灰——半球光色
    // 和草地顶点色都是暗色，相乘后趋近于黑，没有明暗对比就读不出地形轮廓。
    // 不投影，省掉一张阴影贴图的开销。
    this.moon = new DirectionalLight(0x9db8e8, 0)
    this.moon.target = this.sun.target // 与太阳共用注视点，位置由 update 驱动
    this.scene.add(this.moon)

    // 半球光提供廉价的环境照明，是风格化渲染性价比最高的光源
    this.hemi = new HemisphereLight(0xa9c9e8, 0x50483c, 1.15)
    this.scene.add(this.hemi)

    this.heightfield = new Heightfield({ seed: 20260930 })

    const terrainConfig: Partial<TerrainConfig> = { viewDistance: options.viewDistance }
    this.terrain = new ChunkedTerrain(this.heightfield, terrainConfig, options.roads)
    this.scene.add(this.terrain.group)

    this.vegetation = new VegetationField(
      this.heightfield,
      this.nature,
      { count: options.treeCount, groupSize: 128 },
      {},
      this.obstacles,
      options.roads,
    )
    this.vegetation.setShadows(options.shadows)
    this.scene.add(this.vegetation.group)

    // 草叶层：地面不能只有顶点色，否则走上去像踩在刷了绿漆的地毯上
    this.grass = new GrassField(this.heightfield, {}, options.roads)
    this.scene.add(this.grass.group)

    // 水面高度取自地形的水位常量，两边必须用同一个值
    this.water = new WaterSurface({ level: WATER_LEVEL })
    this.scene.add(this.water.mesh)

    this.setViewDistance(options.viewDistance)
    // 用当前时刻初始化一遍光照，避免第一帧还是默认的白色顶光
    this.applyDayCycle()
  }

  /**
   * 视距变化时同步调整雾与相机远平面。
   *
   * 远平面有个下限 SKY_RADIUS：天空是半径固定的球体，若远平面小于它，
   * 整个天空会被裁掉（画面背景变纯黑）。同时视距上限也要留出余量，
   * 否则玩家把视距拉满时又会出现同样的裁剪。
   */
  setViewDistance(distance: number): void {
    this.options.viewDistance = distance
    this.terrain.config.viewDistance = distance
    this.camera.far = Math.max(distance * 1.6, SKY_RADIUS + 200)
    this.camera.updateProjectionMatrix()

    // 雾只需在视距边缘把地形收住；起雾太早会让中景糊成一片灰白，
    // 开阔感全失。62% 起雾、98% 全雾是观感与遮挡的平衡点。
    if (this.scene.fog instanceof Fog) {
      this.scene.fog.near = distance * 0.62
      this.scene.fog.far = distance * 0.98
    }
  }

  setShadows(enabled: boolean): void {
    this.options.shadows = enabled
    this.sun.castShadow = enabled
    this.vegetation.setShadows(enabled)
  }

  setShadowMapSize(size: number): void {
    this.options.shadowMapSize = size
    this.sun.shadow.mapSize.set(size, size)
    // 改尺寸后必须丢弃旧贴图，否则不会生效
    this.sun.shadow.map?.dispose()
    this.sun.shadow.map = null
  }

  /** 重建植被（数量变化时调用，代价约几十毫秒） */
  setTreeCount(count: number): void {
    this.scene.remove(this.vegetation.group)
    this.vegetation.dispose()
    this.vegetation = new VegetationField(this.heightfield, this.nature, { count, groupSize: 128 }, {}, this.obstacles, this.options.roads)
    this.vegetation.setShadows(this.options.shadows)
    this.scene.add(this.vegetation.group)
    this.options.treeCount = count
  }

  /**
   * @param focus 地形流式加载与阴影的跟随中心。游玩时传角色位置，
   *   巡检/飞行时传相机位置——用相机位置会在镜头拉远时让加载中心偏移。
   */
  update(dt: number, focus?: Vector3): void {
    const center = focus ?? this.camera.position
    this.elapsed += dt

    // 每帧最多重建 2 块：块重建约 10ms，给多了会在相机移动时掉帧
    this.terrain.update(center, dt, 2)

    // 天空球与水面的水平位置都跟着相机（它们远大于视距，只需保证不出边界）
    this.sky.mesh.position.copy(this.camera.position)
    this.water.update(this.elapsed, this.camera.position)
    this.vegetation.update(dt)
    // 草场按块跟随关注点铺开，走到哪里脚下都有草
    this.grass.update(dt, center)

    // 时间推进后重新解算光照：太阳、天光、天空、雾、水面反射色一起更新
    this.dayCycle.update(dt)
    this.applyDayCycle()

    // 阴影相机跟随关注点；跟随的是水平位置而非朝向，
    // 避免抬头低头时阴影范围跟着乱晃
    this.sun.target.position.set(center.x, 0, center.z)
    this.sun.position.copy(this.sun.target.position).add(this.sunOffset)
    this.moon.position.copy(this.sun.target.position).addScaledVector(this.dayCycle.moonDirection, 320)
    this.sun.target.updateMatrixWorld()
  }

  /**
   * 把昼夜循环解算出的光照应用到场景各部件的唯一出口。
   * 集中在一处，才不会出现"天是橙的、雾是蓝的、水面反射是白的"这种穿帮。
   */
  private applyDayCycle(): void {
    const dc = this.dayCycle

    this.sun.color.copy(dc.sunColor)
    this.sun.intensity = dc.sunIntensity
    this.sunOffset.copy(dc.sunDirection).multiplyScalar(320)
    // 夜里太阳强度归零，再渲染一遍阴影贴图纯属浪费
    this.sun.castShadow = this.options.shadows && dc.sunIntensity > 0.05

    this.moon.intensity = dc.moonIntensity

    this.hemi.color.copy(dc.hemiSky)
    this.hemi.groundColor.copy(dc.hemiGround)
    this.hemi.intensity = dc.hemiIntensity

    this.sky.setZenithColor(dc.skyZenith)
    this.sky.setHorizonColor(dc.skyHorizon)
    this.sky.setSunDirection(dc.sunDirection)
    // 日盘在太阳沉到地平线以下时淡出，否则夜里天上会挂着一个假太阳
    const sunDisc = Math.min(1, Math.max(0, (dc.elevation + 0.02) / 0.1))
    this.sky.setSunColor(dc.sunColor, sunDisc)
    this.sky.setNight(Math.min(1, Math.max(0, (0.06 - dc.elevation) / 0.16)))

    if (this.scene.fog instanceof Fog) {
      this.scene.fog.color.copy(dc.skyHorizon)
    }

    this.water.setSunDirection(dc.sunDirection)
    this.water.setSkyColor(dc.skyHorizon)
    this.water.setSunColor(dc.sunColor)
  }

  dispose(): void {
    this.terrain.dispose()
    this.vegetation.dispose()
    this.sky.dispose()
    this.water.dispose()
  }
}

function setupSun(): PerspectiveCamera {
  const camera = new PerspectiveCamera(62, 1, 0.5, 1200)
  camera.position.set(0, 30, 0)
  return camera
}

/** 供 renderer 初始化时统一设置阴影类型 */
export const SHADOW_TYPE = PCFSoftShadowMap
