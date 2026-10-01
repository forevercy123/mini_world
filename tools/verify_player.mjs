#!/usr/bin/env node
/**
 * 验证角色控制器：移动、贴地、跳跃、转向。
 *
 * 为什么要自动化验证：手感问题（贴地是否严实、跳跃是否生效、朝向是否跟随）
 * 光看截图看不出来——画面里有个人站着不代表他能走。这些断言覆盖的都是
 * 曾经写错过或容易写错的地方。
 *
 * 用法：node tools/verify_player.mjs [url]
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:5173/'

const KEYS = {
  W: ['KeyW', 'w', 87],
  A: ['KeyA', 'a', 65],
  SPACE: ['Space', ' ', 32],
}

let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures++
}

async function readState(evalJs) {
  const r = await evalJs(`(() => {
    const p = window.__player;
    if (!p) return null;
    return {
      x: p.position.x, y: p.position.y, z: p.position.z,
      yaw: p.yaw, grounded: p.grounded, speed: p.horizontalSpeed,
    };
  })()`)
  return r.value
}

/** 角色脚下高度与地形高度的差值，用来判断贴地是否严实 */
async function groundGap(evalJs) {
  const r = await evalJs(`(() => {
    const p = window.__player;
    const h = window.__world.heightfield.height(p.position.x, p.position.z);
    return Math.abs(p.position.y - h);
  })()`)
  return r.value
}

async function press(handle, keyDef, holdMs) {
  const [code, key, vk] = keyDef
  await handle.keyDown(code, key, vk)
  await sleep(holdMs)
  await handle.keyUp(code, key, vk)
}

async function main() {
  const handle = await launch({ url })
  const { evalJs } = handle

  console.log('等待页面初始化…')
  await waitForBoot(evalJs)
  await sleep(2500) // 留时间给地形流式加载，否则角色脚下可能还是空的

  const start = await readState(evalJs)
  check('角色实例已创建', start !== null, start ? `位于 (${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)})` : '')
  if (!start) {
    handle.close()
    process.exit(1)
  }
  check('初始状态站在地面', start.grounded === true, `grounded = ${start.grounded}`)

  const gap0 = await groundGap(evalJs)
  check('初始贴地严实', gap0 < 0.1, `与地形高度差 ${gap0.toFixed(4)} 米`)

  // ── 移动 ──
  await press(handle, KEYS.W, 1500)
  await sleep(300)

  const afterW = await readState(evalJs)
  const moved = Math.hypot(afterW.x - start.x, afterW.z - start.z)
  check('按 W 能前进', moved > 1.5, `位移 ${moved.toFixed(2)} 米`)
  check('移动后仍在地面', afterW.grounded === true, `grounded = ${afterW.grounded}`)

  const gap1 = await groundGap(evalJs)
  check('移动后仍贴地', gap1 < 0.15, `与地形高度差 ${gap1.toFixed(4)} 米`)

  // ── 跳跃 ──
  const beforeJump = await readState(evalJs)
  await handle.keyDown(...KEYS.SPACE)
  await sleep(80)
  await handle.keyUp(...KEYS.SPACE)
  await sleep(170)

  const inAir = await readState(evalJs)
  check('跳跃后离地', inAir.grounded === false, `grounded = ${inAir.grounded}`)
  check('跳跃确实上升', inAir.y > beforeJump.y + 0.25, `y: ${beforeJump.y.toFixed(2)} → ${inAir.y.toFixed(2)}`)

  await sleep(1600)
  const landed = await readState(evalJs)
  check('能正常落地', landed.grounded === true, `y = ${landed.y.toFixed(2)}`)

  // ── 转向 ──
  const beforeTurn = await readState(evalJs)
  await press(handle, KEYS.A, 900)
  await sleep(250)
  const afterTurn = await readState(evalJs)
  const yawDelta = Math.abs(((afterTurn.yaw - beforeTurn.yaw + Math.PI) % (Math.PI * 2)) - Math.PI)
  check('朝向随移动方向改变', yawDelta > 0.05, `yaw 变化 ${yawDelta.toFixed(3)} 弧度`)
  const moved2 = Math.hypot(afterTurn.x - beforeTurn.x, afterTurn.z - beforeTurn.z)
  check('按 A 能侧向移动', moved2 > 0.5, `位移 ${moved2.toFixed(2)} 米`)

  // ── 稳定性：不浮空、不被弹飞 ──
  await sleep(500)
  const finalState = await readState(evalJs)
  check('全程未浮空或被弹飞', finalState.grounded === true, `grounded = ${finalState.grounded}`)
  const gap2 = await groundGap(evalJs)
  check('最终仍贴合地面', gap2 < 0.15, `差值 ${gap2.toFixed(4)} 米`)

  handle.close()
  console.log('')
  if (failures > 0) {
    console.log(`❌ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('✅ 角色控制器全部检查通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err.message)
  process.exit(1)
})
