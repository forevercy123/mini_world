import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&fresh=1' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3000)
  const res = await handle.evalJs(`(() => {
    const avatar = window.__avatar?.()
    if (!avatar) return { err: 'no avatar' }
    const out = { slots: [], meshes: [] }
    avatar.object.traverse((c) => {
      const n = (c.name || '').toLowerCase()
      if (n.includes('handslot') || n.includes('knife')) {
        const p = new (c.position.constructor)()
        c.getWorldPosition(p)
        out.slots.push({ name: c.name, type: c.type, world: [p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2)], children: c.children.map(k => k.type + ':' + (k.name || 'anon')) })
      }
    })
    return out
  })()`)
  console.log(JSON.stringify(res.value ?? res, null, 2))
} finally { await handle.close() }
