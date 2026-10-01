/** 在几处典型地形拍近景，用来找穿模 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10' })
try {
  await waitForBoot(handle.evalJs); await sleep(4500)
  // 找几个有树、有坡度的点
  const spots = await handle.evalJs(`(() => {
    const hf = window.__world.heightfield;
    const out = [];
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + 0.6;
      const r = 45 + i * 25;
      out.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r });
    }
    return out.map(s => ({ x: s.x, z: s.z, y: hf.height(s.x, s.z), slope: +hf.slope(s.x, s.z).toFixed(3) }));
  })()`)
  const list = spots.value ?? spots
  await handle.evalJs('window.__setMode(false)')
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    await handle.evalJs(`(() => {
      const w = window.__world, hf = w.heightfield;
      const x = ${s.x}, z = ${s.z};
      const y = hf.height(x, z);
      w.camera.position.set(x + 9, y + 2.6, z + 9);
      w.camera.lookAt(x - 2, y + 1.2, z - 2);
    })()`)
    await sleep(1800)
    const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`/tmp/clip_${i}.png`, Buffer.from(shot.result.data, 'base64'))
    console.log(`点位 ${i}: (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) 坡度 ${s.slope}`)
  }
} finally { await handle.close() }
