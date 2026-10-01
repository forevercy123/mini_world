import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&cb=' + Date.now() })
try {
  await waitForBoot(handle.evalJs); await sleep(4500)
  // 丢进水里并向前游
  await handle.evalJs(`(() => {
    const w = window.__world, hf = w.heightfield, WL = w.water.config.level;
    for (let r = 60; r < 900; r += 20) {
      for (let a = 0; a < 32; a++) {
        const ang = a/32*Math.PI*2;
        const x = Math.cos(ang)*r, z = Math.sin(ang)*r;
        if (hf.height(x, z) < WL - 4) { window.__player.teleportTo(x, z, hf); return }
      }
    }
  })()`)
  await sleep(1200)
  const state = await handle.evalJs(`window.__player.state`)
  console.log('状态:', state.value ?? state)

  // 采样两次手臂骨骼的旋转，看是否在划水
  // 直接用角色对象上记的骨骼引用，不按名字遍历。
  //
  // 按名字找会踩两个坑：场景里可能有多个同名节点（NPC 也用同一个模型类
  // 加载），而 getObjectByName 只返回第一个——摸到 NPC 的手臂，就会读出
  // "明明在划水却一动不动"
  const sample = async () => handle.evalJs(`(() => {
    const av = window.__avatar ? window.__avatar() : null;
    const bones = av && av.swimBones ? av.swimBones : [];
    const arm = bones.find(b => b.isArm);
    const out = arm && arm.bone
      ? [+arm.bone.quaternion.x.toFixed(4), +arm.bone.quaternion.y.toFixed(4), +arm.bone.quaternion.z.toFixed(4)]
      : null;
    return {
      q: out,
      state: window.__player.state,
      speed: +window.__player.horizontalSpeed.toFixed(2),
      y: +window.__player.position.y.toFixed(2),
      bones: bones.length,
      ticks: av && av.swimStrokeTicks !== undefined ? av.swimStrokeTicks : -1,
    };
  })()`)
  // 按住 W 游起来，密集采样。
  //
  // 划水是正弦运动，周期约 1.8 秒。原来只在 0.5 秒的间隔上取三个点，
  // 碰上采样窗口正好落在正弦的对称位置，两端就会几乎相等——明明在划，
  // 却读出"没动"。取十二个点、比较所有两两组合的最大变化，就与相位无关了
  await handle.keyDown('KeyW', 'w', 87)
  const samples = []
  for (let i = 0; i < 12; i++) {
    samples.push(await sample())
    await sleep(120)
  }
  await handle.keyUp('KeyW', 'w', 87)

  console.log('upperarm.l 四元数采样（每 120ms 一个点）:')
  const fmt = (r) => {
    const v = r && r.value !== undefined ? r.value : r
    if (!v || !v.q) return 'null'
    return v.q.map(n => n.toFixed(3)).join(', ') +
      `   state=${v.state} speed=${v.speed} bones=${v.bones} ticks=${v.ticks} kind=${v.avatarKind}`
  }
  for (const [i, smp] of [samples[0], samples[5], samples[11]].entries()) {
    console.log(`  #${[0, 5, 11][i]}  `, fmt(smp))
  }
  const pick = (r) => { const v = r && r.value !== undefined ? r.value : r; return v && v.q ? v.q : v }
  const quats = samples.map(pick).filter(Array.isArray)
  if (quats.length < 3) {
    console.log('❌ 拿不到手臂骨骼的旋转')
    process.exitCode = 1
  } else {
    const dist = (p, q) => Math.abs(p[0]-q[0]) + Math.abs(p[1]-q[1]) + Math.abs(p[2]-q[2])
    let diff = 0
    for (let i = 0; i < quats.length; i++) {
      for (let j = i + 1; j < quats.length; j++) {
        diff = Math.max(diff, dist(quats[i], quats[j]))
      }
    }
    console.log(diff > 0.05 ? `✅ 蛙泳手臂在划水（最大分量变化 ${diff.toFixed(3)}）` : `❌ 手臂没动（变化 ${diff.toFixed(4)}）`)
    if (diff <= 0.05) process.exitCode = 1
  }
} finally { await handle.close() }
