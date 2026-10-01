#!/usr/bin/env node
/**
 * 采样地形高度分布，用来决定水面高度该设在哪里。
 *
 * 水位是个"一锤子买卖"的参数：设高了半个世界被淹，设低了完全看不到水。
 * 拍脑袋定不如量一下——这里在全球随机采样上万个点看分位数。
 *
 * 用法：node tools/sample_terrain.mjs [采样半径]
 */

import { launch, waitForBoot } from './lib/cdp.mjs'

const url = process.argv[3] || 'http://localhost:5173/'
const radius = Number(process.argv[2] || 1600)

const handle = await launch({ url })

try {
  console.log('等待页面初始化…')
  await waitForBoot(handle.evalJs)

  const res = await handle.evalJs(`(() => {
    const hf = window.__world.heightfield;
    const N = 12000;
    const samples = new Float64Array(N);
    const slopes = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * ${radius};
      const z = (Math.random() - 0.5) * ${radius};
      samples[i] = hf.height(x, z);
      slopes[i] = hf.slope(x, z);
    }
    samples.sort();
    slopes.sort();
    const q = (arr, p) => arr[Math.min(N - 1, Math.max(0, Math.floor(N * p)))];
    let sum = 0;
    for (let i = 0; i < N; i++) sum += samples[i];

    // 坡度统计。hf.slope() 返回 1-cos(坡角)，行走上限 48° 对应 0.331：
    // 超过这个值的面积占比，就是"攀爬机制有多少用武之地"
    let climbable = 0, verySteep = 0;
    for (let i = 0; i < N; i++) {
      if (slopes[i] > 0.331) climbable++;
      if (slopes[i] > 0.55) verySteep++;
    }

    return {
      count: N,
      min: samples[0], max: samples[N - 1], mean: sum / N,
      p01: q(samples,0.01), p05: q(samples,0.05), p10: q(samples,0.10),
      p25: q(samples,0.25), p50: q(samples,0.50), p75: q(samples,0.75),
      p90: q(samples,0.90), p95: q(samples,0.95), p99: q(samples,0.99),
      slopeP50: q(slopes,0.50), slopeP90: q(slopes,0.90),
      slopeP99: q(slopes,0.99), slopeMax: slopes[N-1],
      climbableRatio: climbable / N, verySteepRatio: verySteep / N,
    };
  })()`)

  const s = res.value
  if (!s) {
    console.error('采样失败:', JSON.stringify(res))
    process.exit(1)
  }

  const f = (v) => v.toFixed(1).padStart(7)
  console.log('')
  console.log(`地形高度分布（${s.count} 个随机采样点，半径 ${radius} 米范围内）`)
  console.log('─'.repeat(48))
  console.log(`  最低      ${f(s.min)}`)
  console.log(`  p01       ${f(s.p01)}`)
  console.log(`  p05       ${f(s.p05)}`)
  console.log(`  p10       ${f(s.p10)}`)
  console.log(`  p25       ${f(s.p25)}`)
  console.log(`  中位数    ${f(s.p50)}`)
  console.log(`  p75       ${f(s.p75)}`)
  console.log(`  p90       ${f(s.p90)}`)
  console.log(`  p95       ${f(s.p95)}`)
  console.log(`  p99       ${f(s.p99)}`)
  console.log(`  最高      ${f(s.max)}`)
  console.log(`  平均      ${f(s.mean)}`)
  console.log('')

  // 不同水位下被淹没的面积占比——这才是决定水位的关键数字
  console.log('若水位设为以下高度，被水覆盖的地面占比：')
  console.log('─'.repeat(48))
  for (const level of [2, 4, 6, 8, 10, 12, 15, 18, 22]) {
    const ratio = countBelow(s, level) / s.count
    const bar = '█'.repeat(Math.round(ratio * 40))
    console.log(`  ${String(level).padStart(3)} 米   ${(ratio * 100).toFixed(1).padStart(5)}%  ${bar}`)
  }
  console.log('')
  console.log('坡度分布（1-cos(坡角)，行走上限 48° = 0.331，超过就需要攀爬）')
  console.log('─'.repeat(48))
  console.log(`  中位数    ${s.slopeP50.toFixed(3)}`)
  console.log(`  p90       ${s.slopeP90.toFixed(3)}`)
  console.log(`  p99       ${s.slopeP99.toFixed(3)}`)
  console.log(`  最陡      ${s.slopeMax.toFixed(3)}`)
  console.log('')
  console.log(`  陡到需要攀爬的面积占比   ${(s.climbableRatio * 100).toFixed(1)}%`)
  console.log(`  陡到近乎垂直的占比       ${(s.verySteepRatio * 100).toFixed(1)}%`)
  console.log('')
  if (s.climbableRatio < 0.01) {
    console.log('  ⚠️ 需要攀爬的地形不足 1%，攀爬机制几乎用不上——地形太平滑了。')
  } else if (s.climbableRatio > 0.25) {
    console.log('  ⚠️ 需要攀爬的地形超过 25%，探索会被频繁打断，考虑放缓地形。')
  } else {
    console.log('  ✅ 攀爬占比合理：既能用上，又不会到处受阻。')
  }
  console.log('')
  console.log('提示：出生点会优先选在草原带（16–45 米），水位应明显低于它。')
} finally {
  handle.close()
}

/**
 * 用已有的分位数做线性插值估算「低于某高度」的比例。
 * 采样数据本身没传回来（太大），所以这里用分位数近似，够用了。
 */
function countBelow(s, level) {
  const marks = [
    [s.min, 0], [s.p01, 0.01], [s.p05, 0.05], [s.p10, 0.1],
    [s.p25, 0.25], [s.p50, 0.5], [s.p75, 0.75], [s.p90, 0.9],
    [s.p95, 0.95], [s.p99, 0.99], [s.max, 1],
  ]
  if (level <= marks[0][0]) return 0
  if (level >= marks[marks.length - 1][0]) return s.count
  for (let i = 1; i < marks.length; i++) {
    const [h1, r1] = marks[i - 1]
    const [h2, r2] = marks[i]
    if (level <= h2) {
      const t = h2 === h1 ? 0 : (level - h1) / (h2 - h1)
      return (r1 + (r2 - r1) * t) * s.count
    }
  }
  return s.count
}
