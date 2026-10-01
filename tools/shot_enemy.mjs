/** 敌人特写：把相机怼到最近的敌人面前，用来检查建模与体型 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const out = process.argv[2] || '/tmp/enemy.png'
const dist = process.argv[3] || '3.2'
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10' })
try {
  await waitForBoot(handle.evalJs); await sleep(3500)
  const r = await handle.evalJs(`(() => {
    const e = window.__enemies.alive[0];
    if (!e) return { err: 'no enemy' };
    const p = e.position;
    window.__setMode(false);
    const w = window.__world;
    // 顺便把玩家搬到旁边做身高参照
    window.__thirdPerson.enabled = false;
    window.__player.teleportTo(p.x + 1.5, p.z, w.heightfield);
    w.camera.position.set(p.x + 0.75, p.y + 1.3, p.z + ${dist});
    w.camera.lookAt(p.x + 0.75, p.y + 0.75, p.z);
    return { scale: +e.object.children[0].children[0].scale.x.toFixed(3) };
  })()`)
  const v = r.value ?? r
  if (v.err) { console.log(v.err); process.exit(1) }
  console.log('骷髅 scale =', v.scale)
  await sleep(1600)
  const s = await handle.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(s.result.data, 'base64'))
  console.log('已保存', out)
} finally { await handle.close() }
