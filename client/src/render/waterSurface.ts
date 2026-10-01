/**
 * 水面。
 *
 * 设计取舍：**不做几何起伏，只在片元着色器里解析计算波浪法线**。
 *
 * 理由是性价比——真实顶点位移需要极密的网格才能在大范围上看出效果
 * （水面要覆盖整个视距，3000 米见方的平面即使 256 段也是每格 12 米，
 * 波浪会被采样成锯齿）。而法线扰动在每像素上算，看距离远近都能得到
 * 细腻的水面质感，代价只是几条 sin/cos。用一个只有两个三角形的大平面
 * 就能撑起整片水域。
 *
 * 反射同样走近似：用天空色按菲涅尔混合，而不是真实的实时反射（那需要
 * 再渲染一遍场景，在 M1 上不可接受）。
 */

import { Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'

export interface WaterConfig {
  /** 水面尺寸（米）。必须显著大于最大视距，否则会看到水面的边缘 */
  size: number
  /** 水面高度（米），通常取 heightfield 的 WATER_LEVEL */
  level: number
  /** 深水色 */
  deepColor: Color
  /** 浅水色 */
  shallowColor: Color
  /** 波浪法线强度，越大水面越"皱" */
  waveScale: number
  /** 波浪演进速度 */
  waveSpeed: number
  /** 基础不透明度（正对镜头时），掠射角会自动提高到接近不透明 */
  opacity: number
}

export const DEFAULT_WATER_CONFIG: WaterConfig = {
  size: 3000,
  level: 11,
  deepColor: new Color(0x0e4055),
  shallowColor: new Color(0x2f96ad),
  // 方向波的梯度量级在 0.05 上下，要放大到这个倍数才能得到 10°–20° 的
  // 法线倾角——低于 2 时水面看起来是一块平板，几乎没有波浪感
  waveScale: 4.2,
  waveSpeed: 1.0,
  // 从 0.72 降到 0.38。
  //
  // 0.72 的 alpha 意味着只有不到三成的光能透过水面——人潜下去之后从岸上
  // 看过去就是一团模糊的深色影子，根本认不出那是角色。风格化的水不需要
  // 物理正确的吸收，它要的是"一眼看得到水下有什么"。
  opacity: 0.38,
}

const VERTEX_SHADER = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSkyColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uWaveScale;
uniform float uWaveSpeed;
uniform float uOpacity;

varying vec3 vWorldPos;

/**
 * 单个方向波对 x/z 的偏导：方向 × cos(相位) × 振幅 × 频率。
 * 方向波比"沿 x 轴 + 沿 z 轴"的正弦叠加自然得多——后者会在两个波的
 * 干涉处形成规则条纹，看起来像涟漪布纹而不是水。
 */
vec2 waveGrad(vec2 p, vec2 dir, float freq, float amp, float t) {
  vec2 d = normalize(dir);
  float phase = dot(p, d) * freq + t * (0.8 + freq * 0.9);
  return d * (amp * freq * cos(phase));
}

/**
 * @param detail 高频细纹的强度 0–1。远处必须衰减到 0：
 *   高频波在远距离上采样不足会产生摩尔纹（画面里会看到一片条纹）。
 */
vec2 waveSlope(vec2 p, float t, float detail) {
  // 低频涌浪，构成水面的大起伏，远近都要
  vec2 s = vec2(0.0);
  s += waveGrad(p, vec2(1.0, 0.16), 0.085, 0.55, t);
  s += waveGrad(p, vec2(-0.62, 0.78), 0.120, 0.42, t);
  s += waveGrad(p, vec2(0.28, -1.0), 0.165, 0.30, t);

  if (detail > 0.01) {
    vec2 h = vec2(0.0);
    h += waveGrad(p, vec2(0.88, 0.47), 0.42, 0.16, t);
    h += waveGrad(p, vec2(-0.33, -0.94), 0.68, 0.11, t);
    s += h * detail;
  }

  return s;
}

void main() {
  vec2 p = vWorldPos.xz;
  float t = uTime * uWaveSpeed;

  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);

  // 远处水面趋于平静，同时把法线扰动整体收窄，兼顾观感与抗锯齿
  float detail = 1.0 - smoothstep(60.0, 320.0, dist);
  float flatten = mix(0.22, 1.0, 1.0 - smoothstep(120.0, 700.0, dist));

  vec2 slope = waveSlope(p, t, detail) * flatten;
  vec3 normal = normalize(vec3(-slope.x * uWaveScale, 1.0, -slope.y * uWaveScale));

  vec3 viewDir = normalize(toCam);

  // 菲涅尔：视线越贴近水面，反射越强。
  // 幂次从 3.2 提到 4.5、上限压到 0.78，是为了别让水面在掠射角下彻底
  // 变成天空的镜子——物理上那是对的，但整片水会灰成一块钢板，
  // 失去青蓝色调。风格化渲染在这里要的是"好看的水"，不是正确的菲涅尔。
  float fresnel = pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), 4.5);
  fresnel = mix(0.02, 0.78, fresnel);

  vec3 base = mix(uDeepColor, uShallowColor, 0.4);
  // 反射色里掺一点水色，避免地平线附近的浅色天空把水面染成灰白
  vec3 reflectCol = mix(uSkyColor, uShallowColor * 1.25, 0.3);
  vec3 col = mix(base, reflectCol, fresnel);

  // 阳光在水面的镜面高光。指数给高、强度压低，得到清爽的碎光；
  // 否则在掠射角下会连成一大片白斑，把波浪纹理全盖住
  vec3 sunDir = normalize(uSunDir);
  vec3 halfVec = normalize(viewDir + sunDir);
  float spec = pow(max(dot(normal, halfVec), 0.0), 220.0);
  col += uSunColor * spec * 0.85;

  // 掠射角的上限从 0.98 收到 0.72。原来那条 mix(uOpacity, 0.98, fresnel)
  // 意味着只要视线斜一点水面就变成一堵不透明的墙，游泳时几乎看不到人
  gl_FragColor = vec4(col, mix(uOpacity, 0.72, fresnel));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export class WaterSurface {
  readonly mesh: Mesh
  readonly config: WaterConfig
  private readonly material: ShaderMaterial

  constructor(config: Partial<WaterConfig> = {}) {
    this.config = { ...DEFAULT_WATER_CONFIG, ...config }

    // 两个三角形就够了：起伏全在法线里，不需要几何密度
    const geometry = new PlaneGeometry(this.config.size, this.config.size, 1, 1)
    geometry.rotateX(-Math.PI / 2)

    this.material = new ShaderMaterial({
      uniforms: {
        uDeepColor: { value: this.config.deepColor.clone() },
        uShallowColor: { value: this.config.shallowColor.clone() },
        uSkyColor: { value: new Color(0x9fc4e8) },
        uSunColor: { value: new Color(0xfff1dd) },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uTime: { value: 0 },
        uWaveScale: { value: this.config.waveScale },
        uWaveSpeed: { value: this.config.waveSpeed },
        uOpacity: { value: this.config.opacity },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      // 透明物体写深度会遮挡其后渲染的透明物体；水面自身只需深度测试
      depthWrite: false,
      // 从水下往上看也要有水，否则潜下去会看到天空的破洞
      side: DoubleSide,
    })

    this.mesh = new Mesh(geometry, this.material)
    this.mesh.position.y = this.config.level
    this.mesh.name = 'water'
    this.mesh.renderOrder = 5
    // 水面总是覆盖整个视野，剔除计算没有意义（而且它会跟着相机走）
    this.mesh.frustumCulled = false
  }

  /** 每帧调用：推进波浪并让平面跟着相机走 */
  update(elapsed: number, cameraPos: Vector3): void {
    this.material.uniforms.uTime.value = elapsed
    this.mesh.position.x = cameraPos.x
    this.mesh.position.z = cameraPos.z
  }

  setSunDirection(dir: Vector3): void {
    ;(this.material.uniforms.uSunDir.value as Vector3).copy(dir)
  }

  /** 反射色跟随天空，黄昏时水面才会跟着变暖 */
  setSkyColor(color: Color): void {
    ;(this.material.uniforms.uSkyColor.value as Color).copy(color)
  }

  setSunColor(color: Color): void {
    ;(this.material.uniforms.uSunColor.value as Color).copy(color)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
