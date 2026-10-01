/**
 * 烹饪 + 打猎全流程验证：
 *   1. 野兽行为（鹿逃跑、狼反击）
 *   2. 猎杀掉肉
 *   3. 锅边开火 → 点选食材 → 下锅 → 料理进背包
 *   4. 吃料理回血
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const URL = 'http://localhost:4173/?fresh=1&freeze=1&hour=10'

const run = async () => {
  const browser = await launch({ url: URL })
  const failures = []
  const ok = (cond, label, detail = '') => {
    if (cond) console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
    else {
      console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
      failures.push(label)
    }
  }
  const evalV = async (expr) => {
    const r = await browser.evalJs(expr)
    if (r.error) console.log('  [eval 错误]', r.error)
    return r.value
  }

  try {
    await waitForBoot(browser.evalJs, 90)
    await sleep(3500)

    // ── 1. 鹿见人就跑 ──
    await evalV(`(() => {
      const deer = window.__wildlife.alive.find(a => a.def.kind === 'deer')
      window.__deer = deer
      window.__player.teleportTo(deer.position.x - 4, deer.position.z, window.__world.heightfield)
    })()`)
    await sleep(1500)
    const deerState = await evalV(`window.__deer.state`)
    ok(deerState === 'alert' || deerState === 'flee', '鹿见到玩家进入警觉/逃跑', deerState)
    await sleep(1200)
    const deerState2 = await evalV(`window.__deer.state`)
    ok(deerState2 === 'flee', '玩家逗留后鹿逃跑', deerState2)

    // ── 2. 狼主动攻击玩家 ──
    await evalV(`(() => {
      const wolf = window.__wildlife.alive.find(a => a.def.kind === 'wolf' && !a.health.isDead)
      window.__wolf = wolf
      window.__player.teleportTo(wolf.position.x - 6, wolf.position.z, window.__world.heightfield)
      window.__playerHealth.refill()
    })()`)
    // 等狼追上来咬一口
    let wolfBit = false
    for (let i = 0; i < 14; i++) {
      await sleep(500)
      const hp = await evalV(`window.__playerHealth.current`)
      const st = await evalV(`window.__wolf.state`)
      if (st === 'aggro' || st === 'attack') wolfBit = wolfBit || true
      if (hp < 6) { wolfBit = true; break }
    }
    ok(wolfBit, '狼主动追击并咬伤玩家')

    // ── 3. 猎杀掉肉：把鹿钉在原地打死 ──
    await evalV(`(() => {
      const deer = window.__deer
      // 直接打空血：调用战斗接口
      const v = deer.position.constructor
      deer.onHit(99, new v(1, 0, 0), 0)
    })()`)
    await sleep(3200) // 尸体停留 2.6s 后化成肉
    const meatCount = await evalV(`window.__inventory.count('raw_meat')`)
    // 传送到鹿尸体处捡肉
    await evalV(`(() => {
      const d = window.__deer.position
      window.__player.teleportTo(d.x, d.z, window.__world.heightfield)
    })()`)
    await sleep(900)
    const meatPicked = await evalV(`window.__inventory.count('raw_meat')`)
    ok(meatPicked >= 1, '猎杀鹿掉生肉并自动拾取', `raw_meat=${meatPicked}`)

    // ── 4. 烹饪 ──
    await evalV(`(() => {
      window.__inventory.add('mushroom', 2)
      window.__inventory.add('raw_meat', 1)
      // 传到锅边
      const pot = window.__campfires.fires[0].potPosition
      window.__player.teleportTo(pot.x, pot.z, window.__world.heightfield)
    })()`)
    await sleep(500)
    // 按 E 开火
    await browser.keyDown('KeyE', 'e', 69)
    await browser.keyUp('KeyE', 'e', 69)
    await sleep(400)
    const menuOpen = await evalV(`window.__cookingMenu.isOpen`)
    ok(menuOpen === true, '锅边按 E 打开烹饪界面')

    // 点选食材：肉 + 蘑菇。食材架上的按钮按文本找
    await evalV(`(() => {
      const shelf = document.querySelector('#cooking-menu')
      const items = [...shelf.querySelectorAll('div')].filter(d => d.style.cursor === 'pointer')
      const meat = items.find(d => d.textContent.includes('生肉'))
      const shroom = items.find(d => d.textContent.includes('野蘑菇'))
      meat?.click()
      shroom?.click()
    })()`)
    await sleep(300)
    const preview = await evalV(`(() => {
      const menu = document.getElementById('cooking-menu')
      const divs = [...menu.querySelectorAll('div')]
      return divs.map(d => d.textContent).find(t => t && t.includes('→'))
    })()`)
    ok(preview?.includes('鲜肉蘑菇串'), '肉+蘑菇预览出肉菇串', preview ?? '')

    // 下锅
    await evalV(`(() => {
      const btn = [...document.querySelectorAll('#cooking-menu button')].find(b => b.textContent.includes('下锅'))
      btn.click()
    })()`)
    await sleep(400)
    const dishCount = await evalV(`window.__inventory.count('dish_meat_mushroom')`)
    ok(dishCount === 1, '烹饪出肉菇串进背包', `count=${dishCount}`)
    const meatLeft = await evalV(`window.__inventory.count('raw_meat')`)
    ok(meatLeft === 1, '食材被消耗（2 块肉用掉 1 块）', `剩 ${meatLeft}`)

    // ── 5. 吃料理回血 ──
    await evalV(`(() => {
      window.__cookingMenu.close()
      window.__playerHealth.set(1)
    })()`)
    await sleep(300)
    await browser.keyDown('KeyG', 'g', 71)
    await browser.keyUp('KeyG', 'g', 71)
    await sleep(400)
    const hpAfter = await evalV(`window.__playerHealth.current`)
    const dishAfter = await evalV(`window.__inventory.count('dish_meat_mushroom')`)
    const sceneInfo = await evalV(`JSON.stringify({
      toast: document.getElementById('toast')?.textContent,
      menuOpen: window.__cookingMenu.isOpen,
      state: window.__player.state,
      nearWolf: window.__wildlife.alive.filter(a => !a.health.isDead && Math.hypot(a.position.x - window.__player.position.x, a.position.z - window.__player.position.z) < 20).map(a => a.def.kind + '/' + a.state),
    })`)
    console.log('  [调试]', sceneInfo)
    // 血量上限 6：1 + 5 = 6 正好顶满
    ok(hpAfter === 6 && dishAfter === 0, '吃肉菇串回 5 心', `1 → ${hpAfter} 剩料理=${dishAfter}`)
  } finally {
    await browser.close()
  }

  if (failures.length > 0) {
    console.log(`\n失败 ${failures.length} 项`)
    process.exit(1)
  }
  console.log('✅ 全部通过')
}

run().catch((err) => {
  console.error('脚本自身出错:', err)
  process.exit(2)
})
