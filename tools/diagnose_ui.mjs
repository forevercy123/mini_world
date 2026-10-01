#!/usr/bin/env node
/**
 * 诊断 UI 元素是否可见、是否被遮挡。
 *
 * `elementFromPoint` 返回的是该坐标处**最上层**的可命中元素，
 * 拿它和元素自身比较就能判断"看得见但点不到"这类遮挡问题。
 *
 * 用法：node tools/diagnose_ui.mjs [url]
 */

import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const url = process.argv[2] || 'http://localhost:4173/'

const handle = await launch({ url })
const { evalJs } = handle

try {
  await waitForBoot(evalJs)
  await sleep(2000)

  const res = await evalJs(`(() => {
    const ids = ['help-button', 'health-hud', 'stamina-ring', 'toast'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) { out[id] = { exists: false }; continue; }
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      out[id] = {
        exists: true,
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        display: style.display,
        opacity: style.opacity,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents,
        topElementAtCenter: top ? (top.id || top.className || top.tagName) : null,
        clickable: top === el || el.contains(top),
      };
    }
    // lil-gui 面板的范围，用于判断是否与右下角重叠
    const gui = document.querySelector('.lil-gui');
    out.__guiPanel = gui
      ? (() => { const r = gui.getBoundingClientRect();
          return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                   zIndex: getComputedStyle(gui).zIndex }; })()
      : null;
    out.__viewport = [window.innerWidth, window.innerHeight];
    return out;
  })()`)

  if (res.error) {
    console.log('查询失败:', res.error)
  } else {
    const d = res.value
    console.log('视口:', d.__viewport.join(' × '))
    console.log('lil-gui 面板:', d.__guiPanel ? `位置 ${d.__guiPanel.rect.join(',')} z-index ${d.__guiPanel.zIndex}` : '未找到')
    console.log('')
    for (const id of ['help-button', 'health-hud', 'stamina-ring', 'toast']) {
      const info = d[id]
      if (!info?.exists) {
        console.log(`❌ #${id}  —— 不存在于 DOM`)
        continue
      }
      const status = info.clickable ? '✅ 可点击' : `⚠️ 被遮挡（顶层是 ${info.topElementAtCenter}）`
      console.log(`${status}  #${id}`)
      console.log(`     位置 ${info.rect.join(',')}  display=${info.display} opacity=${info.opacity} z=${info.zIndex} pointer=${info.pointerEvents}`)
    }
  }
} finally {
  handle.close()
}
