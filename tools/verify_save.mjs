#!/usr/bin/env node
/**
 * 存档验证：写入 → 刷新 → 读回，确认进度真的回来了。
 *
 * 用两段页面会话跑：第一段制造进度并保存，第二段（全新加载）检查
 * 状态是否恢复。这是唯一能验出"存进去了但读不出来"的方式。
 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '    ' + detail : ''}`)
}

const BASE = 'http://localhost:4173/?freeze=1&hour=10&cb='

/**
 * 必须用**同一个浏览器实例**做"刷新"，不能开两个。
 *
 * cdp.mjs 每次 launch 都用一个独立的 user-data-dir，并在关闭时把它删掉——
 * 两次 launch 之间 localStorage 完全不共享。用两个会话去测存档，测的是
 * "换了台电脑还记不记得"，那当然不记得。
 */
{
  const h = await launch({ url: `${BASE}${Date.now()}` })
  try {
    await waitForBoot(h.evalJs)
    await sleep(2500)
    await h.evalJs(`localStorage.removeItem('lightland-save')`)
    const made = await h.evalJs(`(() => {
      const q = window.__quest, inv = window.__inventory, p = window.__player;
      q.completeIntroduction();
      q.collect('fire');
      q.collect('ice');
      inv.add('berry'); inv.add('berry'); inv.add('bone'); inv.add('bone'); inv.add('bone');
      p.teleportTo(123, -456, window.__world.heightfield);
      window.__minimap.setPins([{ x: 11, z: 22 }, { x: -33, z: 44 }]);
      window.__save.save(window.__collectSave());
      return { seals: q.collectedCount, stage: q.currentStage, bone: inv.count('bone') };
    })()`)
    const v = made.value ?? made
    check('写入存档', v.seals === 2 && v.bone === 3, `封印 ${v.seals}，骨头 ${v.bone}`)
    const raw = await h.evalJs(`!!localStorage.getItem('lightland-save')`)
    check('localStorage 里确实有数据', raw.value === true)

    // ── 第二段：在同一个实例里刷新，模拟玩家按 F5 ──
    await h.send('Page.reload', { ignoreCache: true })
    await sleep(1500)
    await waitForBoot(h.evalJs)
    await sleep(2500)
    const back = await h.evalJs(`(() => {
      const q = window.__quest, inv = window.__inventory, p = window.__player;
      return {
        stage: q.currentStage,
        seals: q.collectedCount,
        hasFire: q.has('fire'), hasIce: q.has('ice'), hasWind: q.has('wind'),
        bone: inv.count('bone'), berry: inv.count('berry'),
        x: Math.round(p.position.x), z: Math.round(p.position.z),
        pins: window.__minimap.getPins().length,
      };
    })()`)
    const r2 = back.value ?? back
    check('任务阶段已恢复', r2.stage === 'seals', `stage=${r2.stage}`)
    check('已收集的封印已恢复', r2.hasFire && r2.hasIce && !r2.hasWind, `fire=${r2.hasFire} ice=${r2.hasIce} wind=${r2.hasWind}`)
    check('背包已恢复', r2.bone === 3 && r2.berry === 2, `骨头 ${r2.bone}，野莓 ${r2.berry}`)
    check('玩家位置已恢复', Math.abs(r2.x - 123) < 3 && Math.abs(r2.z + 456) < 3, `(${r2.x}, ${r2.z})`)
    check('地图标记已恢复', r2.pins === 2, `${r2.pins} 个`)
  } finally { await h.close() }
}

console.log('')
const failed = results.filter((r) => !r.ok)
if (failed.length === 0) console.log(`✅ 存档全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed.length} 项未通过`); process.exitCode = 1 }
