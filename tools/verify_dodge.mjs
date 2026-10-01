#!/usr/bin/env node
/** 闪避验证：位移、无敌帧、体力消耗、空中不可用 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '    ' + d : ''}`) }

const h = await launch({ url: `http://localhost:4173/?freeze=1&hour=10&cb=${Date.now()}` })
try {
  await waitForBoot(h.evalJs); await sleep(3000)
  await h.evalJs(`window.__setMode(true)`)
  await sleep(500)

  // 先挪到一片空地上。闪避一次要滑 3.7 米，起点附近随便一棵树、一块石头
  // 都会把它拦下来——测出来的是"撞了东西"，不是闪避距离
  const spot = await h.evalJs(`(() => {
    const w = window.__world, hf = w.heightfield, og = w.obstacles;
    const p = window.__player;
    for (let r = 40; r < 260; r += 10) {
      for (let a = 0; a < 24; a++) {
        const ang = a/24*Math.PI*2;
        const x = Math.cos(ang)*r, z = Math.sin(ang)*r;
        if (hf.slope(x, z) > 0.15) continue;
        let clear = true;
        for (const list of og.cells.values()) for (const o of list) {
          if (Math.hypot(o.x - x, o.z - z) < 9) { clear = false; break; }
        }
        if (clear) { p.teleportTo(x, z, hf); return { x: +x.toFixed(0), z: +z.toFixed(0) }; }
      }
    }
    return null;
  })()`)
  const sp = spot.value ?? spot
  check('找到一片空地用于测闪避', sp !== null, sp ? `(${sp.x}, ${sp.z})` : '没找到')
  await sleep(600)

  // 1. 地上闪避：有位移、消耗体力
  const r1 = await h.evalJs(`(() => {
    const p = window.__player;
    const x0 = p.position.x, z0 = p.position.z;
    const st0 = p.stamina.current;
    const ok = p.dodge(1, 0);
    return { ok, x0, z0, st0, dodging: p.isDodging, invuln: p.isInvulnerable };
  })()`)
  const v1 = r1.value ?? r1
  check('闪避被接受', v1.ok === true)
  check('进入闪避状态', v1.dodging === true)
  check('获得了无敌帧', v1.invuln === true)

  await sleep(600)
  const r2 = await h.evalJs(`(() => {
    const p = window.__player;
    return { x: p.position.x, z: p.position.z, st: p.stamina.current, dodging: p.isDodging };
  })()`)
  const v2 = r2.value ?? r2
  const moved = Math.hypot(v2.x - v1.x0, v2.z - v1.z0)
  check('闪避产生了位移', moved > 2, `移动了 ${moved.toFixed(2)} 米`)
  check('消耗了体力', v2.st < v1.st0, `${v1.st0.toFixed(0)} → ${v2.st.toFixed(0)}`)
  check('闪避已结束', v2.dodging === false)

  // 2. 无敌帧内不受伤
  const r3 = await h.evalJs(`(() => {
    const p = window.__player;
    p.stamina.refill();
    p.dodge(-1, 0);
    const hp0 = window.__playerHealth.current;
    // 闪避刚开始，模拟一次伤害
    window.__damagePlayer ? window.__damagePlayer(1, p.position) : null;
    return { hp0, hp1: window.__playerHealth.current, invuln: p.isInvulnerable };
  })()`)
  const v3 = r3.value ?? r3
  check('闪避无敌帧内免疫伤害', v3.hp0 === v3.hp1, `血量 ${v3.hp0} → ${v3.hp1}`)

  // 3. 空中不能闪
  const r4 = await h.evalJs(`(() => {
    const p = window.__player;
    p.stamina.refill();
    p.position.y += 8;      // 抬到空中
    p.grounded = false;
    const ok = p.dodge(1, 0);
    return { ok, grounded: p.grounded };
  })()`)
  check('空中不能闪避', (r4.value ?? r4).ok === false)
} finally { await h.close() }

console.log('')
const failed = results.filter((x) => !x).length
if (failed === 0) console.log(`✅ 闪避全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed} 项未通过`); process.exitCode = 1 }
