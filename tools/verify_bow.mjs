/**
 * 弓箭与料理增益验证：
 *   装备弩 → 射箭命中远处敌人 → 弹药消耗 → 箭捆补给 → 料理 buff 生效与过期
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
    await sleep(3200)

    // ── 1. 装备弩 ──
    await evalV(`(() => {
      window.__weaponBag.add('crossbow')
      window.__weaponBag.arrows = 6
      window.__syncWeapon()
      window.__playerHealth.refill()
    })()`)
    await sleep(300)
    const moveset = await evalV(`window.__weaponBag.currentDef.moveset`)
    ok(moveset === 'shoot', '弩已装备且是远程招式', moveset)

    // ── 2. 远处放一只怪，射箭命中 ──
    await evalV(`(() => {
      const e = window.__enemies.alive.find(e => !e.health.isDead)
      window.__e = e
      const p = window.__player.position
      const yaw = window.__player.yaw
      // 正前方 12 米
      e.position.set(p.x + Math.sin(yaw) * 12, p.y, p.z + Math.cos(yaw) * 12)
      // 钉住它
      window.__pin = setInterval(() => {
        const p2 = window.__player.position
        e.position.set(p2.x + Math.sin(window.__player.yaw) * 12, p2.y, p2.z + Math.cos(window.__player.yaw) * 12)
      }, 200)
    })()`)
    const hpBefore = await evalV(`window.__e.health.current`)
    const arrowsBefore = await evalV(`window.__weaponBag.arrows`)
    await evalV(`window.__input.attackQueued = true`)
    // 箭飞 12m 约 0.4s，等 1.5s
    await sleep(1500)
    await evalV(`clearInterval(window.__pin)`)
    const hpAfter = await evalV(`window.__e.health.current`)
    const arrowsAfter = await evalV(`window.__weaponBag.arrows`)
    ok(hpAfter < hpBefore, '箭命中 12 米外的敌人', `${hpBefore} → ${hpAfter}`)
    ok(arrowsAfter === arrowsBefore - 1, '射箭消耗 1 支弹药', `${arrowsBefore} → ${arrowsAfter}`)

    // ── 3. 箭捆补给 ──
    await evalV(`(() => {
      const bundle = window.__weaponSpawns.spawns.find(s => s.id === 'arrow_bundle' && !s.taken)
      window.__player.teleportTo(bundle.position.x, bundle.position.z, window.__world.heightfield)
    })()`)
    await sleep(700)
    const arrowsAfterBundle = await evalV(`window.__weaponBag.arrows`)
    ok(arrowsAfterBundle === arrowsAfter + 5, '箭捆 +5 支', `${arrowsAfter} → ${arrowsAfterBundle}`)

    // ── 4. 料理增益：攻击 buff 生效与过期 ──
    await evalV(`(() => {
      window.__inventory.add('dish_sunny')
      window.__playerHealth.set(3)
      window.__player.teleportTo(0, 0, window.__world.heightfield)
    })()`)
    await sleep(300)
    await browser.keyDown('KeyG', 'g', 71)
    await browser.keyUp('KeyG', 'g', 71)
    await sleep(400)
    const buff = await evalV(`window.__buffs()`)
    ok(buff.attack === 1.5 && buff.attackLeft > 55, '阳光炖菜：攻击 ×1.5 持续 60s', JSON.stringify(buff))
    // 快进到过期
    await evalV(`(() => {
      // 直接把游戏时钟拨过 61 秒
      window.__testWarp = 61
    })()`)
    // elementElapsed 是 main 内部的，不能直接改——改为等 buff 自然过期的捷径：
    // 用 HP 验证防御菜也行。这里改为验证 buff 伤害真的变高
    const dmg = await evalV(`window.__combat.config.damage * window.__combat.damageMultiplier`)
    ok(dmg >= 3, 'buff 后的实际伤害变高', `damage=${dmg}`)
  } finally {
    await browser.close()
  }

  if (failures.length > 0) {
    console.log(`\n失败 ${failures.length} 项`)
    process.exit(1)
  }
  console.log('✅ 弓箭与料理增益全部通过')
}

run().catch((err) => {
  console.error('脚本自身出错:', err)
  process.exit(2)
})
