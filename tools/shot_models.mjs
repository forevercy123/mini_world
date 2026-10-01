/** 依次加载多个角色模型，从同一机位各拍一张，用来横向对比选型 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const models = process.argv.slice(2)
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3200)
  await handle.evalJs(`(() => {
    const tp = window.__thirdPerson;
    tp.config.distance = 2.6; tp.pitch = 0.06; tp.yaw = Math.PI;
    window.__world.dayCycle.config.autoAdvance = false;
  })()`)
  await sleep(600)
  for (const m of models) {
    const ok = await handle.evalJs(`window.__setAvatar('/assets/models/${m}.glb')`)
    if (!ok?.value) { console.log(`✗ ${m} 加载失败`); continue }
    await sleep(1400)
    const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
    const data = shot?.result?.data
    if (data) { writeFileSync(`/tmp/model_${m}.png`, Buffer.from(data, 'base64')); console.log(`✓ ${m}`) }
  }
} finally { await handle.close() }
