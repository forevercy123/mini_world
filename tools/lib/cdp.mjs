/**
 * 通过 Chrome DevTools Protocol 驱动 headless Chrome 的公共封装。
 *
 * 为什么不用 `--virtual-time-budget`：它会把虚拟时钟推得飞快，而游戏逻辑
 * 依赖 requestAnimationFrame 的真实时间轴（dt、巡检计时），结果是页面
 * 只跑几帧就"结束"了。这里统一走真实时间 + CDP 轮询。
 *
 * 注意：headless Chrome 用的是真实 GPU（ANGLE Metal），帧率数字有参考
 * 价值；但它不渲染到真实屏幕，某些合成路径与真实浏览器不同。
 */

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const DEFAULT_CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 启动 headless Chrome 并连上 CDP。
 * 返回的 handle 带有 evalJs / send / key / close。
 */
export async function launch({ url, width = 1280, height = 800, port }) {
  const cdpPort = port ?? 9300 + Math.floor(Math.random() * 400)
  const userDataDir = `/tmp/chrome-cdp-${cdpPort}`

  const chrome = spawn(
    DEFAULT_CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      url,
    ],
    // detached 让 Chrome 自成一个进程组。headless Chrome 除了主进程还会
    // 拉起 renderer、gpu、utility 好几个子进程，只对主进程发 SIGKILL 的话
    // 那些子进程会留下来继续吃 CPU——连着跑十几个测试，机器就被拖垮了，
    // 表现是"单跑能过、连跑挂掉"的间歇性失败
    { stdio: 'ignore', detached: true },
  )

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    try {
      // 负号表示整个进程组。杀不到（已经退了）也无所谓
      process.kill(-chrome.pid, 'SIGKILL')
    } catch {
      if (!chrome.killed) chrome.kill('SIGKILL')
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 清理失败无所谓 */
    }
  }
  process.on('exit', cleanup)

  const wsUrl = await findTarget(cdpPort)
  const conn = connect(wsUrl)
  // 必须等通道就绪，否则最早的几条命令会石沉大海
  await conn.ready

  const send = (method, params = {}) => conn.send(method, params)

  // CDP 响应是双层嵌套：消息的 result 里再包一层 evaluate 的 result。
  //
  // 必须带超时：页面一旦卡住（渲染线程阻塞、脚本死循环），Runtime.evaluate
  // 的 Promise 永远不会 resolve，整个验证脚本会静默挂死、连报错都没有。
  // 这种"没有输出的失败"最难排查，所以宁可超时后明确报错。
  const evalJs = async (expression, timeoutMs = 10000) => {
    const msg = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true }),
      sleep(timeoutMs).then(() => ({ __timeout: true })),
    ])
    if (msg?.__timeout) {
      return { error: `evaluate 超时（${timeoutMs}ms）—— 页面可能卡住了` }
    }
    const payload = msg?.result
    if (payload?.exceptionDetails) {
      return { error: payload.exceptionDetails.exception?.description || 'JS 异常' }
    }
    return { value: payload?.result?.value }
  }

  /** 派发一次键盘事件。游戏监听的是 e.code，所以 code 必须给对。 */
  const key = async (type, code, keyName, vk) => {
    await send('Input.dispatchKeyEvent', {
      type,
      code,
      key: keyName,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    })
  }

  const keyDown = (code, keyName, vk) => key('keyDown', code, keyName, vk)
  const keyUp = (code, keyName, vk) => key('keyUp', code, keyName, vk)

  const close = () => {
    conn.close()
    cleanup()
  }

  return { evalJs, send, keyDown, keyUp, close, port: cdpPort }
}

/**
 * 等待页面**真正**就绪：不只是世界对象建好，玩家还得落到地面上。
 *
 * 原来只等 `window.__world` 存在就返回。但世界建好那一刻，角色往往还在
 * 出生的空中往下掉、地形区块也才铺开一半——这时候开始操作，测试会读到
 * 一堆中间态。表现是**间歇性失败**：机器空闲时没事，负载一高（连续跑
 * 多个 Chrome 实例时很容易）启动慢半拍，就挂。
 *
 * Vite 编译、three 加载、世界构建加起来可能几秒，必须轮询而不是死等。
 */
export async function waitForBoot(evalJs, timeoutSec = 60) {
  for (let i = 0; i < timeoutSec; i++) {
    await sleep(600)
    const boot = await evalJs('typeof window.__world')
    if (boot.value !== 'object') {
      const err = await evalJs('window.__bootError || null')
      if (err.value) throw new Error(`页面启动失败: ${err.value}`)
      continue
    }

    // 世界有了，再确认角色已经站在地上、没有残余的垂直速度
    const settled = await evalJs(`(() => {
      const p = window.__player
      if (!p) return false
      return p.grounded === true && Math.abs(p.velocity.y) < 0.6
    })()`)
    if (settled.value === true) {
      // 再给一帧让地形区块补上，避免开局那一瞬脚下还是空的
      await sleep(400)
      return true
    }
  }
  throw new Error(`等待 ${timeoutSec} 秒后页面仍未就绪`)
}

async function findTarget(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(500)
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

  // 暴露 ready 让 launch 在发送任何命令前先等待通道就绪
  return { ready, send, close: () => ws.close() }
}
