#!/usr/bin/env node
/**
 * 可指定机位与时刻的截图工具。
 *
 * 比 `chrome --screenshot` 灵活的地方在于：它先让页面完整跑起来，
 * 再用 CDP 把相机摆到指定位置、时间拨到指定时刻，然后才截图。
 * 验证水体、昼夜这类"只在特定位置/时段才看得见"的东西时必须这样。
 *
 * 用法：
 *   node tools/shot.mjs <输出.png> [url] [相机规格]
 *
 * 相机规格格式："x,y,z,tx,ty,tz[,mode]"
 *   mode 省略或 fly  = 切成自由飞行并把相机放到 (x,y,z) 看向 (tx,ty,tz)
 *   mode 为 water    = 自动搜索最近的水域并把相机放过去
 */

import { writeFileSync } from 'node:fs'
import { launch, waitForBoot, sleep } from './lib/cdp.mjs'

const out = process.argv[2] || '/tmp/shot.png'
const url = process.argv[3] || 'http://localhost:5173/?freeze=1'
const camSpec = process.argv[4] || ''

const handle = await launch({ url })

try {
  await waitForBoot(handle.evalJs)
  await sleep(3500) // 等地形流式加载成型

  if (camSpec) {
    const parts = camSpec.split(',')
    const mode = parts[6] || 'fly'

    // 切到自由飞行才能手动摆机位：角色模式下第三人称相机会每帧覆盖
    // 相机位置，设好的机位会被立刻冲掉。
    // combat 模式例外——它要的就是第三人称视角。
    if (mode !== 'combat' && mode !== 'player') {
      await handle.evalJs('window.__setMode(false)')
      await sleep(200)
    }

    if (mode === 'water') {
      // 从原点向外螺旋搜索最近的水域，把相机放到水边低空
      const res = await handle.evalJs(`(() => {
        const w = window.__world;
        const hf = w.heightfield;
        const level = w.water.config.level;
        for (let r = 40; r < 1200; r += 20) {
          for (let a = 0; a < 24; a++) {
            const ang = (a / 24) * Math.PI * 2;
            const x = Math.cos(ang) * r;
            const z = Math.sin(ang) * r;
            if (hf.height(x, z) < level - 1.5) {
              return { x, z, r, level };
            }
          }
        }
        return null;
      })()`)

      const spot = res.value
      if (!spot) {
        console.log('⚠️ 在 1200 米范围内没有找到低于水位的地形')
      } else {
        console.log(`找到水域: 距原点 ${spot.r.toFixed(0)} 米, 水位 ${spot.level}`)
        // 站到水边高点，朝水面中心看
        await handle.evalJs(`(() => {
          const w = window.__world;
          w.camera.position.set(${spot.x * 1.25}, ${spot.level + 26}, ${spot.z * 1.25});
          w.camera.lookAt(${spot.x * 0.4}, ${spot.level - 2}, ${spot.z * 0.4});
        })()`)
      }
    } else if (mode === 'player') {
      // 拉近机位看角色细节，用于检查建模
      await handle.evalJs(`(() => {
        const tp = window.__thirdPerson;
        tp.config.distance = 3.0;
        tp.pitch = 0.1;
        // yaw=0 时相机位于 +Z 侧，而角色默认朝 +Z——正好拍到正面。
        // 偏 0.5 弧度留一点侧角，纯正面反而看不出立体感。
        tp.yaw = 0.5;
      })()`)
      await sleep(700)
    } else if (mode === 'ice') {
      const res = await handle.evalJs(`(() => {
        const el = window.__elements;
        const hf = window.__world.heightfield;
        const level = window.__world.water.config.level;
        for (let r = 40; r < 1200; r += 20) {
          for (let a = 0; a < 24; a++) {
            const ang = (a / 24) * Math.PI * 2;
            const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
            if (hf.height(x, z) < level - 3) {
              const frozen = el.freeze(x, z, hf, 18);
              const w = window.__world;
              w.camera.position.set(x + 20, level + 11, z + 20);
              w.camera.lookAt(x, level, z);
              return { x, z, frozen, count: el.iceCount };
            }
          }
        }
        return null;
      })()`)
      if (res.value) console.log(`冻结 ${res.value.frozen} 格，冰面共 ${res.value.count} 格`)
      else console.log('⚠️ 未找到足够深的水域')
      await sleep(700)
    } else if (mode === 'fire') {
      // 在角色周围点几处火，等火势铺开后再俯瞰
      const res = await handle.evalJs(`(() => {
        const el = window.__elements;
        const hf = window.__world.heightfield;
        const p = window.__player;
        el.reset();
        let lit = 0;
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          const x = p.position.x + Math.cos(ang) * 9;
          const z = p.position.z + Math.sin(ang) * 9;
          if (el.ignite(x, z, hf)) lit++;
        }
        return { lit, px: p.position.x, py: p.position.y, pz: p.position.z };
      })()`)

      const spot = res.value
      if (!spot || spot.lit === 0) {
        console.log('⚠️ 点火失败：周围可能没有可燃的草地')
      } else {
        console.log(`点燃了 ${spot.lit} 处，等待火势铺开…`)
        await sleep(5000)
        const burning = await handle.evalJs('window.__elements.burningCount')
        console.log(`燃烧格子数 ${burning.value}`)
        // 贴近地面的视角才能看出火焰的立体感，俯拍只能看到一片三角
        await handle.evalJs(`(() => {
          const w = window.__world;
          w.camera.position.set(${spot.px}, ${spot.py + 5}, ${spot.pz + 17});
          w.camera.lookAt(${spot.px}, ${spot.py + 2}, ${spot.pz});
        })()`)
      }
      await sleep(600)
    } else if (mode === 'combat') {
      // 把最近的敌人挪到角色正前方，让画面里同时出现角色、敌人与心心
      const res = await handle.evalJs(`(() => {
        const p = window.__player;
        const em = window.__enemies;
        const ph = window.__playerHealth;
        if (!em || !ph) return null;
        const alive = em.alive.filter(e => !e.health.isDead);
        if (alive.length === 0) return null;
        // 相机 yaw=0 时位于玩家的 +Z 一侧、朝 -Z 看；要让画面里角色面朝
        // 敌人（+Z 方向），得把相机转到 -Z 一侧，即把它的 yaw 设为 π。
        // 只设 p.yaw 的话角色朝向对了、但相机在敌人那侧，什么也拍不到。
        window.__thirdPerson.yaw = Math.PI;
        p.yaw = 0;
        // 光设 state='idle' 没用：只要玩家在警戒范围内，下一帧就会转 chase
        // 并挤到角色身上叠成一坨。截图时要临时把警戒范围压到最小。
        for (let i = 0; i < Math.min(3, alive.length); i++) {
          const e = alive[i];
          e.position.set(p.position.x + (i - 1) * 3.4, p.position.y, p.position.z + 5.5 + i * 1.2);
          e.velocity.set(0, 0, 0);
          e.config.aggroRange = 0.01;
          e.state = 'idle';
          // 手动让它面向玩家：aggroRange 压到最小后 AI 不再转向，
          // 否则拍到的是后脑勺，看不到眼睛和角
          e.yaw = Math.PI;
        }
        // 留一点伤，让心心显示不是满格
        ph.damage(2, 0.1);
        return { count: Math.min(3, alive.length) };
      })()`)
      if (!res.value) console.log('⚠️ 没有找到可用敌人')
      await sleep(900)

      // 复查一遍：敌人在等待期间可能被 AI 移动或被移除
      const check = await handle.evalJs(`(() => {
        const p = window.__player;
        const em = window.__enemies;
        return {
          playerPos: [+p.position.x.toFixed(1), +p.position.y.toFixed(1), +p.position.z.toFixed(1)],
          camPos: [+window.__world.camera.position.x.toFixed(1), +window.__world.camera.position.y.toFixed(1), +window.__world.camera.position.z.toFixed(1)],
          enemies: em.alive.slice(0, 3).map(e => ({
            pos: [+e.position.x.toFixed(1), +e.position.y.toFixed(1), +e.position.z.toFixed(1)],
            state: e.state,
            dead: e.health.isDead,
            visible: e.object.visible,
          })),
        };
      })()`)
      console.log('诊断:', JSON.stringify(check.value ?? check.error))
    } else {
      const nums = parts.slice(0, 6).map(Number)
      await handle.evalJs(`(() => {
        const w = window.__world;
        w.camera.position.set(${nums[0]}, ${nums[1]}, ${nums[2]});
        w.camera.lookAt(${nums[3]}, ${nums[4]}, ${nums[5]});
      })()`)
    }
  }

  await sleep(2500)

  const shot = await handle.send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.result?.data
  if (!data) {
    console.error('截图失败:', JSON.stringify(shot)?.slice(0, 300))
    process.exit(1)
  }
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`已保存 ${out}`)
} finally {
  handle.close()
}
