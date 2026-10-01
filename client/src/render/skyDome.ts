/**
 * 风格化渐变天空。
 *
 * 为什么不用 three 自带的物理天空（Sky addon）：
 * 物理散射的辐射亮度远高于 Lambert 材质的地形（差一个数量级以上），
 * 两者无法共用同一个曝光值——迁就地形则天空过曝成灰白，迁就天空则
 * 地面全黑。风格化渲染需要的本来就是可控的美术调色，而不是物理正确，
 * 所以这里直接写一个亮度落在 0–1 区间的渐变球。
 *
 * 颜色全部走线性空间，末尾用 three 的 tonemapping/colorspace chunk 收尾，
 * 保证在「直接渲染」和「经过 EffectComposer」两条路径下颜色一致。
 */

import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three'

export interface SkyPalette {
  /** 天顶色 */
  zenith: Color
  /** 地平线色，应与场景雾色接近，远处地形才能自然融进天空 */
  horizon: Color
  /** 太阳与光晕的颜色 */
  sunColor: Color
  /** 日盘锐利度：指数越大日盘越小越锐 */
  sunSharpness: number
  /** 光晕强度 */
  sunGlow: number
}

export const DEFAULT_SKY_PALETTE: SkyPalette = {
  zenith: new Color(0x2f6fbf),
  horizon: new Color(0xbcd8ee),
  sunColor: new Color(0xffedd0),
  sunSharpness: 320,
  sunGlow: 0.3,
}

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;
void main() {
  // 球体局部坐标即方向（天空球跟随相机且不旋转，缩放不影响方向）
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSharpness;
uniform float uSunGlow;
uniform float uNight;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

/**
 * 星星：把方向向量量化成格子，每个格子按哈希决定是否放一颗星。
 * 比维护一张星空贴图省得多，也不会因为贴图分辨率出现重复图案。
 */
float starField(vec3 dir) {
  vec3 cell = floor(dir * 190.0);
  float h = hash13(cell);
  // 约 0.9% 的格子有星星；再稀就只剩零星几个点，撑不起星空
  if (h < 0.991) return 0.0;

  // 星点限制在格子中心附近，否则会被拉成方块
  vec3 offset = fract(dir * 190.0) - 0.5;
  float d = length(offset);
  float twinkle = 0.72 + 0.28 * hash13(cell + 7.13);
  return smoothstep(0.34, 0.0, d) * twinkle;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // 地平线 → 天顶的垂直渐变。幂次让颜色变化集中在地平线附近，
  // 天顶保持大片纯色，这是风格化天空最常见的观感。
  float up = pow(smoothstep(0.0, 0.62, h), 0.72);
  vec3 col = mix(uHorizon, uZenith, up);

  // 星星只在地平线以上、且夜色足够深时出现
  if (uNight > 0.01) {
    float stars = starField(dir) * smoothstep(-0.02, 0.22, h) * uNight;
    col += vec3(stars) * 1.6;
  }

  // 地平线以下渐变到较暗的地面色，避免相机俯视时出现刺眼的分界线
  float down = smoothstep(0.0, -0.3, h);
  col = mix(col, uHorizon * 0.45, down);

  // 太阳：一个锐利的日盘加一圈柔和光晕
  float sun = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sun, uSunSharpness) * 1.35;
  col += uSunColor * pow(sun, 5.0) * uSunGlow;

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export class SkyDome {
  readonly mesh: Mesh
  private readonly material: ShaderMaterial

  constructor(radius: number, sunDirection: Vector3, palette: SkyPalette = DEFAULT_SKY_PALETTE) {
    const geometry = new SphereGeometry(1, 32, 20)
    this.material = new ShaderMaterial({
      uniforms: {
        uZenith: { value: palette.zenith.clone() },
        uHorizon: { value: palette.horizon.clone() },
        uSunColor: { value: palette.sunColor.clone() },
        uSunDir: { value: sunDirection.clone() },
        uSunSharpness: { value: palette.sunSharpness },
        uSunGlow: { value: palette.sunGlow },
        uNight: { value: 0 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: BackSide,
      depthWrite: false,
      // 天空不受雾影响：它是背景，被雾染白就失去远景观感了
      fog: false,
    })

    this.mesh = new Mesh(geometry, this.material)
    this.mesh.scale.setScalar(radius)
    this.mesh.name = 'sky'
    // 天空永远在最底层，先画它可以让后续绘制省掉与被遮挡像素的着色开销
    this.mesh.renderOrder = -1000
    this.mesh.frustumCulled = false
  }

  setSunDirection(direction: Vector3): void {
    ;(this.material.uniforms.uSunDir.value as Vector3).copy(direction)
  }

  setZenithColor(color: Color): void {
    ;(this.material.uniforms.uZenith.value as Color).copy(color)
  }

  setHorizonColor(color: Color): void {
    ;(this.material.uniforms.uHorizon.value as Color).copy(color)
  }

  /** 日盘与光晕的颜色。夜晚应压暗，否则地平线下会出现一个假太阳 */
  setSunColor(color: Color, intensity: number): void {
    ;(this.material.uniforms.uSunColor.value as Color).copy(color).multiplyScalar(intensity)
  }

  /** 夜色浓度 0–1，驱动星星的可见度 */
  setNight(amount: number): void {
    this.material.uniforms.uNight.value = amount
  }

  /** 取地平线色，用于同步雾色，保证远景与天空无缝衔接 */
  get horizonColor(): Color {
    return this.material.uniforms.uHorizon.value as Color
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
