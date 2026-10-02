/** 成品展示图：持剑砍骷髅的战斗瞬间 + 野猪近景 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&fresh=1' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3200)

  // ── 战斗画面：拿双手剑砍骷髅 ──
  await handle.evalJs(`(() => {
    window.__weaponBag.add('sword2h')
    window.__syncWeapon()
    const e = window.__enemies.alive.find(e => !e.health.isDead)
    window.__player.teleportTo(e.position.x - 1.8, e.position.z, window.__world.heightfield)
    window.__player.yaw = Math.PI / 2
    const tp = window.__thirdPerson
    tp.config.distance = 3.4
    tp.pitch = 0.14
    tp.yaw = 2.6
  })()`)
  await sleep(600)
  await handle.evalJs(`window.__input.attackQueued = true`)
  await sleep(380) // 挥砍中段
  const shot1 = await handle.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/combat_2h.png', Buffer.from(shot1.result.data, 'base64'))

  // ── 野猪近景 ──
  const res = await handle.evalJs(`(() => {
    const boar = window.__wildlife.alive.find(a => a.def.kind === 'boar')
    const rabbit = window.__wildlife.alive.find(a => a.def.kind === 'rabbit')
    return {
      boar: boar ? [boar.position.x, boar.position.y, boar.position.z] : null,
      rabbit: rabbit ? [rabbit.position.x, rabbit.position.y, rabbit.position.z] : null,
    }
  })()`)
  const loc = res.value
  if (loc.boar) {
    await handle.evalJs(`(() => {
      const [x, y, z] = ${JSON.stringify(loc.boar)}
      window.__setMode(false)
      const cam = window.__world.camera
      cam.position.set(x + 2.2, y + 1.2, z + 1.8)
      cam.lookAt(x, y + 0.5, z)
      window.__pipeline.render()
    })()`)
    await sleep(250)
    const shot2 = await handle.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync('/tmp/boar.png', Buffer.from(shot2.result.data, 'base64'))
  }
  if (loc.rabbit) {
    await handle.evalJs(`(() => {
      const [x, y, z] = ${JSON.stringify(loc.rabbit)}
      const cam = window.__world.camera
      cam.position.set(x + 1.4, y + 0.8, z + 1.2)
      cam.lookAt(x, y + 0.25, z)
      window.__pipeline.render()
    })()`)
    await sleep(250)
    const shot3 = await handle.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync('/tmp/rabbit.png', Buffer.from(shot3.result.data, 'base64'))
  }
  console.log('已拍 combat_2h / boar / rabbit')
} finally { await handle.close() }
