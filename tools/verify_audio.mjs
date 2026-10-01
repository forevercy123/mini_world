#!/usr/bin/env node
/** 音效验证：用户手势后能解锁，各音效接口调用不报错 */
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '    ' + d : ''}`) }

const h = await launch({ url: `http://localhost:4173/?freeze=1&hour=10&cb=${Date.now()}` })
try {
  await waitForBoot(h.evalJs); await sleep(2500)

  const before = await h.evalJs(`window.__sfx.isReady`)
  check('初始未解锁（浏览器自动播放策略）', before.value === false)

  // 派发一次真实按键（模拟用户手势）
  await h.keyDown('KeyW', 'w', 87); await sleep(120); await h.keyUp('KeyW', 'w', 87)
  await sleep(500)
  const after = await h.evalJs(`window.__sfx.isReady`)
  check('按键后自动解锁', after.value === true)

  // 逐个触发音效，确认不抛异常
  const played = await h.evalJs(`(() => {
    const s = window.__sfx;
    const names = ['swing','hit','hurt','pickup','chest','seal','blip','shock','gust','dodge','hold'];
    const failed = [];
    for (const n of names) {
      try { s[n](); } catch (e) { failed.push(n + ':' + e.message); }
    }
    return { total: names.length, failed };
  })()`)
  const p = played.value ?? played
  check('全部音效接口可调用', p.failed.length === 0, p.failed.length ? p.failed.join(', ') : `${p.total} 种`)

  // 音量控制
  const vol = await h.evalJs(`(() => { window.__sfx.setVolume(0.2); return window.__sfx.masterVolume; })()`)
  check('音量可调', Math.abs(vol.value - 0.2) < 1e-6, `设为 ${vol.value}`)
} finally { await h.close() }

console.log('')
const failed = results.filter((x) => !x).length
if (failed === 0) console.log(`✅ 音效全部检查通过（${results.length} 项）`)
else { console.log(`❌ ${failed} 项未通过`); process.exitCode = 1 }
