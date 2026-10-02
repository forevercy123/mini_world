/**
 * 神庙验证：触发挑战 → 三波守卫 → 通关 → 心之容器。
 * 外加完美闪避与蓄力斩的机制验证。
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

    // ── 1. 神庙就位 ──
    const shrineCount = await evalV(`window.__shrines.shrines.length`)
    ok(shrineCount === 4, '四座神庙已布置', String(shrineCount))

    // ── 2. 站上石台触发挑战 ──
    await evalV(`(() => {
      const s = window.__shrines.shrines[0]
      window.__s = s
      window.__player.teleportTo(s.position.x, s.position.z, window.__world.heightfield)
      window.__playerHealth.refill()
    })()`)
    await sleep(600)
    const activated = await evalV(`window.__s.state`)
    ok(activated === 'active', '站上石台触发试炼', activated)

    // ── 3. 打三波（直接秒，验证波次推进） ──
    for (let wave = 0; wave < 3; wave++) {
      // 等这一波刷出来
      let waveSize = 0
      for (let i = 0; i < 14; i++) {
        await sleep(400)
        waveSize = await evalV(`(() => {
          const s = window.__s
          return window.__enemies.alive.filter(e =>
            !e.health.isDead &&
            Math.hypot(e.position.x - s.position.x, e.position.z - s.position.z) < 20,
          ).length
        })()`)
        if (waveSize > 0) break
      }
      ok(waveSize > 0, `第 ${wave + 1} 波守卫刷出`, `${waveSize} 只`)
      // 全灭
      await evalV(`(() => {
        const s = window.__s
        const V = window.__player.position.constructor
        for (const e of window.__enemies.alive) {
          if (e.health.isDead) continue
          if (Math.hypot(e.position.x - s.position.x, e.position.z - s.position.z) > 20) continue
          e.onHit(99, new V(1, 0, 0), 0)
        }
      })()`)
      await sleep(700)
    }
    const cleared = await evalV(`window.__s.state`)
    ok(cleared === 'cleared', '三波全灭后试炼通过', cleared)

    // ── 4. 开宝箱拿心之容器 ──
    const heartsBefore = await evalV(`window.__playerHealth.max`)
    await evalV(`(() => {
      const s = window.__s
      window.__player.teleportTo(s.position.x, s.position.z, window.__world.heightfield)
    })()`)
    await sleep(400)
    await browser.keyDown('KeyE', 'e', 69)
    await browser.keyUp('KeyE', 'e', 69)
    await sleep(500)
    const heartsAfter = await evalV(`window.__playerHealth.max`)
    ok(heartsAfter === heartsBefore + 1, '心之容器：生命上限 +1', `${heartsBefore} → ${heartsAfter}`)
    const hpFull = await evalV(`window.__playerHealth.current === window.__playerHealth.max`)
    ok(hpFull === true, '拿容器时回满血')

    // ── 5. 完美闪避：闪避无敌帧内被打 → 子弹时间 ──
    await evalV(`(() => {
      window.__player.teleportTo(0, 0, window.__world.heightfield)
      window.__playerHealth.refill()
    })()`)
    await sleep(400)
    // 无敌帧只有 0.22s，高负载下 sleep 不精确：反复尝试直到落在窗口里
    let flurry = false
    for (let i = 0; i < 6 && !flurry; i++) {
      await browser.keyDown('KeyQ', 'q', 81)
      await browser.keyUp('KeyQ', 'q', 81)
      await sleep(90)
      const invuln = await evalV(`window.__player.isInvulnerable`)
      if (invuln) {
        await evalV(`window.__damagePlayer(1, new (window.__player.position.constructor)(3, 0, 3))`)
        await sleep(200)
        flurry = await evalV(`window.__isFlurry()`)
      }
      if (!flurry) await sleep(600) // 等闪避完全结束再来
    }
    ok(flurry === true, '完美闪避触发子弹时间')

    // ── 6. 蓄力斩：按住 J 到点放旋风斩，背后的敌人也挨打 ──
    await evalV(`(() => {
      // 玩家背后 1.5m 放一只怪
      const e = window.__enemies.alive.find(e => !e.health.isDead)
      window.__e = e
      const p = window.__player.position
      const yaw = window.__player.yaw
      e.position.set(p.x - Math.sin(yaw) * 1.5, p.y, p.z - Math.cos(yaw) * 1.5)
      window.__playerHealth.refill()
    })()`)
    const enemyHpBefore = await evalV(`window.__e.health.current`)
    await browser.keyDown('KeyJ', 'j', 74)
    await sleep(800)
    await browser.keyUp('KeyJ', 'j', 74)
    await sleep(900)
    const enemyHpAfter = await evalV(`window.__e.health.current`)
    const dbg = await evalV(`JSON.stringify({
      charge: window.__chargeState(),
      dist: (() => { const p = window.__player.position; return Math.hypot(window.__e.position.x-p.x, window.__e.position.z-p.z).toFixed(2) })(),
      dead: window.__e.health.isDead,
      kind: window.__e.kind,
    })`)
    console.log('  [调试]', dbg)
    ok(enemyHpAfter < enemyHpBefore, '蓄力旋风斩命中背后的敌人（360°）', `${enemyHpBefore} → ${enemyHpAfter}`)

    // ── 7. 格挡：正面免伤、侧面挨打 ──
    const maxHp = await evalV(`window.__playerHealth.max`)
    await evalV(`(() => {
      window.__player.teleportTo(20, 20, window.__world.heightfield)
      window.__player.yaw = 0  // 面朝 +z
      window.__playerHealth.refill()
    })()`)
    await sleep(300)
    // 按住右键格挡
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'right', clickCount: 1 })
    await sleep(300)
    const hpBlock1 = await evalV(`(() => {
      const V = window.__player.position.constructor
      const p = window.__player.position
      // 正面（+z 方向）来的攻击
      window.__damagePlayer(1, new V(p.x, p.y, p.z + 3))
      return window.__playerHealth.current
    })()`)
    const hpBlock2 = await evalV(`(() => {
      const V = window.__player.position.constructor
      const p = window.__player.position
      // 背后（-z 方向）来的攻击
      window.__damagePlayer(1, new V(p.x, p.y, p.z - 3))
      return window.__playerHealth.current
    })()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'right', clickCount: 1 })
    ok(hpBlock1 === maxHp && hpBlock2 === maxHp - 1, '格挡挡住正面攻击、挡不住背后', `正面后 ${hpBlock1} → 背后后 ${hpBlock2}（满血 ${maxHp}）`)
  } finally {
    await browser.close()
  }

  if (failures.length > 0) {
    console.log(`\n失败 ${failures.length} 项`)
    process.exit(1)
  }
  console.log('✅ 神庙与新战斗机制全部通过')
}

run().catch((err) => {
  console.error('脚本自身出错:', err)
  process.exit(2)
})
