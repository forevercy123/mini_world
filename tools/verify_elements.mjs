#!/usr/bin/env node
/**
 * 验证元素系统：点燃、蔓延、可燃性判定、上升气流、灼烧伤害。
 *
 * 火的蔓延有随机性，所以 ElementGrid 用的是**确定性伪随机**（给定种子
 * 结果可复现），否则断言会时过时不过。
 *
 * 用法：node tools/verify_elements.mjs [url]
 * 建议对生产构建运行（npm run preview），dev server 的 HMR 会干扰测试。
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:4173/?hour=12&freeze=1'

const KEYS = { SPACE: ['Space', ' ', 32] }

let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures++
}

async function evalValue(evalJs, expr) {
  const r = await evalJs(expr)
  if (r.error) return { error: r.error }
  return { value: r.value }
}

async function main() {
  const handle = await launch({ url })
  const { evalJs } = handle

  console.log('等待页面初始化…')
  await waitForBoot(evalJs)
  await sleep(2500)

  // ── 1. 在草地上能点着 ──
  const lit = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const hf = window.__world.heightfield;
    const p = window.__player;
    el.reset();
    // 点在角色前方 3 米
    const x = p.position.x + 3;
    const z = p.position.z;
    return {
      flammable: el.isFlammable(x, z, hf),
      ignited: el.ignite(x, z, hf),
      count: el.burningCount,
    };
  })()`)

  if (lit.error) {
    check('元素系统可访问', false, lit.error)
    handle.close()
    process.exit(1)
  }
  check('出生点附近的草地可燃', lit.value.flammable === true)
  check('点火成功', lit.value.ignited === true, `燃烧格子数 ${lit.value.count}`)

  // ── 2. 火会自行蔓延 ──
  await sleep(4000)
  const spread = await evalValue(evalJs, 'window.__elements.burningCount')
  check('火会向周围蔓延', spread.value > lit.value.count,
    `4 秒后从 ${lit.value.count} 个格子增加到 ${spread.value} 个`)

  // ── 3. 水面与沙滩点不着 ──
  const wet = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const hf = window.__world.heightfield;
    const level = window.__world.water.config.level;
    for (let r = 40; r < 1200; r += 20) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        if (hf.height(x, z) < level - 2) {
          return { x, z, flammable: el.isFlammable(x, z, hf), ignited: el.ignite(x, z, hf) };
        }
      }
    }
    return null;
  })()`)
  check('水面不可燃', wet.value?.flammable === false && wet.value?.ignited === false,
    wet.value ? `水深处的可燃性 = ${wet.value.flammable}` : '未找到水域')

  // ── 4. 上升气流 ──
  const draft = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const cells = [...el.cells];
    if (cells.length === 0) return null;
    const c = cells[0];
    return {
      atFire: el.updraftAt(c.x, c.z),
      farAway: el.updraftAt(c.x + 300, c.z),
    };
  })()`)
  check('火堆上方有上升气流', (draft.value?.atFire ?? 0) > 0.1,
    `强度 ${draft.value?.atFire?.toFixed(2) ?? '?'}`)
  check('远离火堆没有气流', draft.value?.farAway === 0)

  // ── 5. 滑翔时被上升气流托住 ──
  const placed = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const p = window.__player;
    const cells = [...el.cells];
    if (cells.length === 0) return null;
    const c = cells[0];
    p.teleportTo(c.x, c.z, window.__world.heightfield);
    p.position.y += 26;
    p.state = 'air';
    p.airTime = 1;      // 越过开伞延迟，允许立刻展伞
    p.velocity.set(0, 0, 0);
    window.__playerHealth.refill();
    return { x: c.x, z: c.z };
  })()`)

  if (!placed.error && placed.value) {
    await sleep(150)
    const [code, key, vk] = KEYS.SPACE
    await handle.keyDown(code, key, vk)
    await sleep(60)
    await handle.keyUp(code, key, vk)
    await sleep(700)

    const gliding = await evalValue(evalJs, `(() => {
      const p = window.__player;
      return { state: p.state, vy: p.velocity.y, updraft: p.currentUpdraft, y: p.position.y };
    })()`)

    check('在火堆上方能展开滑翔', gliding.value?.state === 'glide',
      `state = ${gliding.value?.state ?? '?'}`)
    // 常态滑翔是 -2.2 m/s 的恒定下降；被气流托起时应当明显更慢甚至上升
    check('上升气流托住了滑翔', (gliding.value?.vy ?? -99) > -1.5,
      `下降速度 ${gliding.value?.vy?.toFixed(2) ?? '?'} m/s（常态为 -2.2），气流强度 ${gliding.value?.updraft?.toFixed(2) ?? '?'}`)
  }

  // ── 6. 站在火里会被灼烧 ──
  const burn = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const p = window.__player;
    const cells = [...el.cells];
    if (cells.length === 0) return null;
    const c = cells[0];
    window.__playerHealth.refill();
    p.teleportTo(c.x, c.z, window.__world.heightfield);
    p.state = 'ground';
    return { hearts: window.__playerHealth.current, burning: el.isBurning(c.x, c.z) };
  })()`)

  if (!burn.error && burn.value) {
    check('玩家所在位置确实在燃烧', burn.value.burning === true)
    await sleep(1400)
    const hurt = await evalValue(evalJs, 'window.__playerHealth.current')
    check('站在火里会掉血', (hurt.value ?? 99) < burn.value.hearts,
      `生命 ${burn.value.hearts} → ${hurt.value}`)
  }

  // ── 7. 冻结水面 ──
  const freeze = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const hf = window.__world.heightfield;
    const level = window.__world.water.config.level;
    for (let r = 40; r < 1200; r += 20) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        if (hf.height(x, z) < level - 2) {
          const frozen = el.freeze(x, z, hf, 10);
          return { x, z, frozen, iceCount: el.iceCount, iceHeight: el.iceHeightAt(x, z) };
        }
      }
    }
    return null;
  })()`)

  check('能在水面上结冰', (freeze.value?.frozen ?? 0) > 0,
    freeze.value ? `冻结 ${freeze.value.frozen} 格，冰面共 ${freeze.value.iceCount} 格` : '未找到水域')
  check('冰面高度等于水位', Math.abs((freeze.value?.iceHeight ?? -1) - 11) < 0.01,
    `冰面高度 ${freeze.value?.iceHeight}`)

  // ── 8. 结冰后能站在上面（而不是继续游泳）──
  if (freeze.value) {
    await evalValue(evalJs, `(() => {
      const p = window.__player;
      const hf = window.__world.heightfield;
      p.teleportTo(${freeze.value.x}, ${freeze.value.z}, hf);
      // teleportTo 按地形高度放置，会沉到水下；手动抬到冰面高度
      p.position.y = 11.3;
      p.velocity.set(0, 0, 0);
      return true;
    })()`)
    await sleep(700)

    const onIce = await evalValue(evalJs, `(() => {
      const p = window.__player;
      return { state: p.state, y: p.position.y, grounded: p.grounded };
    })()`)
    check('站到冰面上会切换为地面状态', onIce.value?.state === 'ground',
      `state = ${onIce.value?.state}，y = ${onIce.value?.y?.toFixed(2)}`)
  }

  // ── 9. 冰会被融化 ──
  if (freeze.value) {
    const melt = await evalValue(evalJs, `(() => {
      const el = window.__elements;
      const before = el.iceCount;
      const melted = el.melt(${freeze.value.x}, ${freeze.value.z}, 12);
      return { before, melted, after: el.iceCount };
    })()`)
    check('冰面可以被融化', (melt.value?.melted ?? 0) > 0,
      `冰面 ${melt.value?.before} → ${melt.value?.after} 格`)
  }

  // ── 10. 灭火 ──
  // 用火场自身的位置，而不是玩家当前位置——前面的冰测试把玩家挪到了
  // 几百米外的水域，照玩家位置灭火只会扑空（这里踩过一次）。
  const doused = await evalValue(evalJs, `(() => {
    const el = window.__elements;
    const cells = [...el.cells];
    if (cells.length === 0) return null;
    const c = cells[0];
    const before = el.burningCount;
    const putOut = el.douse(c.x, c.z, 30);
    return { before, putOut, after: el.burningCount };
  })()`)
  check('可以浇灭火焰', (doused.value?.putOut ?? 0) > 0,
    doused.value
      ? `燃烧格子 ${doused.value.before} → ${doused.value.after}（扑灭 ${doused.value.putOut} 个）`
      : '火已经烧完了，没有可扑灭的目标')

  handle.close()
  console.log('')
  if (failures > 0) {
    console.log(`❌ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('✅ 元素系统全部检查通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err.message)
  process.exit(1)
})
