#!/usr/bin/env node
/**
 * 用 Chrome DevTools Protocol 驱动 headless Chrome 跑一次完整巡检，
 * 并把报告取回来打印。
 *
 * 为什么需要它：`--virtual-time-budget` 会把虚拟时钟推得飞快，而巡检依赖
 * requestAnimationFrame 的真实时间轴推进，结果是页面只跑了几帧、巡检永远
 * 走不完。这个脚本改用真实时间等待，再通过 CDP 把结果读出来。
 *
 * 用法：
 *   node tools/verify_bench.mjs [url] [等待秒数]
 *
 * 注意：headless 下 Chrome 可能走软件渲染（SwiftShader），帧率数字不代表
 * 真实 GPU 性能。本脚本用于验证**流程是否走通、数据结构是否正确**；
 * 性能基线请在真实浏览器里点「开始自动巡检」测。
 */

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const url = process.argv[2] || 'http://localhost:5173/?bench=1&delay=3000'
// 4 个用例 ×(1.5s 预热 + 8~10s 录制) ≈ 45s，再留出加载与余量
const waitSeconds = Number(process.argv[3] || 75)
const port = 9222 + Math.floor(Math.random() * 200)
const userDataDir = `/tmp/chrome-verify-${port}`

let chrome = null

function cleanup() {
  if (chrome && !chrome.killed) chrome.kill('SIGKILL')
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 清理失败无所谓 */
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

async function findTarget() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('CDP 端口未就绪，Chrome 可能启动失败')
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()

  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    const entry = pending.get(msg.id)
    if (entry) {
      pending.delete(msg.id)
      entry(msg)
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')))
  })

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  return { ready, send, close: () => ws.close() }
}

async function main() {
  console.log(`启动 headless Chrome（端口 ${port}）…`)
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,800',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ],
    { stdio: 'ignore', detached: false },
  )

  const wsUrl = await findTarget()
  const cdp = connect(wsUrl)
  await cdp.ready

  // 先确认 CDP 通信与页面初始化都正常，否则后面的等待毫无意义
  // CDP 响应是双层嵌套：消息的 result 里再包一层 evaluate 的 result
  const evalJs = async (expression) => {
    const msg = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    const payload = msg?.result
    if (payload?.exceptionDetails) {
      return { error: payload.exceptionDetails.exception?.description || 'JS 异常' }
    }
    return { value: payload?.result?.value }
  }

  const ping = await evalJs('1 + 1')
  console.log(`CDP 连通: ${ping.value === 2 ? '正常' : JSON.stringify(ping)}`)

  // 页面加载是异步的（Vite 编译、three 加载、世界构建都要时间），
  // 连上 CDP 不代表页面就绪，必须轮询等待初始化完成
  let booted = false
  for (let attempt = 0; attempt < 45; attempt++) {
    await new Promise((r) => setTimeout(r, 1000))
    const boot = await evalJs('typeof window.__world')
    if (boot.value === 'object') {
      booted = true
      break
    }
    const err = await evalJs('window.__bootError || null')
    if (err.value) {
      console.log(`❌ 启动错误: ${err.value}`)
      cdp.close()
      cleanup()
      process.exit(1)
    }
  }

  if (!booted) {
    console.log('❌ 等待 45 秒页面仍未初始化完成')
    cdp.close()
    cleanup()
    process.exit(1)
  }
  console.log('页面初始化: 成功')
  console.log('等待巡检完成…')

  const total = waitSeconds
  for (let elapsed = 0; elapsed < total; elapsed += 10) {
    await new Promise((r) => setTimeout(r, 10000))
    const state = await evalJs(`(() => {
      if (document.getElementById('report')) return 'DONE';
      const ap = window.__autopilot;
      if (!ap) return '无 autopilot 实例';
      if (!ap.isRunning) return '未运行';
      return ap.progressText;
    })()`)
    const value = state.error ? `查询出错: ${state.error}` : String(state.value)
    console.log(`  [${Math.min(elapsed + 10, total)}s] ${value}`)
    if (value === 'DONE') break
  }

  const report = await evalJs(`document.getElementById('report')?.innerText || 'NO_REPORT'`)
  const text = report.error ? 'NO_REPORT' : String(report.value ?? 'NO_REPORT')
  console.log('\n' + '─'.repeat(60))
  if (text === 'NO_REPORT') {
    console.log('❌ 巡检未在等待时间内完成，没有拿到报告')
    cdp.close()
    cleanup()
    process.exit(1)
  }

  console.log(text)
  console.log('─'.repeat(60))
  console.log('✅ 巡检流程走通，报告已生成')
  cdp.close()
  cleanup()
  process.exit(0)
}

main().catch((err) => {
  console.error('验证失败:', err.message)
  cleanup()
  process.exit(1)
})
