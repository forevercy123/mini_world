#!/usr/bin/env node
/** 风元素验证：吹散火焰 + 滑翔助力 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '    ' + d : ''}`) }

const h = await launch({ url: `http://localhost:4173/?freeze=1&hour=10&cb=${Date.now()}` })
try {
  await waitForBoot(h.evalJs); await sleep(3000)
  await h.evalJs(`window.__setMode(true)`)
  await sleep(500)

  // 1. 点火，然后起风灭火
  const r1 = await h.evalJs(`(() => {
    const p = window.__player, el = window.__elements, hf = window.__world.heightfield;
    el.reset();
    // 在玩家周围点几处火
    let lit = 0;
    for (let i = 0; i < 6; i++) {
      const a = (i/6)*Math.PI*2;
      if (el.ignite(p.position.x + Math.cos(a)*4, p.position.z + Math.sin(a)*4, hf)) lit++;
    }
    p.stamina.refill();
    return { lit, burning: el.burningCount };
  })()`)
  const v1 = r1.value ?? r1
  check('先点起几处火', v1.burning > 0, `${v1.burning} 处`)

  const r2 = await h.evalJs(`(() => {
    const el = window.__elements, p = window.__player;
    const before = el.burningCount, st0 = p.stamina.current;
    window.__gust();
    return { before, after: el.burningCount, st0, st1: p.stamina.current };
  })()`)
  const v2 = r2.value ?? r2
  check('起风消耗体力', v2.st1 < v2.st0, `${v2.st0.toFixed(0)} → ${v2.st1.toFixed(0)}`)
  check('风吹散了火焰', v2.after < v2.before, `${v2.before} → ${v2.after} 处`)

  // 2. 滑翔时顺风加速
  const r3 = await h.evalJs(`(() => {
    const p = window.__player, hf = window.__world.heightfield;
    p.stamina.refill();
    p.position.y = hf.height(p.position.x, p.position.z) + 30;
    p.state = 'glide';
    p.velocity.set(0, -2, 0);
    p.yaw = 0;   // 朝 +Z
    const vz0 = p.velocity.z;
    window.__gust();
    return { vz0, vz1: p.velocity.z };
  })()`)
  const v3 = r3.value ?? r3
  check('滑翔时顺风加速', v3.vz1 > v3.vz0, `vz ${v3.vz0.toFixed(2)} → ${v3.vz1.toFixed(2)}`)
} finally { await h.close() }

console.log('')
const failed = results.filter((x) => !x).length
if (failed === 0) console.log(`✅ 风元素全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed} 项未通过`); process.exitCode = 1 }
