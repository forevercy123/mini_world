/** 把相机摆到指定世界坐标拍地标 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const out = process.argv[2]
const x = Number(process.argv[3]), z = Number(process.argv[4])
const dist = Number(process.argv[5] || 18), height = Number(process.argv[6] || 7)
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10' })
try {
  await waitForBoot(handle.evalJs); await sleep(4500)
  await handle.evalJs(`(() => {
    window.__setMode(false);
    const w = window.__world, hf = w.heightfield;
    const y = hf.height(${x}, ${z});
    w.camera.position.set(${x} + ${dist} * 0.7, y + ${height}, ${z} + ${dist} * 0.7);
    w.camera.lookAt(${x}, y + 3, ${z});
  })()`)
  await sleep(3000)
  const s = await handle.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(s.result.data, 'base64'))
  console.log('已保存', out)
} finally { await handle.close() }
