/**
 * NPC。
 *
 * 外观直接复用 ModelAvatar——它已经把"加载 glTF / 归一化身高 / 换 Lambert
 * 材质 / 按名字挑动画"这套流程写完了，NPC 和玩家在这几件事上没有区别，
 * 区别只在于**谁决定位置和朝向**：玩家由控制器驱动，NPC 站桩，只把脸转向
 * 靠近的人。
 *
 * 朝向要平滑插值。直接 `yaw = atan2(...)` 的话，玩家从身前绕到背后时
 * NPC 会瞬间拧过去，像一具被线拽着的木偶。
 */

import { Group, Vector3 } from 'three'
import { ModelAvatar } from '../gameplay/modelAvatar.ts'
import type { Heightfield } from '../terrain/heightfield.ts'

/** 进入这个距离才能对话 */
export const TALK_RANGE = 4.5
/** 转向速度（弧度/秒） */
const TURN_SPEED = 4

export interface NpcDef {
  id: string
  /** 显示名，对话时挂在名字条上 */
  name: string
  /** 模型路径 */
  model: string
  /** 世界坐标 */
  x: number
  z: number
  /** 初始朝向；省略表示出生时面向原点 */
  yaw?: number
}

export class Npc {
  readonly group = new Group()
  readonly position = new Vector3()

  private avatar: ModelAvatar | null = null
  private yaw = 0

  private constructor(readonly def: NpcDef) {}

  static async load(def: NpcDef, terrain: Heightfield): Promise<Npc | null> {
    const npc = new Npc(def)
    // 每个 NPC 用自己的节点名，避免和玩家（以及彼此）撞名
    const avatar = await ModelAvatar.load(def.model, undefined, `npc-${def.id}`)
    if (!avatar) return null

    npc.avatar = avatar
    npc.position.set(def.x, terrain.height(def.x, def.z), def.z)
    npc.yaw = def.yaw ?? Math.atan2(-def.x, -def.z)
    avatar.update(npc.position, npc.yaw, 0, { grounded: true, speed: 0, state: 'ground' })
    npc.group.add(avatar.object)
    return npc
  }

  get isReady(): boolean {
    return this.avatar !== null
  }

  /** 玩家是否站在可以对话的距离内 */
  canTalk(playerPos: Vector3): boolean {
    const dx = playerPos.x - this.position.x
    const dz = playerPos.z - this.position.z
    if (dx * dx + dz * dz > TALK_RANGE * TALK_RANGE) return false
    // 高度也要接近：NPC 在山顶时，站在崖底的玩家不该够得着
    return Math.abs(playerPos.y - this.position.y) < 4
  }

  update(dt: number, playerPos: Vector3): void {
    if (!this.avatar) return

    const dx = playerPos.x - this.position.x
    const dz = playerPos.z - this.position.z
    if (dx * dx + dz * dz < 24 * 24) {
      const target = Math.atan2(dx, dz)
      let delta = target - this.yaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta <= -Math.PI) delta += Math.PI * 2
      const step = TURN_SPEED * dt
      this.yaw += Math.abs(delta) < step ? delta : Math.sign(delta) * step
    }

    // 待机状态：speed 为 0，ModelAvatar 会自己播 Idle
    this.avatar.update(this.position, this.yaw, dt, {
      grounded: true,
      speed: 0,
      state: 'ground',
    })
  }

  dispose(): void {
    this.avatar?.dispose()
    this.avatar = null
  }
}

/** 贤者的台词。分页给，一页一句，符合塞尔达的节奏 */
export const SAGE_INTRO = [
  { speaker: '贤者', text: '你终于醒了。能自己站起来，说明光还没有完全离开这片土地。' },
  { speaker: '贤者', text: '这里是光之大陆。三百年来，四座元素祭坛的火种一直照看着它。' },
  { speaker: '贤者', text: '但如今，三座祭坛的火种已经熄灭。没有它们，封印之门撑不了多久。' },
  { speaker: '贤者', text: '门后锁着暗蚀之源。门一破，整片大陆都会沉进黑里。' },
  { speaker: '贤者', text: '去把三枚封印带回来——火、冰、风。祭坛散在大陆各处，你能找到的。' },
  { speaker: '贤者', text: '路上小心。暗蚀的爪牙已经渗进草原，它们会认得出你。' },
] as const

/** 每次回来复述一遍进度，玩家不用记 */
export function sageProgress(collected: number, total: number): string {
  if (collected === 0) return '三座祭坛还在等你。先去哪一座都行。'
  if (collected >= total) return '三枚封印都齐了。去封印之门，把它们放回去。'
  return `你已经带回了 ${collected} 枚封印，还差 ${total - collected} 枚。`
}
