#!/usr/bin/env node
/**
 * 验证战斗系统：攻击命中、敌人 AI、伤害与无敌帧、死亡。
 *
 * 战斗的时序很关键（前摇 0.08s、命中判定 0.12s、后摇 0.34s），
 * 手工测试很难卡准时机。这里通过 CDP 精确控制"敌人位置 + 玩家朝向 +
 * 按键时刻"，把时序固定下来。
 *
 * 用法：node tools/verify_combat.mjs [url]
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:5173/?hour=12&freeze=1'

const KEYS = {
  J: ['KeyJ', 'j', 74],
  W: ['KeyW', 'w', 87],
}

let failures = 0

function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `   ${detail}` : ''}`)
  if (!ok) failures++
}

async function state(evalJs) {
  const r = await evalJs(`(() => {
    // 顺带带上帧时间：页面"卡住"时它是判断性能问题还是逻辑问题的关键证据
    const perf = window.__monitor ? window.__monitor.latest : null;
    const p = window.__player;
    const em = window.__enemies;
    const ph = window.__playerHealth;
    const alive = em.alive.filter(e => !e.health.isDead);
    let nearest = null;
    let bestD = Infinity;
    for (const e of alive) {
      const d = Math.hypot(e.position.x - p.position.x, e.position.z - p.position.z);
      if (d < bestD) { bestD = d; nearest = e; }
    }
    return {
      hearts: ph.current,
      maxHearts: ph.max,
      invulnerable: ph.isInvulnerable,
      enemyTotal: em.totalCount,
      enemyLiving: em.livingCount,
      frameMs: perf ? perf.frameMs : -1,
      nearest: nearest ? {
        dist: bestD,
        hp: nearest.health.current,
        maxHp: nearest.health.max,
        state: nearest.state,
      } : null,
    };
  })()`)
  // 统一在这里消化错误，避免调用方访问 undefined.value 时抛出更难懂的异常
  if (r.error) return { error: r.error }
  return r.value
}

/**
 * 把最近的敌人挪到玩家正前方指定距离，并让玩家朝向它。
 *
 * @param refill 是否回满敌人血量。测"能否击杀"时必须传 false——
 *   否则每轮循环都把它治满，永远打不死（这里踩过一次）。
 */
async function placeEnemyInFront(evalJs, distance, refill = true) {
  const r = await evalJs(`(() => {
    const p = window.__player;
    const em = window.__enemies;
    const alive = em.alive.filter(e => !e.health.isDead);
    if (alive.length === 0) return null;
    const e = alive[0];
    // 玩家朝 +Z（yaw=0），所以把敌人放在 +Z 方向才是"正前方"
    e.position.set(p.position.x, p.position.y, p.position.z + ${distance});
    e.velocity.set(0, 0, 0);
    ${refill ? 'e.health.refill();' : ''}
    p.yaw = 0;
    p.velocity.set(0, 0, 0);
    return { hp: e.health.current, dist: ${distance} };
  })()`)
  return r.value
}

/** 把所有敌人挪到远处，避免它们干扰不测战斗的断言 */
async function clearEnemiesAway(evalJs) {
  await evalJs(`(() => {
    const p = window.__player;
    const em = window.__enemies;
    for (const e of em.alive) {
      e.position.set(p.position.x + 300, p.position.y, p.position.z + 300);
      e.velocity.set(0, 0, 0);
      e.state = 'idle';
    }
    return true;
  })()`)
}

async function press(handle, keyDef, ms = 70) {
  const [code, key, vk] = keyDef
  await handle.keyDown(code, key, vk)
  await sleep(ms)
  await handle.keyUp(code, key, vk)
}

async function main() {
  const handle = await launch({ url })
  const { evalJs } = handle

  console.log('等待页面初始化…')
  await waitForBoot(evalJs)
  await sleep(2500)

  // ── 1. 敌人生成 ──
  const initial = await state(evalJs)
  check('敌人生成成功', (initial?.enemyTotal ?? 0) > 0, `共 ${initial?.enemyTotal ?? '查询失败'} 个`)
  check('初始生命满格', initial?.hearts === initial?.maxHearts,
    `${initial?.hearts ?? '?'}/${initial?.maxHearts ?? '?'}`)

  // ── 2. 攻击命中 ──
  const placed = await placeEnemyInFront(evalJs, 1.9)
  check('可将敌人置于玩家正前方', Boolean(placed?.dist),
    placed?.dist ? `距离 ${placed.dist} 米` : '没有存活敌人或查询失败')

  if (placed?.dist) {
    const beforeHit = await state(evalJs)
    await press(handle, KEYS.J)
    await sleep(420) // 覆盖前摇 + 命中判定

    const afterHit = await state(evalJs)
    const hpBeforeHit = beforeHit?.nearest?.hp
    const hpAfterHit = afterHit?.nearest?.hp
    check('攻击能对敌人造成伤害',
      typeof hpBeforeHit === 'number' && typeof hpAfterHit === 'number' && hpAfterHit < hpBeforeHit,
      typeof hpAfterHit === 'number' ? `敌人生命 ${hpBeforeHit} → ${hpAfterHit}` : '敌人已消失或查询失败')
  }

  // ── 3. 连续攻击可击杀 ──
  let killed = false
  const livingBefore = initial?.enemyLiving ?? 0
  for (let i = 0; i < 8 && !killed; i++) {
    // 不回血：这是"能否击杀"的测试，每轮都治满就永远测不出来
    await placeEnemyInFront(evalJs, 1.9, false)
    await press(handle, KEYS.J)
    await sleep(460)
    const s = await state(evalJs)
    if (typeof s?.enemyLiving === 'number' && s.enemyLiving < livingBefore) killed = true
  }
  const afterKill = await state(evalJs)
  check('连续攻击能击杀敌人', killed,
    `存活敌人 ${livingBefore} → ${afterKill?.enemyLiving ?? '查询失败'}`)

  // ── 4. 敌人会追击玩家 ──
  const chaseSetup = await evalJs(`(() => {
    const p = window.__player;
    const em = window.__enemies;
    const alive = em.alive.filter(e => !e.health.isDead);
    if (alive.length === 0) return null;
    const e = alive[0];
    // 放在警戒范围（18 米）内但攻击范围外，观察它是否主动靠近
    e.position.set(p.position.x, p.position.y, p.position.z + 14);
    e.velocity.set(0, 0, 0);
    e.state = 'idle';
    return { startDist: 14 };
  })()`)

  if (!chaseSetup.error && chaseSetup.value) {
    await sleep(1800)
    const chased = await state(evalJs)
    const d = chased?.nearest?.dist
    check('敌人会主动追击玩家', typeof d === 'number' && d < 12,
      typeof d === 'number' ? `距离 14.0 → ${d.toFixed(1)} 米` : `查询失败: ${chased?.error ?? '敌人消失'}`)
    check('追击中的敌人进入 chase/attack 状态',
      ['chase', 'attack'].includes(chased?.nearest?.state),
      chased?.nearest ? `state = ${chased.nearest.state}` : '')
  }

  // ── 5. 敌人攻击会伤害玩家 ──
  const hpBefore = await evalJs(`(() => {
    const ph = window.__playerHealth;
    ph.refill();
    const p = window.__player;
    const em = window.__enemies;
    const alive = em.alive.filter(e => !e.health.isDead);
    if (alive.length === 0) return null;
    // 贴到玩家身上，让它进入攻击状态
    const e = alive[0];
    e.position.set(p.position.x + 1.2, p.position.y, p.position.z);
    e.velocity.set(0, 0, 0);
    return ph.current;
  })()`)

  if (!hpBefore.error && typeof hpBefore.value === 'number') {
    // 分多次短等待并穿插健康检查：如果页面在中途卡住，能定位到是哪一刻，
    // 而不是只看到后面一连串断言莫名失败
    let stalled = ''
    let lastFrameMs = -1
    for (let i = 0; i < 6; i++) {
      await sleep(450)
      const ping = await evalJs('1 + 1')
      if (ping.error) {
        stalled = `第 ${(i + 1) * 0.45}s 健康检查失败（最后的帧时间 ${lastFrameMs.toFixed(1)}ms）: ${ping.error}`
        break
      }
      const perf = await evalJs('window.__monitor ? window.__monitor.latest.frameMs : -1')
      if (typeof perf.value === 'number') lastFrameMs = perf.value
    }
    if (stalled) {
      check('敌人攻击会扣玩家生命', false, stalled)
    } else {
      const hurt = await state(evalJs)
      check('敌人攻击会扣玩家生命',
        !hurt.error && hurt.hearts < hpBefore.value,
        hurt.error ? `查询失败: ${hurt.error}` : `生命 ${hpBefore.value} → ${hurt.hearts}（帧时间 ${hurt.frameMs.toFixed(1)}ms）`)
    }
  }

  // ── 6. 无敌帧阻止连续受击 ──
  // 先把敌人挪走：上一步把怪贴在玩家身上，它们会持续刷新无敌帧，
  // 让下面"无敌帧结束后可再次受伤"的断言永远失败
  await clearEnemiesAway(evalJs)
  await sleep(300)

  const invuln = await evalJs(`(() => {
    const ph = window.__playerHealth;
    ph.refill();
    const first = ph.damage(1);
    const second = ph.damage(1); // 紧接的一次应被无敌帧挡下
    return { first, second, current: ph.current, max: ph.max };
  })()`)

  if (invuln.error) {
    check('无敌帧阻止连续受击', false, `页面无响应: ${invuln.error}`)
  } else {
    const v = invuln.value
    check('无敌帧阻止连续受击',
      v.first === true && v.second === false && v.current === v.max - 1,
      `第一次=${v.first} 第二次=${v.second} 生命=${v.current}`)
  }

  // 等无敌帧结束，确认能再次受伤
  await sleep(1100)

  // 先探一下页面是否还在响应——如果这里就超时，说明问题出在页面而非断言
  const alive = await evalJs('1 + 1')
  if (alive.error) {
    check('无敌帧结束后可再次受伤', false, `页面无响应: ${alive.error}`)
  } else {
    const afterInvuln = await evalJs(`(() => {
      const ph = window.__playerHealth;
      if (!ph) return { missing: true };
      return { canDamage: ph.damage(1), current: ph.current };
    })()`)
    if (afterInvuln.error) {
      check('无敌帧结束后可再次受伤', false, `查询失败: ${afterInvuln.error}`)
    } else {
      check('无敌帧结束后可再次受伤', afterInvuln.value.canDamage === true,
        `生命 = ${afterInvuln.value.current}`)
    }
  }

  handle.close()
  console.log('')
  if (failures > 0) {
    console.log(`❌ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('✅ 战斗系统全部检查通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err.message)
  process.exit(1)
})
