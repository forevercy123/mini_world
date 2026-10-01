#!/usr/bin/env node
/**
 * 验证树木碰撞：角色朝树走时应该被挡住，而不是穿进树干里。
 *
 * 判据是"最终位置到任一树心的距离 >= 树半径 + 角色半径"——
 * 只看有没有停下来是不够的，穿过去之后停在树后面也满足"停下来"。
 *
 * 用法：node tools/verify_collision.mjs [url]
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:4173/?hour=12&freeze=1'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures++
}

const handle = await launch({ url })
const { evalJs } = handle

try {
  console.log('等待页面初始化…')
  await waitForBoot(evalJs)
  await sleep(2500)

  const info = await evalJs('window.__world.obstacles ? window.__world.obstacles.count : -1')
  check('障碍物索引已建立', (info.value ?? 0) > 0, `登记了 ${info.value} 个障碍物`)

  // 把角色放到某棵树的正前方 1.2 米处，朝树走
  const setup = await evalJs(`(() => {
    const w = window.__world;
    const p = window.__player;
    const grid = w.obstacles;
    // 从网格里取第一个障碍物
    const first = grid.cells?.values?.().next?.().value?.[0] ?? null;
    if (!first) return null;
    const hf = w.heightfield;
    // 放在树的 +Z 方向 1.2 米处，并让角色朝 -Z（正对树）
    const sx = first.x, sz = first.z + 1.2;
    p.teleportTo(sx, sz, w.heightfield);
    p.yaw = Math.PI;
    window.__thirdPerson.yaw = 0;
    return { tx: first.x, tz: first.z, radius: first.radius,
             startX: p.position.x, startZ: p.position.z };
  })()`)

  if (setup.error || !setup.value) {
    check('能定位到一棵树', false, setup.error || '未取到障碍物')
  } else {
    check('能定位到一棵树', true,
      `树在 (${setup.value.tx.toFixed(1)}, ${setup.value.tz.toFixed(1)})，半径 ${setup.value.radius.toFixed(2)}`)

    // 按住 W 朝树走 1.5 秒
    const [code, key, vk] = ['KeyW', 'w', 87]
    await handle.keyDown(code, key, vk)
    await sleep(1500)
    await handle.keyUp(code, key, vk)
    await sleep(300)

    const after = await evalJs(`(() => {
      const p = window.__player;
      return { x: p.position.x, z: p.position.z };
    })()`)

    if (after.error) {
      check('走向树干后被挡住', false, `查询失败: ${after.error}`)
    } else {
      const distX = after.value.x - setup.value.tx
      const distZ = after.value.z - setup.value.tz
      const dist = Math.hypot(distX, distZ)
      const minDist = setup.value.radius + 0.35
      // 从 +Z 一侧朝 -Z 走，如果穿过去了 z 会小于树心
      const wentThrough = after.value.z < setup.value.tz - 0.5

      check('没有被推穿树干', !wentThrough,
        `角色 z = ${after.value.z.toFixed(2)}，树心 z = ${setup.value.tz.toFixed(2)}`)
      check('与树心保持最小距离', dist >= minDist - 0.05,
        `距离 ${dist.toFixed(2)} 米，最小应为 ${minDist.toFixed(2)} 米`)
    }
  }
} finally {
  handle.close()
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} 项未通过`)
  process.exit(1)
}
console.log('✅ 树木碰撞检查通过')
process.exit(0)
