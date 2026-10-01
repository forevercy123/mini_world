import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&cb=' + Date.now() })
try {
  await waitForBoot(handle.evalJs); await sleep(4500)

  const r = await handle.evalJs(`(() => {
    const w = window.__world, hf = w.heightfield, og = w.obstacles;
    const p = window.__player.position;
    let best = null, bestD = Infinity;
    for (const list of og.cells.values()) {
      for (const o of list) {
        if (o.topY === undefined) continue;
        const rise = o.topY - hf.height(o.x, o.z);
        if (rise < 0.7 || rise > 1.8) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < bestD) { bestD = d; best = o; }
      }
    }
    if (!best) return { err: '没有合适的石头' };
    window.__setMode(true);
    // 直接放到石头正上方 2.5 米，让它自由落体
    const pl = window.__player;
    pl.position.set(best.x, best.topY + 2.5, best.z);
    pl.velocity.set(0, 0, 0);
    pl.teleportTo(best.x, best.z, hf);
    pl.position.y = best.topY + 2.5;
    const tp = window.__thirdPerson;
    tp.config.distance = 5.5; tp.pitch = 0.22; tp.yaw = 2.2;
    tp.snapTo(pl.position);
    return { x: +best.x.toFixed(1), z: +best.z.toFixed(1), topY: +best.topY.toFixed(2),
             ground: +hf.height(best.x, best.z).toFixed(2), dist: +bestD.toFixed(1) };
  })()`)
  const v = r.value ?? r
  if (v.err) { console.log('❌', v.err); process.exit(1) }
  console.log(`石头 (${v.x}, ${v.z})  地面 ${v.ground}  顶面 ${v.topY}  距原点 ${v.dist}m`)

  await sleep(2200)
  const after = await handle.evalJs(`(() => {
    const p = window.__player;
    return { y: +p.position.y.toFixed(3), grounded: p.grounded, state: p.state };
  })()`)
  const a = after.value ?? after
  console.log(`落地后: y=${a.y}  grounded=${a.grounded}  state=${a.state}`)
  const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/stand3.png', Buffer.from(shot.result.data, 'base64'))

  const onTop = Math.abs(a.y - v.topY) < 0.25 && a.grounded
  if (!onTop) process.exitCode = 1
  console.log(onTop ? '✅ 可站立表面全部检查通过' : `❌ 没站上去（差 ${(a.y - v.topY).toFixed(2)} 米）`)
} finally { await handle.close() }
