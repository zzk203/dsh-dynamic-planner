/**
 * 客户端半侧测试 —— 在 Node 里把面板真的渲染成 HTML 再断言。
 *
 * 为什么值得这么做：铁律四是一条"**不许出现什么**"的约束
 * （不许有百分比、进度条、"还剩多少"、"你落后了"），而这类约束最容易
 * 在某天被顺手加上的一个"进度 60%"悄悄破坏 —— 而且不会有任何报错。
 * 把面板渲染出来搜这些词，是唯一能长期守住它的办法。
 *
 * React 从 profile 的 node_modules 解析；解析不到就整组 skip，
 * 不会把"环境里没有 React"变成假红。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'

// ───────────────────────── 加载被测模块 ─────────────────────────

let React = null
let renderToStaticMarkup = null
try {
  React = (await import('react')).default
  const server = await import('react-dom/server')
  renderToStaticMarkup = server.renderToStaticMarkup ?? server.default?.renderToStaticMarkup
} catch { /* 环境里没有 React，整组 skip */ }

const missing = React === null || typeof renderToStaticMarkup !== 'function'

/** 在假浏览器环境里加载 client.js，取回它交给模块加载器的那份定义。 */
function loadClientModule() {
  let captured = null
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { captured = spec },
    },
  }
  try {
    // client.js 没有任何 import，所以可以直接把源码当脚本求值
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    // eslint-disable-next-line no-new-func
    new Function('window', source)(globalThis.window)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.ok(captured, 'client.js 应该调用 window.__ModuleLoader__.load')
  return captured
}

function buildModule() {
  const spec = loadClientModule()
  assert.equal(spec.id, 'dsh-dynamic-planner')
  const exported = spec.factory(name => {
    if (name === 'react') return React
    throw new Error(`client.js 请求了未约定的模块：${name}`)
  })
  return { spec, exported }
}

/** 假 ctx，记录插槽注册与 effect。 */
function fakeCtx() {
  const record = { slots: [], effects: [], styleTags: [] }
  const ctx = {
    slots: {
      inject(name, callback) { record.slots.push({ via: 'inject', name }); callback() },
      register(options, component) { record.slots.push({ via: 'register', options, component }) },
    },
    effect(callback, name) {
      record.effects.push({ name })
      return callback()
    },
  }
  return { ctx, record }
}

/** 假 document，只够让样式注入跑起来。 */
function withFakeDocument(run) {
  const previous = globalThis.document
  const tags = []
  globalThis.document = {
    head: {
      appendChild(tag) { tags.push(tag) },
    },
    createElement() {
      return {
        textContent: '',
        setAttribute(key, value) { this[key] = value },
        remove() { this.removed = true },
      }
    },
  }
  try {
    return run(tags)
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

const html = element => renderToStaticMarkup(element)
const h = (...args) => React.createElement(...args)

// ───────────────────────── 注册 ─────────────────────────

describe('客户端插件注册', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  it('模块 id 等于包名，且硬依赖 slots', () => {
    const { spec, exported } = buildModule()
    assert.equal(spec.id, 'dsh-dynamic-planner')
    assert.deepEqual(exported.inject, ['slots'])
  })

  it('侧边栏入口的 id 与中央面板的 key 一致（不一致的话点击图标不会有反应）', () => {
    const { exported } = buildModule()
    const { ctx, record } = fakeCtx()
    withFakeDocument(() => exported.apply(ctx))
    const panellist = record.slots.find(entry => entry.via === 'register' && entry.options.name === 'sidebar.panellist')
    const main = record.slots.find(entry => entry.via === 'register' && entry.options.name === 'main')
    assert.ok(panellist, '应注册 sidebar.panellist')
    assert.ok(main, '应注册 main')
    assert.equal(panellist.options.id, 'planner')
    assert.equal(main.options.key, 'planner')
    assert.equal(main.options.key, panellist.options.id)
  })

  it('注入样式，并在释放时把 style 标签摘掉', () => {
    const { exported } = buildModule()
    const tags = []
    const effectNames = []
    const disposers = []
    const previous = globalThis.document
    globalThis.document = {
      head: { appendChild: (tag) => tags.push(tag) },
      createElement: () => ({
        textContent: '',
        setAttribute(key, value) { this[key] = value },
        remove() { this.removed = true },
      }),
    }
    try {
      exported.apply({
        slots: { inject: () => {}, register: () => {} },
        effect(callback, name) {
          effectNames.push(name)
          const off = callback()
          if (typeof off === 'function') disposers.push(off)
        },
      })
    } finally {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    }

    assert.equal(tags.length, 1, '应恰好注入一个 style 标签')
    assert.equal(tags[0]['data-plugin'], 'dsh-dynamic-planner', 'style 标签要带 data-plugin，外壳靠它清理')
    assert.match(tags[0].textContent, /\.pl-root/, 'CSS 内容应真的写进去了')
    assert.ok(effectNames.every(name => name.startsWith('dsh-dynamic-planner:')),
      `effect 名字都要带命名空间：${effectNames.join(', ')}`)

    disposers.forEach(off => off())
    assert.equal(tags[0].removed, true, '释放时应摘掉 style 标签')
  })

  it('模块加载阶段不碰 document（工厂必须无副作用）', () => {
    const previous = globalThis.document
    globalThis.document = new Proxy({}, {
      get(_target, key) { throw new Error(`模块加载阶段就访问了 document.${String(key)}`) },
    })
    try {
      const spec = loadClientModule()
      assert.ok(spec, '构建模块本身不该产生副作用')
    } finally {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    }
  })
})

// ───────────────────────── 侧边栏图标 ─────────────────────────

describe('侧边栏图标', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  it('渲染成 svg，并采用外壳给的尺寸', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.Icon, { size: 22 }))
    assert.match(markup, /<svg/)
    assert.match(markup, /width="22"/)
  })
})

// ───────────────────────── 计划项 ─────────────────────────

describe('计划项', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  const item = {
    id: 'item_1', title: '背 10 个单词', estimateMin: 10,
    goalId: 'goal_1', goalTitle: '学英语', status: 'pending', note: '', reason: '',
  }

  it('显示标题、预估耗时与目标标签', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.ItemRow, { item, onPatch: async () => {} }))
    assert.match(markup, /背 10 个单词/)
    assert.match(markup, /10 分钟/)
    assert.match(markup, /学英语/)
  })

  it('独立待办不挂目标标签（没有归属就不该编一个出来）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.ItemRow, {
      item: { ...item, goalId: null, goalTitle: null }, onPatch: async () => {},
    }))
    assert.ok(!markup.includes('学英语'))
  })

  it('已完成时复选框是勾上的', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.ItemRow, {
      item: { ...item, status: 'done' }, onPatch: async () => {},
    }))
    assert.match(markup, /checked=""/)
  })

  it('把 LLM 追问出的未完成原因显示出来', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.ItemRow, {
      item: { ...item, status: 'missed', reason: '下班太晚' }, onPatch: async () => {},
    }))
    assert.match(markup, /下班太晚/)
  })

  it('备注框不预设方向：placeholder 里不出现任何标签式引导', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.ItemRow, { item, onPatch: async () => {} }))
    assert.match(markup, /placeholder="备注（可选）"/)
    for (const banned of ['填写原因', '没时间', '未完成原因']) {
      assert.ok(!markup.includes(banned), `备注框不该引导「${banned}」`)
    }
  })
})

// ───────────────────────── 今日视图 ─────────────────────────

describe('今日视图', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  it('没有计划时，告诉用户去对话里排计划（这是唯一的触发路径）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: { date: '2026-09-30', plan: null }, onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /排今天的计划/)
  })

  it('有计划时逐条渲染，并带上随手添加的入口', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: {
        date: '2026-09-30',
        plan: {
          items: [
            { id: 'i1', title: '背单词', estimateMin: 10, goalTitle: '学英语', status: 'done', note: '', reason: '' },
            { id: 'i2', title: '给妈妈打电话', estimateMin: 15, goalTitle: null, status: 'pending', note: '', reason: '' },
          ],
        },
      },
      onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /背单词/)
    assert.match(markup, /给妈妈打电话/)
    assert.match(markup, /随手加一条待办/)
  })

  it('§5.2：默认只呈现今日，不把历史未完成项摊在面板上', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: {
        date: '2026-09-30',
        plan: { items: [{ id: 'i1', title: '今天的事', estimateMin: 10, status: 'pending', note: '', reason: '' }] },
        pendingBefore: [{ id: 'p1', date: '2026-09-29', title: '昨天没做的' }],
      },
      onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /今天的事/)
    assert.ok(!markup.includes('昨天没做的'), '历史未完成项由对话去追问，不该出现在今日面板')
  })
})

// ───────────────────────── 目标总览 ─────────────────────────

describe('目标总览（二级视图）', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  it('有期限目标显示完成标准、截止日与节奏判断', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.GoalCard, {
      goal: {
        id: 'g1', title: '跑 10 公里', criteria: '能独立跑完 10 公里', mode: 'deadline',
        status: 'active', deadline: '2026-11-01', poolTaskCount: 3, doneTaskCount: 1, momentum: null,
        pace: { daysLeft: 32, openTaskCount: 3, remainingMinutes: 180, recentDailyMinutes: 12, willMiss: true },
      },
    }))
    assert.match(markup, /能独立跑完 10 公里/)
    assert.match(markup, /截止 2026-11-01/)
    assert.match(markup, /剩 32 天/)
    assert.match(markup, /赶不上/)
  })

  it('铁律四：长期目标未达积累门槛时，什么都不显示', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.GoalCard, {
      goal: {
        id: 'g2', title: '学英语', criteria: '能看无字幕剧', mode: 'longterm', status: 'active',
        deadline: null, poolTaskCount: 0, doneTaskCount: 0, pace: null,
        momentum: { total: 3, streak: 3, visible: false, nextMilestone: 5 },
      },
    }))
    assert.match(markup, /学英语/)
    assert.ok(!markup.includes('已坚持'), '未达门槛不该出现积累提示')
    assert.ok(!markup.includes('累计'), '未达门槛不该出现累计')
    assert.ok(!/\b3\b/.test(markup.replace(/g2/g, '')), '未达门槛不该泄露具体次数')
  })

  it('铁律四：达到门槛才显示正向积累', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.GoalCard, {
      goal: {
        id: 'g2', title: '学英语', criteria: '能看无字幕剧', mode: 'longterm', status: 'active',
        deadline: null, poolTaskCount: 0, doneTaskCount: 0, pace: null,
        momentum: { total: 12, streak: 7, visible: true, nextMilestone: 15 },
      },
    }))
    assert.match(markup, /已坚持 7 天/)
    assert.match(markup, /累计 12 次/)
  })

  it('空目标列表给出引导，而不是一片空白', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.GoalsView, { goals: [] }))
    assert.match(markup, /还没有目标/)
  })
})

// ───────────────────────── 顶层组件 ─────────────────────────

describe('顶层组件 Panel', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  it('首帧不崩，且显示"读取中"而不是会被误读的假结论', () => {
    const { exported } = buildModule()
    // useState 的初始值在 SSR 下就是首帧真实状态：state 还没拿到
    const markup = html(h(exported.__internals.Panel))
    assert.match(markup, /日程表/, '标题')
    assert.match(markup, /读取中/, '首帧该说在读，而不是"今天还没有计划"')
    assert.ok(!markup.includes('今天还没有计划'), '数据没到之前不该下这个结论')
    assert.match(markup, /今天/)
    assert.match(markup, /目标/)
  })

  it('两个页签都在，且按钮可点（不是 disabled 的死界面）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.Panel))
    const buttons = markup.match(/<button/g) ?? []
    assert.ok(buttons.length >= 3, `至少有 刷新/今天/目标 三个按钮，实际 ${buttons.length}`)
    assert.ok(!/<button[^>]*disabled/.test(markup), '首帧不该有被禁用的按钮挡住用户')
  })
})

// ───────────────────────── 铁律四全局守卫 ─────────────────────────

describe('铁律四全局守卫', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  /** 把所有组件用最"容易泄露进度"的数据渲染一遍，拼成一大段 HTML。 */
  function renderEverything() {
    const { exported } = buildModule()
    const { ItemRow, QuickAdd, TodayView, GoalCard, GoalsView } = exported.__internals
    const parts = [
      h(ItemRow, {
        item: {
          id: 'i1', title: '背单词', estimateMin: 10, goalTitle: '学英语',
          status: 'pending', note: '写了点备注', reason: '',
        },
        onPatch: async () => {},
      }),
      h(QuickAdd, { onAdd: async () => {} }),
      h(TodayView, {
        today: {
          date: '2026-09-30',
          plan: { items: [{ id: 'i1', title: '背单词', estimateMin: 10, goalTitle: '学英语', status: 'pending', note: '', reason: '' }] },
        },
        onRefresh: async () => {}, onError: () => {},
      }),
      h(GoalsView, {
        goals: [
          {
            id: 'g1', title: '跑 10 公里', criteria: '能跑完', mode: 'deadline', status: 'active',
            deadline: '2026-11-01', poolTaskCount: 3, doneTaskCount: 1, momentum: null,
            pace: { daysLeft: 32, openTaskCount: 3, remainingMinutes: 180, recentDailyMinutes: 12, willMiss: true },
          },
          {
            id: 'g2', title: '学英语', criteria: '能看无字幕剧', mode: 'longterm', status: 'active',
            deadline: null, poolTaskCount: 0, doneTaskCount: 0, pace: null,
            momentum: { total: 12, streak: 7, visible: true, nextMilestone: 15 },
          },
        ],
      }),
    ]
    return parts.map(part => html(part)).join('\n')
  }

  it('渲染出的 HTML 里不含任何百分比', () => {
    const markup = renderEverything()
    assert.ok(!markup.includes('%'), `面板里不该出现百分比：${markup.slice(0, 400)}`)
    assert.ok(!markup.includes('％'), '面板里不该出现全角百分比')
  })

  it('渲染出的 HTML 里不含落后/剩余进度类措辞', () => {
    const markup = renderEverything()
    for (const banned of ['落后', '还差', '进度条', '完成度', '未达标', '剩余进度']) {
      assert.ok(!markup.includes(banned), `面板里不该出现「${banned}」`)
    }
  })

  it('长期目标的展示里不含速度/超期类措辞（那是 deadline 目标才有的东西）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.GoalCard, {
      goal: {
        id: 'g2', title: '学英语', criteria: '能看无字幕剧', mode: 'longterm', status: 'active',
        deadline: null, poolTaskCount: 5, doneTaskCount: 0, pace: null,
        momentum: { total: 2, streak: 2, visible: false, nextMilestone: 5 },
      },
    }))
    for (const banned of ['赶不上', '超期', '来不及', '剩 ']) {
      assert.ok(!markup.includes(banned), `长期目标不该出现「${banned}」`)
    }
  })
})

// ───────────────────────── 随手添加的结果必须看得见 ─────────────────────────

describe('随手添加的待办必须出现在面板上', { skip: missing ? '环境里没有 react / react-dom' : false }, () => {
  const todayWithPool = {
    date: '2026-09-30',
    plan: { items: [{ id: 'i1', title: '背单词', estimateMin: 10, status: 'pending', note: '', reason: '' }] },
    pool: [
      { id: 't1', title: '吃维生素d', estimateMin: 15, goalId: null, goalTitle: null },
      { id: 't2', title: '预约体检', estimateMin: 20, goalId: 'g1', goalTitle: '健康' },
    ],
  }

  it('池里的条目要渲染出来 —— 否则"随手添加"点了之后屏幕上什么都没发生', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: todayWithPool, onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /吃维生素d/, '刚添加的待办必须立刻可见')
    assert.match(markup, /预约体检/)
    assert.match(markup, /15 分钟/)
  })

  it('区块标题要说明它们还没排进今天，而不是混进今日计划里骗人', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: todayWithPool, onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /还没排进今天/)
  })

  it('告诉用户下一步该怎么办（只有对话能排计划）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: todayWithPool, onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /排今天的计划/)
  })

  it('池为空时不渲染这个区块（不要留一个空标题）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: { date: '2026-09-30', plan: { items: [] }, pool: [] },
      onRefresh: async () => {}, onError: () => {},
    }))
    assert.ok(!markup.includes('还没排进今天'))
  })

  it('池里的条目带目标标签时显示出来（与今日计划里的呈现一致）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: todayWithPool, onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /健康/)
  })

  it('添加框仍然在（回归：别为了修这个把入口弄丢了）', () => {
    const { exported } = buildModule()
    const markup = html(h(exported.__internals.TodayView, {
      today: todayWithPool, onRefresh: async () => {}, onError: () => {},
    }))
    assert.match(markup, /随手加一条待办/)
  })
})
