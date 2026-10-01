#!/usr/bin/env node
/**
 * 验证阶段 3 的移动机制：体力、冲刺、滑翔、游泳。
 *
 * 这些机制都依赖"特定地形条件"（要有陡坡、要有水、要从高处跳下），
 * 手工测要满地图找地方。这里直接用 CDP 把角色传送到符合条件的坐标，
 * 把测试条件固定下来，每次跑的起点都一样。
 *
 * 用法：node tools/verify_movement.mjs [url]
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:5173/?hour=12&freeze=1'

const KEYS = {
  W: ['KeyW', 'w', 87],
  SHIFT: ['ShiftLeft', 'Shift', 16],
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
      state: p.state, grounded: p.grounded, vy: p.velocity.y,
      vx: p.velocity.x, vz: p.velocity.z,
      stamina: p.stamina.current, speed: p.horizontalSpeed,
      slope: window.__world.heightfield.slope(p.position.x, p.position.z),
      grad: (() => { const g = window.__world.heightfield.gradient(p.position.x, p.position.z); return Math.hypot(g.x, g.y); })(),
    };
  })()`)
  return r.value
}

async function hold(handle, keyDef, ms) {
  const [code, key, vk] = keyDef
  await handle.keyDown(code, key, vk)
  await sleep(ms)
  await handle.keyUp(code, key, vk)
}

/** 把角色传送到满足条件的位置；predicate 在页面里执行 */
async function teleportWhere(evalJs, kind) {
  const r = await evalJs(`(() => {
    const p = window.__player;
    const w = window.__world;
    const hf = w.heightfield;
    const level = w.water.config.level;

    // 找不到时把见过的最陡坡度报回来，便于判断是"地形本来就平"
    // 还是"搜索条件写错了"
    let maxSlopeSeen = 0;
    let maxSlopeAt = null;

    // 从近到远螺旋搜索符合条件的位置
    for (let r = 30; r < 1400; r += 20) {
      for (let a = 0; a < 32; a++) {
        const ang = (a / 32) * Math.PI * 2;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        const h = hf.height(x, z);
        const slope = hf.slope(x, z);

        if (slope > maxSlopeSeen && h > level + 2) {
          maxSlopeSeen = slope;
          maxSlopeAt = { x, z, h, dist: r };
        }

        if ('${kind}' === 'water') {
          // 要足够深，否则站不住也游不起来
          if (h < level - 3) {
            p.teleportTo(x, z, hf);
            p.position.y = level - 0.4;
            return { x, z, h, slope, dist: r };
          }
        } else if ('${kind}' === 'steep') {
          // 用坡度角判定，与角色控制器里的 maxSlopeAngle 同量纲。
          // 取 1.0–1.45 弧度（57°–83°）：明显超过 48° 的行走上限，
          // 但又没陡到接近垂直。
          const angle = hf.slopeAngle(x, z);
          if (angle > 1.0 && angle < 1.45 && h > level + 2) {
            p.teleportTo(x, z, hf);
            return { x, z, h, slope, angle, dist: r };
          }
        } else if ('${kind}' === 'high') {
          // 找一个海拔高的地方，用于测试滑翔
          if (h > level + 35) {
            p.teleportTo(x, z, hf);
            p.position.y = h + 42;
            p.state = 'air';
            p.velocity.set(0, 0, 0);
            return { x, z, h, slope, dist: r };
          }
        }
      }
    }
    return { notFound: true, maxSlopeSeen, maxSlopeAt };
  })()`)
  return r.value
}

async function main() {
  const handle = await launch({ url })
  const { evalJs } = handle

  console.log('等待页面初始化…')
  await waitForBoot(evalJs)
  await sleep(2500)

  // ── 1. 冲刺消耗体力 ──
  const start = await readState(evalJs)
  check('初始体力为满', start.stamina > 99, `${start.stamina.toFixed(0)}%`)

  await handle.keyDown(...KEYS.SHIFT)
  await hold(handle, KEYS.W, 2000)
  const sprinted = await readState(evalJs)
  await handle.keyUp(...KEYS.SHIFT)

  check('冲刺消耗体力', sprinted.stamina < start.stamina - 20,
    `${start.stamina.toFixed(0)}% → ${sprinted.stamina.toFixed(0)}%`)
  check('冲刺速度高于步行', sprinted.speed > 5.5, `${sprinted.speed.toFixed(1)} m/s`)

  // ── 2. 停止后体力恢复 ──
  await sleep(2000)
  const recovered = await readState(evalJs)
  check('停止后体力自动恢复', recovered.stamina > sprinted.stamina + 20,
    `${sprinted.stamina.toFixed(0)}% → ${recovered.stamina.toFixed(0)}%`)

  // ── 3. 滑翔 ──
  const high = await teleportWhere(evalJs, 'high')
  const highFound = Boolean(high && !high.notFound)
  check('找到高地用于测试滑翔', highFound,
    highFound ? `距原点 ${high.dist} 米, 海拔 ${high.h.toFixed(0)} 米` : '未找到海拔足够高的位置')

  if (highFound) {
    // 等一下让 airTime 超过开伞延迟（0.28 秒）
    await sleep(450)
    const falling = await readState(evalJs)
    check('跳下后处于空中', falling.state === 'air' || falling.state === 'glide',
      `state = ${falling.state}, vy = ${falling.vy.toFixed(1)}`)

    const fallSpeedBefore = Math.abs(falling.vy)
    await handle.keyDown(...KEYS.SPACE)
    await sleep(60)
    await handle.keyUp(...KEYS.SPACE)
    await sleep(400)

    const gliding = await readState(evalJs)
    check('空中按跳跃进入滑翔', gliding.state === 'glide', `state = ${gliding.state}`)
    check('滑翔时下落明显变慢', Math.abs(gliding.vy) < fallSpeedBefore * 0.5,
      `下落速度 ${fallSpeedBefore.toFixed(1)} → ${Math.abs(gliding.vy).toFixed(1)} m/s`)

    await sleep(1200)
    const gliding2 = await readState(evalJs)
    check('滑翔持续消耗体力', gliding2.stamina < gliding.stamina,
      `${gliding.stamina.toFixed(0)}% → ${gliding2.stamina.toFixed(0)}%`)
  }

  // ── 4. 游泳 ──
  const water = await teleportWhere(evalJs, 'water')
  const waterFound = Boolean(water && !water.notFound)
  check('找到水域用于测试游泳', waterFound,
    waterFound ? `距原点 ${water.dist} 米` : '未找到足够深的水域')

  if (waterFound) {
    await sleep(700)
    const swimming = await readState(evalJs)
    check('入水后自动切换为游泳', swimming.state === 'swim', `state = ${swimming.state}`)

    const beforeSwim = swimming.y
    await handle.keyDown(...KEYS.SPACE)
    await sleep(500)
    await handle.keyUp(...KEYS.SPACE)
    await sleep(200)
    const surfaced = await readState(evalJs)
    check('按跳跃能在水中上浮', surfaced.y > beforeSwim + 0.1,
      `y: ${beforeSwim.toFixed(2)} → ${surfaced.y.toFixed(2)}`)
  }

  // ── 5. 攀爬 ──
  const steep = await teleportWhere(evalJs, 'steep')
  const steepFound = Boolean(steep && !steep.notFound)
  check('找到陡坡用于测试攀爬', steepFound,
    steepFound
      ? `距原点 ${steep.dist} 米, 坡度 ${steep.slope.toFixed(2)}`
      : `未找到。全图最陡处坡度 ${Number(steep?.maxSlopeSeen ?? 0).toFixed(3)}（行走上限 0.331）`)

  if (steepFound) {
    await sleep(600)

    // 必须先把相机对准**上坡方向**再前进。否则按 W 是横切或下坡，
    // 角色会脱离地面（grounded=false），而攀爬要求 grounded——
    // 早期版本没对准方向，测试"通过"了但其实只是侧滑，根本没爬上坡。
    const aimed = await evalJs(`(() => {
      const w = window.__world, p = window.__player, tp = window.__thirdPerson;
      const g = w.heightfield.gradient(p.position.x, p.position.z);
      const len = Math.hypot(g.x, g.y);
      if (len < 1e-6) return null;
      const gx = g.x / len, gz = g.y / len;
      // ThirdPersonCamera.forward = (-sin(yaw), 0, -cos(yaw))，反解出朝梯度的 yaw
      tp.yaw = Math.atan2(-gx, -gz);
      return { gx, gz };
    })()`)
    check('相机可对准上坡方向', aimed.value !== null,
      aimed.value ? `梯度 (${aimed.value.gx.toFixed(2)}, ${aimed.value.gz.toFixed(2)})` : '梯度为零')

    const before = await readState(evalJs)
    console.log(
      `     起点诊断: state=${before.state} grounded=${before.grounded} ` +
        `slope=${before.slope.toFixed(3)} |∇h|=${before.grad.toFixed(3)} ` +
        `v=(${before.vx.toFixed(2)}, ${before.vz.toFixed(2)})`,
    )

    await handle.keyDown(...KEYS.W)
    await sleep(400)
    const mid = await readState(evalJs)
    console.log(
      `     0.4s 后: state=${mid.state} grounded=${mid.grounded} ` +
        `v=(${mid.vx.toFixed(2)}, ${mid.vz.toFixed(2)}) vy=${mid.vy.toFixed(2)} ` +
        `体力=${mid.stamina.toFixed(0)}%`,
    )
    await sleep(1000)
    await handle.keyUp(...KEYS.W)
    await sleep(200)
    const after = await readState(evalJs)

    const gained = after.y - before.y
    const moved = Math.hypot(after.x - before.x, after.z - before.z)
    check('朝上坡前进能真正爬升', gained > 1.0,
      `上升 ${gained.toFixed(2)} 米, 水平位移 ${moved.toFixed(2)} 米`)
    check('攀爬期间持续消耗体力', after.stamina < before.stamina,
      `${before.stamina.toFixed(0)}% → ${after.stamina.toFixed(0)}%`)
  }

  handle.close()
  console.log('')
  if (failures > 0) {
    console.log(`❌ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('✅ 移动机制全部检查通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err.message)
  process.exit(1)
})
