/** 烹饪界面截图：给足食材，打开界面，选两样，拍照 */
import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const handle = await launch({ url: 'http://localhost:4173/?fresh=1&hour=10' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3200)
  await handle.evalJs(`(() => {
    window.__inventory.add('raw_meat', 2)
    window.__inventory.add('mushroom', 2)
    window.__inventory.add('apple', 1)
    window.__inventory.add('sunfruit', 1)
    window.__inventory.add('berry', 3)
    const pot = window.__campfires.fires[0].potPosition
    window.__player.teleportTo(pot.x, pot.z, window.__world.heightfield)
  })()`)
  await sleep(500)
  await handle.evalJs(`window.__cookingMenu.open(window.__inventory)`)
  await sleep(300)
  await handle.evalJs(`(() => {
    const menu = document.querySelector('#cooking-menu')
    const items = [...menu.querySelectorAll('div')].filter(d => d.style.cursor === 'pointer')
    items.find(d => d.textContent.includes('生肉'))?.click()
    items.find(d => d.textContent.includes('野蘑菇'))?.click()
  })()`)
  await sleep(300)
  const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync('/tmp/cooking_ui.png', Buffer.from(shot.result.data, 'base64'))
  console.log('已保存 /tmp/cooking_ui.png')
} finally { await handle.close() }
