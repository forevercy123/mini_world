/**
 * 验证武器系统 + 野兽 + 篝火烹饪的运行时状态。
 *
 * 这条脚本只读状态不改状态：确认各系统确实初始化成功、
 * 武器挂上了手、野兽在动、篝火点注册完毕。
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const URL = 'http://localhost:5173/?fresh=1'

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

  try {
    await waitForBoot(browser.evalJs, 90)
    await sleep(3500) // 等武器/野兽异步加载

    const res = await browser.evalJs(`(() => {
      const bag = window.__weaponBag
      const spawns = window.__weaponSpawns
      const wildlife = window.__wildlife
      const fires = window.__campfires
      const avatar = window.__avatar?.()
      // 找挂在手上的武器节点
      let weaponInHand = null
      avatar?.object.traverse((c) => {
        if (c.parent && /handslot/i.test(c.parent.name || '') && c !== avatar.object) {
          weaponInHand = c.type + ':' + (c.name || 'anon')
        }
      })
      const animals = wildlife?.alive ?? []
      return {
        bootError: window.__bootError ?? null,
        weaponSlots: bag ? bag.all.map((s) => s.id + ':' + s.durability) : null,
        weaponIndex: bag?.index,
        spawnCount: spawns?.spawns?.length,
        spawnFirst: spawns?.firstAvailable?.(),
        animalCount: animals.length,
        animalStates: animals.map((a) => a.def.kind + '/' + a.state).slice(0, 20),
        fireCount: fires?.fires?.length,
        combatDamage: window.__combat?.config?.damage,
        combatDuration: window.__combat?.config?.duration,
        weaponInHand,
        hudText: document.getElementById('weapon-hud')?.textContent ?? null,
        fps: window.__monitor?.last?.fps ?? null,
        drawCalls: window.__pipeline?.info?.render?.calls ?? null,
      }
    })()`)
    if (res.error) {
      console.log('取状态失败:', res.error)
      failures.push('取状态')
      return
    }
    const state = res.value

    console.log('状态快照:', JSON.stringify(state, null, 2))

    ok(!state.bootError, '启动无错误', state.bootError ?? '')
    ok(state.weaponSlots?.length >= 1, '武器袋有初始武器', JSON.stringify(state.weaponSlots))
    ok(state.spawnCount >= 8, '野外武器点 >= 8', String(state.spawnCount))
    ok(state.animalCount >= 10, '野兽数量 >= 10', String(state.animalCount))
    ok(state.fireCount >= 4, '篝火点 >= 4', String(state.fireCount))
    ok(state.combatDamage === 1 && Math.abs(state.combatDuration - 0.5) < 0.01,
      '战斗参数跟随树枝', `damage=${state.combatDamage} duration=${state.combatDuration}`)
    ok(state.weaponInHand !== null, '武器已挂到手部挂点', state.weaponInHand ?? '未找到')
    ok(state.hudText?.includes('树枝'), '武器 HUD 显示树枝', state.hudText ?? '')
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
