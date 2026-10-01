import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const handle = await launch({ url: 'http://localhost:4173/?freeze=1&hour=10&fresh=1' })
try {
  await waitForBoot(handle.evalJs)
  await sleep(3000)
  await handle.evalJs(`(() => { window.__weaponBag.add('sword1h'); window.__syncWeapon() })()`)
  await sleep(400)
  const res = await handle.evalJs(`(() => {
    const avatar = window.__avatar?.()
    if (!avatar) return { err: 'no avatar' }
    let slot = null
    avatar.object.traverse((c) => {
      if ((c.name || '').toLowerCase() === 'handslotr') slot = c
    })
    if (!slot) return { err: 'no handslot' }
    // 骨骼的世界缩放
    const THREE_V3 = slot.position.constructor
    const ws = new THREE_V3()
    slot.getWorldScale(ws)
    const wp = new THREE_V3()
    slot.getWorldPosition(wp)
    const weapon = slot.children.find(c => c.visible !== false && c.type !== 'Bone')
    let weaponInfo = null
    if (weapon) {
      weapon.updateMatrixWorld(true)
      // 量武器顶点的世界范围
      let min = [1e9,1e9,1e9], max = [-1e9,-1e9,-1e9]
      weapon.traverse((m) => {
        if (!m.isMesh) return
        const pos = m.geometry.attributes.position
        const v = new THREE_V3()
        for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 50))) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
          min = [Math.min(min[0],v.x), Math.min(min[1],v.y), Math.min(min[2],v.z)]
          max = [Math.max(max[0],v.x), Math.max(max[1],v.y), Math.max(max[2],v.z)]
        }
      })
      weaponInfo = {
        worldSize: [max[0]-min[0], max[1]-min[1], max[2]-min[2]].map(v => v.toFixed(3)),
        worldMin: min.map(v => v.toFixed(2)),
        worldMax: max.map(v => v.toFixed(2)),
        localScale: weapon.scale.toArray().map(v => v.toFixed(3)),
      }
    }
    return {
      slotWorldScale: ws.toArray().map(v => v.toFixed(4)),
      slotWorldPos: wp.toArray().map(v => v.toFixed(2)),
      weapon: weaponInfo,
    }
  })()`)
  console.log(JSON.stringify(res.value ?? res, null, 2))
} finally { await handle.close() }
