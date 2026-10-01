/** 拍攻击挥舞瞬间的特写：给一把单手剑，触发攻击，在命中帧附近连拍 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&fresh=1' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3000)
  // 给一把旅人之剑并装上
  await handle.evalJs(`(() => {
    window.__weaponBag.add('sword1h')
    window.__syncWeapon()
    const tp = window.__thirdPerson
    tp.config.distance = 3.0
    tp.pitch = 0.1
    tp.yaw = 0.15
  })()`)
  await sleep(400)
  // 触发攻击（走正常输入通道）
  await handle.evalJs(`window.__input.attackQueued = true`)
  // 命中帧约 0.27s（58% 处动画最好看），连拍三张
  for (const [i, wait] of [[1, 150], [2, 120], [3, 150]].entries()) {
    await sleep(wait[1])
    const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`/tmp/swing_${wait[0]}.png`, Buffer.from(shot.result.data, 'base64'))
  }
  console.log('已拍 3 张')
} finally { await handle.close() }
