#!/usr/bin/env node
/** 支线验证：接取 → 凑齐 → 交付 → 完成，以及刷新后的状态 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '    ' + d : ''}`) }

const h = await launch({ url: `http://localhost:4173/?freeze=1&hour=10&cb=${Date.now()}` })
try {
  await waitForBoot(h.evalJs); await sleep(3000)
  await h.evalJs(`localStorage.removeItem('lightland-save')`)

  const npcInfo = await h.evalJs(`(() => ({
    sage: !!window.__sage(),
    woodcutter: !!window.__npc('woodcutter'),
    quests: window.__sideQuests.all.map(q => q.id),
  }))()`)
  const n0 = npcInfo.value ?? npcInfo
  check('两个 NPC 都已加载', n0.sage && n0.woodcutter, `贤者=${n0.sage} 樵夫=${n0.woodcutter}`)
  check('两条支线已注册', n0.quests.length === 2, n0.quests.join(', '))

  // 走到樵夫身边接任务
  const r = await h.evalJs(`(() => {
    const w = window.__npc('woodcutter'), p = window.__player, hf = window.__world.heightfield;
    p.teleportTo(w.position.x, w.position.z + 2, hf);
    return { canTalk: w.canTalk(p.position), state: window.__sideQuests.stateOf('woodcutter-handle', (i,n)=>window.__inventory.count(i)>=n) };
  })()`)
  const v0 = r.value ?? r
  check('走到樵夫身边可以对话', v0.canTalk === true)
  check('初始状态是「未接取」', v0.state === 'unmet', v0.state)

  // 接取：走主循环里那条入口，再把对话翻到底
  const accepted = await h.evalJs(`(() => {
    window.__talkToNpc(window.__npc('woodcutter'));
    const d = window.__dialogue;
    let g=0; while (d.isOpen && g++<20) d.advance();
    return { state: window.__sideQuests.stateOf('woodcutter-handle', (i,n)=>window.__inventory.count(i)>=n) };
  })()`)
  check('对话后接取任务', (accepted.value ?? accepted).state === 'active', (accepted.value ?? accepted).state)

  // 给够骨头，看状态是否变 ready
  const ready = await h.evalJs(`(() => {
    const inv = window.__inventory;
    for (let i=0;i<3;i++) inv.add('bone');
    return { state: window.__sideQuests.stateOf('woodcutter-handle', (i,n)=>inv.count(i)>=n), bone: inv.count('bone') };
  })()`)
  check('凑齐 3 块骨头后变为「可交付」', (ready.value ?? ready).state === 'ready', (ready.value ?? ready).state)

  // 交付
  const done = await h.evalJs(`(() => {
    const w = window.__npc('woodcutter'), inv = window.__inventory;
    window.__talkToNpc(w);
    const d = window.__dialogue;
    let g=0; while (d.isOpen && g++<20) d.advance();
    return { state: window.__sideQuests.stateOf('woodcutter-handle', (i,n)=>inv.count(i)>=n),
             bone: inv.count('bone'), sun: inv.count('sunfruit') };
  })()`)
  const v1 = done.value ?? done
  check('交付后任务完成', v1.state === 'done', v1.state)
  check('骨头被扣掉', v1.bone === 0, `剩 ${v1.bone}`)
  check('奖励已发放', v1.sun >= 2, `向阳果 ${v1.sun}`)

  // 刷新后保持
  await h.evalJs(`window.__save.save(window.__collectSave())`)
  await h.send('Page.reload', { ignoreCache: true })
  await sleep(1500); await waitForBoot(h.evalJs); await sleep(2500)
  const after = await h.evalJs(`(() => ({
    state: window.__sideQuests.stateOf('woodcutter-handle', (i,n)=>window.__inventory.count(i)>=n),
    completed: window.__sideQuests.completedCount,
  }))()`)
  const v2 = after.value ?? after
  check('刷新后支线仍是已完成', v2.state === 'done', `完成 ${v2.completed} 条`)
} finally { await h.close() }

console.log('')
const failed = results.filter((x) => !x).length
if (failed === 0) console.log(`✅ 支线全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed} 项未通过`); process.exitCode = 1 }
