/** 野兽和篝火的近景检查：把相机拉到它们旁边拍 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&fresh=1' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3500)

  // 找一只鹿和一堆篝火的位置
  const res = await handle.evalJs(`(() => {
    const animals = window.__wildlife.alive
    const deer = animals.find(a => a.def.kind === 'deer') ?? animals[0]
    const fire = window.__campfires.fires[1] ?? window.__campfires.fires[0]
    return {
      deer: deer ? [deer.position.x, deer.position.y, deer.position.z] : null,
      fire: fire ? [fire.position.x, fire.position.y, fire.position.z] : null,
    }
  })()`)
  const loc = res.value
  console.log('位置:', JSON.stringify(loc))

  // 拍鹿：相机放到它旁边 4 米
  if (loc.deer) {
    await handle.evalJs(`(() => {
      const [x, y, z] = ${JSON.stringify(loc.deer)}
      const cam = window.__world.camera
      window.__setMode(false)
      cam.position.set(x + 3.5, y + 1.6, z + 2.5)
      cam.lookAt(x, y + 0.8, z)
      window.__pipeline.render()
    })()`)
    await sleep(300)
    const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync('/tmp/beast.png', Buffer.from(shot.result.data, 'base64'))
  }

  // 拍篝火
  if (loc.fire) {
    await handle.evalJs(`(() => {
      const [x, y, z] = ${JSON.stringify(loc.fire)}
      const cam = window.__world.camera
      cam.position.set(x + 3.2, y + 2.0, z + 2.8)
      cam.lookAt(x, y + 0.5, z)
      window.__pipeline.render()
    })()`)
    await sleep(300)
    const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync('/tmp/campfire.png', Buffer.from(shot.result.data, 'base64'))
  }
  console.log('已拍 beast.png 与 campfire.png')
} finally { await handle.close() }
