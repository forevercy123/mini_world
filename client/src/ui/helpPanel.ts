/**
 * 帮助面板：玩法与操作说明。
 *
 * 做成按需展开而不是常驻的提示条，是因为这个游戏的操作密度已经不低
 * （移动/攀爬/滑翔/战斗/元素五套），常驻提示会一直占着屏幕。
 *
 * 关闭方式给足三种：再点按钮、按 Esc、点面板外的遮罩。玩家打开帮助时
 * 通常只想确认一个按键，不该还要去找关闭按钮在哪。
 */

const SECTIONS: ReadonlyArray<{ title: string; rows: ReadonlyArray<[string, string]> }> = [
  {
    title: '基本操作',
    rows: [
      ['WASD / 方向键', '移动'],
      ['Shift', '奔跑（消耗体力）'],
      ['空格', '跳跃；在空中再按一次展开滑翔伞'],
      ['鼠标左键 / J', '挥舞武器攻击。连点会打出三连击（下劈→斜削→横扫）'],
      ['按住攻击键', '蓄力：半秒后自动放出旋风斩，360° 横扫、伤害 1.8 倍'],
      ['1 ~ 4', '切换武器。不同武器伤害/速度/范围不同，耐久归零会碎'],
      ['Q', '闪避翻滚。朝当前移动方向翻出去，前半段有无敌帧（消耗体力）'],
      ['完美闪避', '敌人攻击落下的瞬间翻滚 → 子弹时间：世界慢下来，你照常输出'],
      ['E', '交谈 / 开宝箱 / 在锅边生火做饭 / 接受神庙祝福'],
      ['F', '点燃身前的草地'],
      ['R', '冻结周围的水面，结成可以行走的冰桥（消耗体力）'],
      ['T', '放电。必须站在水里，电流会顺着水面击倒周围的敌人（消耗体力）'],
      ['V', '起风。吹散周围的火焰；滑翔时顺风能多滑一段（消耗体力）'],
      ['G', '进食：优先吃料理，料理吃完了才吃果子'],
      ['鼠标拖拽', '转动视角'],
      ['滚轮', '拉近 / 拉远'],
      ['H', '显示 / 隐藏性能信息'],
    ],
  },
  {
    title: '武器与战斗',
    rows: [
      ['武器', '野外插着发光的武器，走近自动拔起；宝箱和强敌也会掉'],
      ['耐久', '每次命中消耗 1 点，挥空不耗。快碎时耐久条会变红'],
      ['碎裂', '耐久归零武器当场碎裂，自动切到下一把；全碎了就只能空手'],
      ['猎手弩', '装备后左键放箭。箭走抛物线，远处目标要稍微抬高视角'],
      ['箭捆', '弹药有限，野外的箭捆（+5）和神庙里都有补给'],
      ['连击', '收招后立刻再出手会接下一段：下劈 → 斜削 → 横扫'],
      ['蓄力斩', '按住攻击半秒自动放旋风斩。被围住时这是脱身的招数'],
      ['完美闪避', '读敌人的前摇，攻击落下那一刻按 Q——慢动作里反打'],
      ['格挡', '按住右键举盾。正面攻击完全免伤，侧后挡不住'],
    ],
  },
  {
    title: '神庙',
    rows: [
      ['位置', '荒野四个方向各一座，光柱冲天，老远就能看见'],
      ['试炼', '站上中央石台触发：三波守卫依次现身，全灭即通过'],
      ['祝福', '通过后中央出现宝箱：生命上限 +1（心之容器）和一把好武器'],
      ['封印柱', '试炼中四角升起光柱。打不过可以先跑，神庙不会消失'],
    ],
  },
  {
    title: '打猎与烹饪',
    rows: [
      ['野兽', '鹿、狐狸、兔子见人就跑；狼和野猪会反过来咬你'],
      ['打猎', '追上去砍。野兽掉生肉，跑得快的猎物要预判路线'],
      ['生肉', '生吃只回 1 颗心，下锅才是正经食物'],
      ['篝火', '营地和野外的火堆边都有锅，走近按 E 开火'],
      ['烹饪', '点选食材下锅（最多 3 样），右侧会预览能做出什么'],
      ['配方', '肉+蘑菇=肉菇串、水果+水果=拼盘、向阳果下锅=阳光炖菜（回满）'],
      ['大杂烩', '随便扔几样也能出锅，比生吃划算'],
    ],
  },
  {
    title: '战斗与元素',
    rows: [
      ['火', '点燃身前的草地，火会顺风蔓延'],
      ['冰', '按 R 冻结水面，搭出可走的冰桥'],
      ['电', '按 T 放电，需要站在水里。范围大、伤害高，但得先把敌人引到水边'],
      ['风', '按 V 起风，吹灭火焰；滑翔时用来赶路'],
      ['克制', '火烤化冰、冰封水面、电靠水导电、风吹灭火焰——四者互相牵制'],
    ],
  },
  {
    title: '主线与支线',
    rows: [
      ['当前目标', '屏幕上方常驻，带直线的距离读数'],
      ['导航', '小地图上的金色菱形是目标点，出了地图范围会贴边指方向'],
      ['起点', '出生点旁有一处营地，贤者在篝火边等你'],
      ['支线', '营地附近还有一位樵夫。支线目标会挂在任务栏下方一行'],
      ['采集', '地上的果子、蘑菇、苹果走近自动捡起；发光的武器可以拔走'],
      ['三座祭坛', '火 / 冰 / 风，顺序随意。每座都有一队守卫'],
      ['能力门槛', '冰之祭坛在水边，风之祭坛在高处——能不能到取决于你会不会用对应的能力'],
      ['终点', '集齐三枚封印后封印之门开启，门后是暗蚀骑士'],
    ],
  },
  {
    title: '探索',
    rows: [
      ['攀爬', '走向陡坡会自动开始攀爬：W 向上、S 向下、A/D 横向移动'],
      ['体力', '攀爬、奔跑、游泳、滑翔共用同一管体力，用光就得停下来恢复'],
      ['游泳', '入水自动切换，按空格上浮。体力耗尽会下沉，但不会淹死'],
      ['滑翔', '从高处跳下后按空格展开伞，水平速度比跑步还快'],
    ],
  },
  {
    title: '战斗',
    rows: [
      ['敌人', '靠近小怪会被发现并追击，脱离一定距离后会放弃'],
      ['攻击', '挥剑命中会让敌人闪红、被击退并短暂硬直'],
      ['生命', '左上角是生命值，受击后有一段无敌时间并闪烁'],
      ['火焰', '站在火里会持续掉血——敌人也一样'],
    ],
  },
  {
    title: '物品',
    rows: [
      ['拾取', '走近地上的果子和武器会自动捡起来'],
      ['野莓/苹果', '恢复 1 颗心，也是最常见的下锅食材'],
      ['向阳果', '金色果实，恢复 2 颗心。下锅能炖出回满的阳光炖菜'],
      ['生肉', '打猎所得。生吃 1 颗心，烤熟或下锅更划算'],
      ['料理', '锅里做出来的食物回 3~5 颗心，按 G 优先吃料理'],
      ['小地图', '左下角，显示地形、敌人（红点）、火（橙点）与冰面（白点）'],
    ],
  },
  {
    title: '元素',
    rows: [
      ['蔓延', '火会自行扩散，顺风方向烧得更快'],
      ['地形', '水面、沙滩、裸岩点不着——往水边跑能切断火线'],
      ['上升气流', '火堆上方有气流，展开滑翔伞飞过去会被托起来'],
      ['结冰', '按 R 冻结水面，冰面可以直接走上去；结冰消耗体力'],
      ['克制', '火会把旁边的冰烤化——冰能搭桥，火能拆桥'],
    ],
  },
]

const HINT =
  '试试这些组合：点燃草地 → 爬上山坡 → 滑翔飞过火场乘气流；或者冻出冰桥过河 → 在岸边点火把桥拆掉'

export class HelpPanel {
  private readonly button: HTMLDivElement
  private overlay: HTMLDivElement | null = null

  constructor() {
    this.button = document.createElement('div')
    this.button.id = 'help-button'
    this.button.textContent = '?'
    this.button.title = '玩法说明（Esc 关闭）'
    // 放左下角而不是右下角：lil-gui 调试面板占据右侧整条边、z-index 高达 1001，
    // 之前放在右下角被它完全盖住，玩家根本看不到这个按钮。
    // z-index 也提到 1010，保证即使面板变宽也不会被压住。
    this.button.style.cssText = [
      'position:fixed', 'left:22px', 'bottom:22px', 'width:44px', 'height:44px',
      'border-radius:50%', 'background:rgba(14,24,34,0.82)', 'color:#9fd0f0',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font:600 22px/1 -apple-system,"PingFang SC",system-ui,sans-serif',
      'border:1px solid rgba(120,180,230,0.4)', 'cursor:pointer', 'z-index:1010',
      'user-select:none', 'transition:background 0.18s,transform 0.18s',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    ].join(';')

    this.button.addEventListener('mouseenter', () => {
      this.button.style.background = 'rgba(24,44,64,0.92)'
      this.button.style.transform = 'scale(1.06)'
    })
    this.button.addEventListener('mouseleave', () => {
      this.button.style.background = 'rgba(14,24,34,0.82)'
      this.button.style.transform = 'scale(1)'
    })
    this.button.addEventListener('click', () => this.toggle())

    window.addEventListener('keydown', this.onKeyDown)
    document.body.appendChild(this.button)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.overlay) this.close()
  }

  get isOpen(): boolean {
    return this.overlay !== null
  }

  toggle(): void {
    if (this.overlay) this.close()
    else this.open()
  }

  open(): void {
    if (this.overlay) return

    const overlay = document.createElement('div')
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(4,8,14,0.72)',
      'display:flex', 'align-items:center', 'justify-content:center',
      // 必须高于 lil-gui 的 1001，否则帮助面板会被调试面板切掉一块
      'z-index:1020', 'padding:24px', 'overflow:auto',
    ].join(';')
    // 点遮罩关闭。面板内部的点击不应冒泡到这里。
    overlay.addEventListener('click', () => this.close())

    const panel = document.createElement('div')
    panel.style.cssText = [
      'max-width:620px', 'width:100%', 'max-height:86vh', 'overflow:auto',
      'background:rgba(11,19,27,0.97)', 'border:1px solid rgba(120,170,220,0.28)',
      'border-radius:12px', 'padding:26px 30px', 'color:#cfe3f5',
      'font:13px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif',
      'box-shadow:0 18px 60px rgba(0,0,0,0.6)',
    ].join(';')
    panel.addEventListener('click', (e) => e.stopPropagation())

    const title = document.createElement('h2')
    title.textContent = '玩法说明'
    title.style.cssText =
      'margin:0 0 4px;font-size:19px;font-weight:600;color:#e8f2fb'
    panel.appendChild(title)

    const sub = document.createElement('div')
    sub.textContent = '按 Esc 或点击空白处关闭'
    sub.style.cssText = 'font-size:12px;color:#6d879c;margin-bottom:18px'
    panel.appendChild(sub)

    for (const section of SECTIONS) {
      const h = document.createElement('h3')
      h.textContent = section.title
      h.style.cssText =
        'margin:18px 0 8px;font-size:13px;font-weight:600;color:#7fc4ec;letter-spacing:0.4px'
      panel.appendChild(h)

      const table = document.createElement('div')
      table.style.cssText = 'display:grid;grid-template-columns:150px 1fr;gap:5px 14px'
      for (const [key, desc] of section.rows) {
        const k = document.createElement('div')
        k.textContent = key
        k.style.cssText =
          'color:#9fe0b0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px'
        const d = document.createElement('div')
        d.textContent = desc
        d.style.cssText = 'color:#b8cde0'
        table.appendChild(k)
        table.appendChild(d)
      }
      panel.appendChild(table)
    }

    const hint = document.createElement('div')
    hint.textContent = HINT
    hint.style.cssText = [
      'margin-top:22px', 'padding:12px 14px', 'border-radius:8px',
      'background:rgba(90,150,200,0.14)', 'border-left:3px solid #5a9ac8',
      'color:#bcdcf2', 'font-size:12.5px',
    ].join(';')
    panel.appendChild(hint)

    overlay.appendChild(panel)
    document.body.appendChild(overlay)
    this.overlay = overlay
  }

  close(): void {
    this.overlay?.remove()
    this.overlay = null
  }

  dispose(): void {
    this.close()
    this.button.remove()
    window.removeEventListener('keydown', this.onKeyDown)
  }
}
