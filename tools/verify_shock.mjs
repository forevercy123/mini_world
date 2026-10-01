#!/usr/bin/env node
/** 电击验证：水中的敌人被电到，岸上的不受影响；不在水里放不出电 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '    ' + d : ''}`) }

const h = await launch({ url: `http://localhost:4173/?freeze=1&hour=10&cb=${Date.now()}` })
try {
  await waitForBoot(h.evalJs); await sleep(3500)

  // 1. 岸上放不出电
  const dry = await h.evalJs(`(() => {
    const p = window.__player, hf = window.__world.heightfield;
    // 传送到一处高地（远离水）
    let spot = null;
    for (let r = 40; r < 260 && !spot; r += 12)
      for (let a = 0; a < 24; a++) {
        const ang = a/24*Math.PI*2, x = Math.cos(ang)*r, z = Math.sin(ang)*r;
        if (hf.height(x, z) > 40) { spot = { x, z }; break; }
      }
    p.teleportTo(spot.x, spot.z, hf);
    const before = window.__player.stamina.current;
    window.__discharge();
    return { before, after: window.__player.stamina.current };
  })()`)
  const d0 = dry.value ?? dry
  check('岸上放电不消耗体力（放不出来）', d0.before === d0.after, `${d0.before} → ${d0.after}`)

  // 2. 水里放电
  const wet = await h.evalJs(`(() => {
    const w = window.__world, hf = w.heightfield, WL = w.water.config.level;
    const p = window.__player;
    // 找一片开阔水域
    let spot = null;
    for (let r = 100; r < 900 && !spot; r += 20)
      for (let a = 0; a < 40; a++) {
        const ang = a/40*Math.PI*2, x = Math.cos(ang)*r, z = Math.sin(ang)*r;
        if (hf.height(x, z) < WL - 4) { spot = { x, z }; break; }
      }
    if (!spot) return { err: '找不到水' };
    p.teleportTo(spot.x, spot.z, hf);
    const before = window.__player.stamina.current;
    return { x: +spot.x.toFixed(0), z: +spot.z.toFixed(0), before };
  })()`)
  const w0 = wet.value ?? wet
  if (w0.err) { console.log('❌', w0.err); process.exit(1) }
  await sleep(1500)

  // 把两只敌人放到玩家附近：一只在水里，一只在岸上
  const setup = await h.evalJs(`(() => {
    const w = window.__world, hf = w.heightfield, WL = w.water.config.level;
    const p = window.__player, em = window.__enemies;
    const inW = em.alive[0], onLand = em.alive[1];
    if (!inW || !onLand) return { err: '敌人不够' };
    inW.position.set(p.position.x + 3, hf.height(p.position.x+3, p.position.z), p.position.z);
    inW.health.current = inW.health.max; inW.config.aggroRange = 0.01;
    // 找一处岸上位置（水位以上）
    let lx = p.position.x + 5, lz = p.position.z + 5;
    for (let r = 6; r < 60; r += 3) {
      for (let a = 0; a < 16; a++) {
        const ang = a/16*Math.PI*2;
        const cx = p.position.x + Math.cos(ang)*r, cz = p.position.z + Math.sin(ang)*r;
        if (hf.height(cx, cz) > WL + 1.5) { lx = cx; lz = cz; break; }
      }
      if (hf.height(lx, lz) > WL + 1.5) break;
    }
    onLand.position.set(lx, hf.height(lx, lz), lz);
    onLand.health.current = onLand.health.max; onLand.config.aggroRange = 0.01;
    return {
      inWaterY: +hf.height(inW.position.x, inW.position.z).toFixed(2),
      onLandY: +hf.height(lx, lz).toFixed(2),
      waterLevel: WL,
      inWaterHp: inW.health.current, onLandHp: onLand.health.current,
    };
  })()`)
  const s0 = setup.value ?? setup
  if (s0.err) { console.log('❌', s0.err); process.exit(1) }
  check('测试场地就绪', s0.inWaterY < s0.waterLevel && s0.onLandY > s0.waterLevel,
    `水中 y=${s0.inWaterY}，岸上 y=${s0.onLandY}，水位 ${s0.waterLevel}`)

  // 放电
  const fired = await h.evalJs(`(() => {
    const p = window.__player, em = window.__enemies;
    const before = window.__player.stamina.current;
    window.__discharge();
    return { before, after: window.__player.stamina.current,
             inWaterHp: em.alive[0].health.current, onLandHp: em.alive[1].health.current };
  })()`)
  const f0 = fired.value ?? fired
  check('水中放电消耗体力', f0.after < f0.before, `${f0.before} → ${f0.after}`)
  check('水中的敌人被电到', f0.inWaterHp < s0.inWaterHp, `血量 ${s0.inWaterHp} → ${f0.inWaterHp}`)
  check('岸上的敌人不受影响', f0.onLandHp === s0.onLandHp, `血量 ${f0.onLandHp}`)
} finally { await h.close() }

console.log('')
const failed = results.filter((x) => !x).length
if (failed === 0) console.log(`✅ 电元素全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed} 项未通过`); process.exitCode = 1 }
