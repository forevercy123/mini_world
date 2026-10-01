/** 角色特写：从指定方位绕角色拍，用来检查建模与配色 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const out = process.argv[2] || '/tmp/hero.png'
const yaw = process.argv[3] || '3.14'
const dist = process.argv[4] || '2.6'
const pitch = process.argv[5] || '0.08'

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3200)
  await handle.evalJs(`(() => {
    const tp = window.__thirdPerson;
    tp.config.distance = ${dist};
    tp.pitch = ${pitch};
    tp.yaw = ${yaw};
    // 冻结时间，避免光照变化影响对比
    window.__world.dayCycle.config.autoAdvance = false;
  })()`)
  await sleep(900)
  const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.result?.data
  if (!data) { console.error('截图失败'); process.exit(1) }
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log('已保存', out)
} finally { await handle.close() }
