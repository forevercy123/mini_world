#!/usr/bin/env node
/**
 * 验证拾取与背包：地上有果子、走近能捡起、吃下能回血。
 *
 * 用法：node tools/verify_inventory.mjs [url]
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:4173/?hour=12&freeze=1'
const KEYS = { G: ['KeyG', 'g', 71] }

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const handle = await launch({ url })
  const { evalJs } = handle

  console.log('等待页面初始化…')
  await waitForBoot(evalJs)
  await sleep(2500)

  // ── 1. 地上确实撒了果子 ──
  const scattered = await evalJs('window.__pickups ? window.__pickups.remaining : -1')
  check('世界中生成了可拾取物', (scattered.value ?? 0) > 0,
    `${scattered.value} 个${scattered.error ? ` (${scattered.error})` : ''}`)

  // ── 2. 走到果子旁边，应被自动拾取 ──
  const before = await evalJs('window.__inventory.totalCount')
  const nearFruit = await evalJs(`(() => {
    const p = window.__player;
    const pm = window.__pickups;
    const hf = window.__world.heightfield;
    const spot = pm.firstPickupPosition();
    if (!spot) return null;
    p.teleportTo(spot.x, spot.z, hf);
    p.position.y = spot.y;
    p.velocity.set(0, 0, 0);
    return { x: spot.x, y: spot.y, z: spot.z, remaining: pm.remaining };
  })()`)

  check('能找到地上的果子并靠近', nearFruit.value !== null,
    nearFruit.value ? `位于 (${nearFruit.value.x.toFixed(1)}, ${nearFruit.value.z.toFixed(1)})` : '没有果子')

  if (nearFruit.value) {
    await sleep(900)
    const after = await evalJs('window.__inventory.totalCount')
    check('走近后自动拾取', (after.value ?? 0) > (before.value ?? 0),
      `背包 ${before.value} → ${after.value} 件`)

    const listing = await evalJs(`window.__inventory.list().map(i => i.def.name + '×' + i.count).join(', ')`)
    check('背包里有物品记录', typeof listing.value === 'string' && listing.value.length > 0,
      listing.value || '空')
  }

  // ── 3. 吃果子回血 ──
  const healTest = await evalJs(`(() => {
    const ph = window.__playerHealth;
    const inv = window.__inventory;
    // 先确保背包里有东西、且生命不满
    ph.refill();
    ph.damage(3, 0.05);
    const wounded = ph.current;
    const items = inv.list();
    return { wounded, max: ph.max, items: items.length, first: items[0]?.def.name ?? null };
  })()`)

  check('测试前处于受伤状态且背包有物品',
    healTest.value?.wounded < healTest.value?.max && healTest.value?.items > 0,
    `生命 ${healTest.value?.wounded}/${healTest.value?.max}，物品 ${healTest.value?.items} 种`)

  if (healTest.value?.items > 0 && healTest.value.wounded < healTest.value.max) {
    await sleep(200) // 等无敌帧过去，否则 heal 之外的状态判断会干扰
    const [code, key, vk] = KEYS.G
    await handle.keyDown(code, key, vk)
    await sleep(60)
    await handle.keyUp(code, key, vk)
    await sleep(400)

    const healed = await evalJs(`(() => {
      const ph = window.__playerHealth;
      return { hearts: ph.current, items: window.__inventory.totalCount };
    })()`)
    check('吃果子能回血', (healed.value?.hearts ?? 0) > healTest.value.wounded,
      `生命 ${healTest.value.wounded} → ${healed.value?.hearts}`)
    check('食用会消耗物品', (healed.value?.items ?? 99) < healTest.value.items ||
      healed.value?.items === 0,
      `背包物品数 ${healed.value?.items}`)
  }

  handle.close()
  console.log('')
  if (failures > 0) {
    console.log(`❌ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('✅ 拾取与背包全部检查通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err.message)
  process.exit(1)
})
