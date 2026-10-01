#!/usr/bin/env node
/**
 * 宝箱验证：生成 → 开箱掉落 → 存档后保持开启。
 *
 * 最后一项是关键：如果开过的箱子在读档后又合上，玩家会以为进度没保存。
 * 所以这里在同一个实例里刷新一次再检查。
 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '    ' + detail : ''}`)
}

const BASE = 'http://localhost:4173/?freeze=1&hour=10&cb='
const h = await launch({ url: `${BASE}${Date.now()}` })

try {
  await waitForBoot(h.evalJs)
  await sleep(2500)
  await h.evalJs(`localStorage.removeItem('lightland-save')`)

  const info = await h.evalJs(`(() => {
    const t = window.__treasures;
    return { count: t.chests.length, opened: t.chests.filter(c => c.opened).length };
  })()`)
  const v0 = info.value ?? info
  check('宝箱已生成', v0.count >= 8, `${v0.count} 个`)
  check('初始全部未开启', v0.opened === 0)

  // 传送到第一个箱子旁边开它
  const opened = await h.evalJs(`(() => {
    const t = window.__treasures, inv = window.__inventory;
    const c = t.chests[0];
    const hf = window.__world.heightfield;
    window.__player.teleportTo(c.position.x, c.position.z, hf);
    const before = { berry: inv.count('berry'), bone: inv.count('bone'), sun: inv.count('sunfruit') };
    const loot = t.open(c);
    for (const id of loot) inv.add(id);
    window.__save.save(window.__collectSave());
    return {
      lootCount: loot.length,
      loot: loot.join(','),
      before,
      after: { berry: inv.count('berry'), bone: inv.count('bone'), sun: inv.count('sunfruit') },
      openedNow: c.opened,
    };
  })()`)
  const v1 = opened.value ?? opened
  check('开箱返回掉落物', v1.lootCount >= 2, `${v1.lootCount} 件：${v1.loot}`)
  const gained = (v1.after.berry - v1.before.berry) + (v1.after.bone - v1.before.bone) + (v1.after.sun - v1.before.sun)
  check('掉落进入背包', gained === v1.lootCount, `实际增加 ${gained}`)
  check('箱子标记为已开启', v1.openedNow === true)

  // 重复开同一个箱子应该什么都不给
  const again = await h.evalJs(`window.__treasures.open(window.__treasures.chests[0]).length`)
  check('重复开箱不再掉落', again.value === 0)

  // 刷新后仍然是开着的
  await h.send('Page.reload', { ignoreCache: true })
  await sleep(1500)
  await waitForBoot(h.evalJs)
  await sleep(2500)
  const persisted = await h.evalJs(`(() => {
    const t = window.__treasures;
    return { first: t.chests[0].opened, openedCount: t.chests.filter(c => c.opened).length };
  })()`)
  const v2 = persisted.value ?? persisted
  check('刷新后开过的箱子仍是开启的', v2.first === true, `共 ${v2.openedCount} 个开启`)
} finally {
  await h.close()
}

console.log('')
const failed = results.filter((r) => !r.ok)
if (failed.length === 0) console.log(`✅ 宝箱全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed.length} 项未通过`); process.exitCode = 1 }
