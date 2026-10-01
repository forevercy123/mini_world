/** 对着树走，看是否开始攀爬并上升 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&cb=' + Date.now() })
try {
  await waitForBoot(handle.evalJs); await sleep(4000)
  const r = await handle.evalJs(`(() => {
    const w = window.__world, hf = w.heightfield, og = w.obstacles;
    const p = window.__player;
    // 找一根高大的可攀爬柱子（树干，没有 topY），且周围平坦
    let best = null, bestH = 0;
    for (const list of og.cells.values()) {
      for (const o of list) {
        if (!o.climbable || o.topY !== undefined) continue;
        if ((o.climbHeight ?? 0) < 4) continue;
        const g = hf.height(o.x, o.z);
        if (hf.slope(o.x, o.z) > 0.2) continue;
        if ((o.climbHeight ?? 0) > bestH) { bestH = o.climbHeight; best = o; }
      }
    }
    if (!best) return { err: '没找到合适的树' };
    window.__setMode(true);
    // 站到它旁边 1.2 米，面朝它
    const ang = 0.7;
    const px = best.x - Math.cos(ang) * (best.radius + 1.1);
    const pz = best.z - Math.sin(ang) * (best.radius + 1.1);
    p.teleportTo(px, pz, hf);
    p.yaw = Math.atan2(best.x - px, best.z - pz);
    const tp = window.__thirdPerson;
    tp.config.distance = 6.5; tp.pitch = 0.18; tp.yaw = p.yaw + Math.PI;
    tp.snapTo(p.position);
    return { r: +best.radius.toFixed(2), climbH: +(best.climbHeight ?? 0).toFixed(1),
             ground: +hf.height(px, pz).toFixed(2), startY: +p.position.y.toFixed(2) };
  })()`)
  const v = r.value ?? r
  if (v.err) { console.log('❌', v.err); process.exit(1) }
  console.log(`树：半径 ${v.r}m  可爬高 ${v.climbH}m  地面 ${v.ground}  起始 y=${v.startY}`)

  await sleep(600)
  // 按住 W 朝树走
  await handle.keyDown('KeyW', 'w', 87)
  const ys = []
  for (let i = 0; i < 10; i++) {
    await sleep(420)
    const st = await handle.evalJs(`({ y: +window.__player.position.y.toFixed(2), state: window.__player.state })`)
    const s = st.value ?? st
    ys.push(s)
    if (i === 5) {
      const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync('/tmp/climb.png', Buffer.from(shot.result.data, 'base64'))
    }
  }
  await handle.keyUp('KeyW', 'w', 87)
  console.log('过程:', ys.map(s => `${s.state}@${s.y}`).join(' → '))
  const maxY = Math.max(...ys.map(s => s.y))
  const climbed = maxY - v.startY
  const sawClimb = ys.some(s => s.state === 'climb')
  const ok = sawClimb && climbed > 1.2
  if (!ok) process.exitCode = 1
  console.log(
    ok
      ? `✅ 攀爬全部检查通过（进入攀爬状态，升高 ${climbed.toFixed(2)} 米）`
      : `❌ 没爬上去（进入过攀爬=${sawClimb}，升高 ${climbed.toFixed(2)} 米）`,
  )
} finally { await handle.close() }
