#!/usr/bin/env node
/**
 * 主线剧情端到端验证。
 *
 * 把「醒来 → 找贤者 → 三座祭坛 → 开门 → 打 Boss → 通关」整条线走一遍，
 * 每一环都断言状态真的推进了。
 *
 * 传送代替跑路：这一版的地图有 600 米宽，走完一遍要几分钟，不适合放进
 * 回归测试。传送验证的是**状态机与触发条件**；"能不能走到"是地形和移动
 * 系统的责任，那部分由 verify_movement 覆盖。
 *
 * 用法：node tools/verify_quest.mjs
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '    ' + detail : ''}`)
}

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10' })

try {
  console.log('等待页面初始化…')
  await waitForBoot(handle.evalJs)
  await sleep(5000)

  // 剧情系统得先就位
  const boot = await handle.evalJs(`(() => ({
    hasQuest: !!window.__quest,
    hasStory: !!window.__story,
    hasLandmarks: !!window.__landmarks,
    err: window.__bootError || null,
  }))()`)
  const b = boot.value ?? boot
  if (!b.hasQuest || !b.hasStory || !b.hasLandmarks) {
    check('剧情系统已初始化', false, `err=${b.err}`)
    throw new Error('剧情系统没起来，后续无法验证')
  }
  check('剧情系统已初始化', true)

  // ── 1. 初始状态 ──
  const initial = await handle.evalJs(`(() => {
    const q = window.__quest
    return { stage: q.currentStage, target: q.objective.target, text: q.objective.text }
  })()`)
  const i0 = initial.value ?? initial
  check('开局停在「去找贤者」', i0.stage === 'awaken', `stage=${i0.stage}`)
  check('开局目标指向贤者营地的坐标', i0.target !== null, `目标 ${i0.text}`)

  // ── 2. 和贤者对话 ──
  const talked = await handle.evalJs(`(() => {
    const q = window.__quest, sage = window.__sage()
    const site = window.__landmarks.sites.sage
    const hf = window.__world.heightfield
    window.__player.teleportTo(site.x, site.z, hf)
    return { inRange: sage ? sage.canTalk(window.__player.position) : false }
  })()`)
  const t0 = talked.value ?? talked
  check('传送到营地后进入对话范围', t0.inRange === true)

  await sleep(300)
  // 走正规路径：调主循环里同一个入口，等价于玩家按了 E 再连按 E 翻页
  const dialogDone = await handle.evalJs(`(() => {
    const d = window.__dialogue
    const sage = window.__sage()
    if (!sage || !sage.canTalk(window.__player.position)) return { err: '不在对话范围' }
    // 复用主循环里那条路径：先触发对话，再翻到底
    window.__talkToSage()
    let guard = 0
    while (d.isOpen && guard++ < 40) d.advance()
    return { stage: window.__quest.currentStage, open: d.isOpen }
  })()`)
  const d0 = dialogDone.value ?? dialogDone
  check('与贤者对话后进入「收集封印」阶段', d0.stage === 'seals', `stage=${d0.stage}`)
  check('对话结束后对话框已关闭', d0.open === false)

  // ── 3. 三座祭坛 ──
  const SEALS = ['fire', 'ice', 'wind']
  for (const kind of SEALS) {
    // 传送过去，触发守卫战
    await handle.evalJs(`(() => {
      const site = window.__landmarks.sites.altars['${kind}']
      window.__player.teleportTo(site.x, site.z, window.__world.heightfield)
    })()`)
    await sleep(900)

    const spawned = await handle.evalJs(`(() => {
      const n = window.__story.guardiansRemaining('${kind}')
      return { guardians: n, enemies: window.__enemies.alive.length }
    })()`)
    const s0 = spawned.value ?? spawned
    check(`${kind} 祭坛靠近后刷出守卫`, s0.guardians > 0, `${s0.guardians} 只`)

    // 秒掉这一批守卫（战斗本身由 verify_combat 覆盖）
    await handle.evalJs(`(() => {
      const dir = new (window.__player.position.constructor)(0, 0, 1)
      for (const e of window.__enemies.alive) {
        if (!e.health.isDead) e.onHit(999, dir, 0)
      }
      return true
    })()`)
    await sleep(900)

    const claimed = await handle.evalJs(`(() => ({
      has: window.__quest.has('${kind}'),
      count: window.__quest.collectedCount,
      stage: window.__quest.currentStage,
    }))()`)
    const c0 = claimed.value ?? claimed
    check(`击败守卫后获得 ${kind} 封印`, c0.has === true, `已收集 ${c0.count}/3`)
  }

  const afterSeals = await handle.evalJs(`window.__quest.currentStage`)
  check('三枚集齐后自动进入「前往封印之门」', afterSeals.value === 'gate', `stage=${afterSeals.value}`)

  // ── 4. 封印之门 ──
  await handle.evalJs(`(() => {
    const site = window.__landmarks.sites.gate
    window.__player.teleportTo(site.x, site.z, window.__world.heightfield)
  })()`)
  await sleep(900)
  const gateState = await handle.evalJs(`(() => ({
    stage: window.__quest.currentStage,
    opened: window.__landmarks.landmarks.find(l => l.kind === 'gate').activated,
  }))()`)
  const g0 = gateState.value ?? gateState
  check('走到门前会自动开启', g0.opened === true)
  check('开门后进入「击败暗蚀骑士」', g0.stage === 'boss', `stage=${g0.stage}`)

  // ── 5. Boss ──
  await handle.evalJs(`(() => {
    const site = window.__landmarks.sites.arena
    window.__player.teleportTo(site.x, site.z, window.__world.heightfield)
  })()`)
  await sleep(1000)
  const bossUp = await handle.evalJs(`(() => {
    const b = window.__story.bossEnemy
    return { exists: !!b, alive: b ? !b.health.isDead : false }
  })()`)
  const bp = bossUp.value ?? bossUp
  check('进入竞技场后 Boss 出现', bp.exists === true && bp.alive === true)

  await handle.evalJs(`(() => {
    const b = window.__story.bossEnemy
    if (b) b.onHit(999, new (window.__player.position.constructor)(0, 0, 1), 0)
    return true
  })()`)
  await sleep(1200)
  const cleared = await handle.evalJs(`(() => ({
    stage: window.__quest.currentStage,
    defeated: window.__quest.bossDefeated,
    ending: !!document.getElementById('ending'),
  }))()`)
  const cl = cleared.value ?? cleared
  check('击败 Boss 后通关', cl.stage === 'cleared' && cl.defeated === true, `stage=${cl.stage}`)
  check('通关画面已弹出', cl.ending === true)

  // ── 6. 通关后的收尾状态 ──
  const finalState = await handle.evalJs(`(() => {
    const q = window.__quest
    return { text: q.objective.text, target: q.objective.target }
  })()`)
  const f0 = finalState.value ?? finalState
  check('通关后目标栏给出收尾文案', typeof f0.text === 'string' && f0.text.length > 0, f0.text)

  // ── 汇总 ──
  const failed = results.filter((r) => !r.ok)
  console.log('')
  if (failed.length === 0) {
    console.log(`✅ 主线剧情全部检查通过（${results.length} 项）`)
  } else {
    console.log(`❌ ${failed.length} 项未通过：`)
    for (const f of failed) console.log(`   · ${f.name}  ${f.detail}`)
    process.exitCode = 1
  }
} catch (err) {
  console.error('验证过程出错:', err.message)
  process.exitCode = 1
} finally {
  await handle.close()
}
