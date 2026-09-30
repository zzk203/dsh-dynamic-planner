/**
 * 工具集测试 —— 测试先于实现。
 *
 * `defineTool` 与数据存取都从外部注入，所以这里不需要解析 `@deepseek-ai/*`，
 * 也就不会把"源码目录解析不到 shipped package"变成测试的假失败。
 *
 * 另外有一组"真 schema"测试：只有在真的能 import 到 shipped 的 `defineTool`
 * 时才运行（本地源码目录会 skip，装进 profile 后会真正跑起来）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { buildTools } from '../lib/tools.js'

// ───────────────────────── 测试替身 ─────────────────────────

/** `defineTool` 的忠实替身：原样返回定义，保留 schema 编译前的一切。 */
const stubDefineTool = options => ({ ...options })

/** 内存版 store，形状与 createStore 一致但不碰磁盘。 */
function memoryStore(seed = { goals: [], tasks: [], plans: [] }) {
  const data = seed
  return {
    data,
    read: () => data,
    update(fn) { return fn(data) },
  }
}

/** 固定的测试时钟。工具取"今天"走注入的 now，测试因此完全确定，不追真实日期。 */
const TODAY = '2026-05-10'

function toolsFor(store, now = () => TODAY) {
  return buildTools({ defineTool: stubDefineTool, store, now })
}

function toolNamed(tools, name) {
  const tool = tools.find(entry => entry.name === name)
  assert.ok(tool, `缺少工具 ${name}`)
  return tool
}

/**
 * 直接往数据里种一条"往日"计划。
 *
 * 刻意不走 plan_write：那条路对往日是**故意关闭**的（P4 构成冻结），
 * 所以夹具必须直接种数据，而不是绕过规则去造昨天的计划 ——
 * 否则这个测试会悄悄依赖一个不该存在的能力。
 */
function seedPastPlan(store, date, title, estimateMin = 20) {
  const plan = {
    date,
    generatedAt: new Date().toISOString(),
    items: [{
      id: `item_seed_${date}`, taskId: null, title, goalId: null, estimateMin,
      status: 'pending', completedAt: null, note: '', reason: '',
    }],
  }
  store.data.plans.push(plan)
  store.data.plans.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return plan
}

/** 把 render 的输出拼成一段可断言的文本。 */
function renderText(tool, args, value) {
  const blocks = tool.output.render(args, value)
  return blocks.map(block => block.text ?? '').join('\n')
}

/** ESM 下只有真能解析到才跑真 schema 校验。 */
let realDefineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  realDefineTool = mod.defineTool ?? null
} catch { /* 源码目录解析不到，属于预期 */ }

// ───────────────────────── 工具集契约 ─────────────────────────

describe('工具集契约', () => {
  it('恰好注册 9 个工具', () => {
    assert.equal(toolsFor(memoryStore()).length, 9)
  })

  it('工具名唯一', () => {
    const names = toolsFor(memoryStore()).map(tool => tool.name)
    assert.equal(new Set(names).size, names.length)
  })

  it('不占用 DSH 自带插件的工具名（重名会让注册直接抛错）', () => {
    const names = toolsFor(memoryStore()).map(tool => tool.name)
    const reserved = ['schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update', 'todo_write']
    for (const name of reserved) assert.ok(!names.includes(name), `别占用 ${name}`)
  })

  it('每个工具都有非空描述、参数对象、输出 schema 与可渲染的 render', () => {
    for (const tool of toolsFor(memoryStore())) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0, '名字')
      assert.ok(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} 描述太短或缺失`)
      assert.ok(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name} 缺少 parameters`)
      assert.ok(tool.output?.schema, `${tool.name} 缺少 output.schema`)
      const blocks = tool.output.render({}, { ok: true })
      assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name} 的 render 没有产出内容块`)
      assert.equal(blocks[0].type, 'text')
    }
  })

  it('§6.3 缓存纪律：工具定义必须与数据无关（两次不同数据构建出字节一致的定义）', () => {
    const empty = toolsFor(memoryStore())
    const populated = toolsFor(memoryStore({
      goals: [{ id: 'goal_1', title: '学英语', mode: 'longterm', status: 'active' }],
      tasks: [{ id: 'task_1', title: '背单词', status: 'pool', estimateMin: 20, goalId: 'goal_1' }],
      plans: [{ date: '2026-05-09', items: [{ id: 'item_1', title: 'x', estimateMin: 10, status: 'done' }] }],
    }))
    // 只比 schema 面（name/description/parameters），execute 是函数必然不同引用
    const schemaFace = tools => tools.map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    }))
    assert.deepEqual(schemaFace(empty), schemaFace(populated))
  })

  it('工具名都落在规划器自己的命名空间里', () => {
    for (const tool of toolsFor(memoryStore())) {
      assert.ok(
        tool.name.startsWith('plan_') || tool.name.startsWith('goal_') || tool.name.startsWith('task_'),
        `${tool.name} 的前缀不在 plan_/goal_/task_ 里`,
      )
    }
  })
})

// ───────────────────────── plan_context：排计划的一次性输入 ─────────────────────────

describe('plan_context：排计划的输入（§4.3）', () => {
  function seeded() {
    const store = memoryStore()
    const tools = toolsFor(store)
    const goalSave = toolNamed(tools, 'goal_save')
    const taskSave = toolNamed(tools, 'task_save')
    const planWrite = toolNamed(tools, 'plan_write')
    const itemUpdate = toolNamed(tools, 'plan_item_update')
    return { store, tools, goalSave, taskSave, planWrite, itemUpdate }
  }

  it('给出今日计划、未完成历史项与池', async () => {
    const { store, tools } = seeded()
    seedPastPlan(store, '2026-05-09', '昨天没做的')
    const context = toolNamed(tools, 'plan_context')
    const value = await context.execute({ date: '2026-05-10' }, {})
    assert.equal(value.date, '2026-05-10')
    assert.equal(value.todayPlan, null)
    assert.deepEqual(value.pendingBefore.map(item => item.title), ['昨天没做的'])
  })

  it('长期目标只给动量，有期限目标只给速度（铁律四在工具层的守卫）', async () => {
    const { tools, goalSave } = seeded()
    await goalSave.execute({ title: '学英语', mode: 'longterm', criteria: '能看无字幕剧' }, {})
    await goalSave.execute({ title: '跑 10 公里', mode: 'deadline', deadline: '2026-06-01', criteria: '能跑完' }, {})
    const value = await toolNamed(tools, 'plan_context').execute({ date: '2026-05-10' }, {})
    const longterm = value.goals.find(goal => goal.title === '学英语')
    const deadline = value.goals.find(goal => goal.title === '跑 10 公里')
    assert.notEqual(longterm.momentum, null)
    assert.equal(longterm.pace, null)
    assert.notEqual(deadline.pace, null)
    assert.equal(deadline.momentum, null)
  })

  it('给出供 LLM 追问的靶子（已判 missed 但还没说原因）', async () => {
    const { store, tools, itemUpdate } = seeded()
    const plan = seedPastPlan(store, '2026-05-09', '没做的')
    // 往日的条目允许改状态 —— 用户可能当时忘了勾，第二天才回填
    await itemUpdate.execute({ date: '2026-05-09', itemId: plan.items[0].id, status: 'missed' }, {})
    const value = await toolNamed(tools, 'plan_context').execute({ date: '2026-05-10' }, {})
    assert.deepEqual(value.unexplained.map(item => item.title), ['没做的'])
  })

  it('默认日期是本地今天', async () => {
    // 这一个用例刻意不注入时钟：验证生产默认值确实落在本地今天
    const store = memoryStore()
    const tools = buildTools({ defineTool: stubDefineTool, store })
    const value = await toolNamed(tools, 'plan_context').execute({}, {})
    const now = new Date()
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    assert.equal(value.date, expected)
  })

  it('渲染成可读文本且不抛错', async () => {
    const { tools, goalSave } = seeded()
    await goalSave.execute({ title: '学英语', mode: 'longterm' }, {})
    const tool = toolNamed(tools, 'plan_context')
    const value = await tool.execute({ date: '2026-05-10' }, {})
    const text = renderText(tool, { date: '2026-05-10' }, value)
    assert.ok(text.includes('2026-05-10'))
  })
})

// ───────────────────────── 目标工具 ─────────────────────────

describe('目标工具', () => {
  it('goal_save 创建后返回 id，并把用户的原始模糊说法记下来', async () => {
    const tools = toolsFor(memoryStore())
    const value = await toolNamed(tools, 'goal_save').execute(
      { title: '学英语', mode: 'longterm', criteria: '能看无字幕剧', rawInput: '我想学英语' }, {},
    )
    assert.ok(value.id.startsWith('goal_'))
    assert.equal(value.title, '学英语')
    assert.equal(value.criteria, '能看无字幕剧')
    assert.equal(value.rawInput, '我想学英语')
    assert.equal(value.mode, 'longterm')
  })

  it('创建时缺 title → 明确报错，而不是落一个"未命名目标"', async () => {
    const tools = toolsFor(memoryStore())
    await assert.rejects(
      () => toolNamed(tools, 'goal_save').execute({ mode: 'longterm' }, {}),
      /title/,
    )
  })

  it('带 id 的调用是更新，不会新建第二个目标', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const goalSave = toolNamed(tools, 'goal_save')
    const created = await goalSave.execute({ title: '学英语', mode: 'longterm' }, {})
    const updated = await goalSave.execute({ id: created.id, mode: 'deadline', deadline: '2026-06-01' }, {})
    assert.equal(updated.id, created.id)
    assert.equal(store.data.goals.length, 1)
    assert.equal(updated.mode, 'deadline')
  })

  it('更新不存在的目标 → 报错而不是悄悄新建', async () => {
    const tools = toolsFor(memoryStore())
    await assert.rejects(
      () => toolNamed(tools, 'goal_save').execute({ id: 'goal_nope', title: 'x' }, {}),
      /不存在/,
    )
  })

  it('铁律一：goal_complete 必须带 confirmedByUser=true', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const created = await toolNamed(tools, 'goal_save').execute({ title: '学英语', mode: 'longterm' }, {})
    await assert.rejects(
      () => toolNamed(tools, 'goal_complete').execute({ id: created.id, confirmedByUser: false }, {}),
      /用户确认/,
    )
    assert.equal(store.data.goals[0].status, 'active')
  })

  it('铁律一：确认后可以标记完成', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const created = await toolNamed(tools, 'goal_save').execute({ title: '学英语', mode: 'longterm' }, {})
    const value = await toolNamed(tools, 'goal_complete').execute({ id: created.id, confirmedByUser: true }, {})
    assert.equal(value.status, 'done')
  })
})

// ───────────────────────── 任务工具 ─────────────────────────

describe('任务工具', () => {
  it('task_save 新建池任务', async () => {
    const tools = toolsFor(memoryStore())
    const value = await toolNamed(tools, 'task_save').execute({ title: '背单词', estimateMin: 20 }, {})
    assert.ok(value.id.startsWith('task_'))
    assert.equal(value.estimateMin, 20)
  })

  it('task_add_batch 批量拆解（§4.2 滚动拆解的落点）', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const goal = await toolNamed(tools, 'goal_save').execute({ title: '学英语', mode: 'longterm' }, {})
    const value = await toolNamed(tools, 'task_add_batch').execute({
      goalId: goal.id,
      tasks: [
        { title: '词汇', estimateMin: 10, difficulty: 'tiny' },
        { title: '听力', estimateMin: 10, difficulty: 'tiny' },
        { title: '口语', estimateMin: 5, difficulty: 'tiny' },
      ],
    }, {})
    assert.equal(value.added.length, 3)
    assert.equal(store.data.tasks.length, 3)
    assert.ok(store.data.tasks.every(task => task.goalId === goal.id))
  })

  it('task_add_batch 拒绝空数组（空拆解多半是 LLM 搞错了）', async () => {
    const tools = toolsFor(memoryStore())
    await assert.rejects(() => toolNamed(tools, 'task_add_batch').execute({ tasks: [] }, {}), /至少/)
  })
})

// ───────────────────────── 计划工具 ─────────────────────────

describe('计划工具', () => {
  it('plan_write 写入今日计划并回填 id', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const value = await toolNamed(tools, 'plan_write').execute({
      date: '2026-05-10',
      items: [
        { title: '背单词', estimateMin: 15 },
        { title: '慢跑', estimateMin: 30 },
      ],
    }, {})
    assert.equal(value.items.length, 2)
    assert.ok(value.items.every(item => item.id.startsWith('item_')))
    assert.ok(value.items.every(item => item.status === 'pending'))
  })

  it('plan_write 把任务排进计划后，它不再出现在池里', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const task = await toolNamed(tools, 'task_save').execute({ title: '背单词', estimateMin: 20 }, {})
    await toolNamed(tools, 'plan_write').execute({
      date: '2026-05-10',
      items: [{ taskId: task.id, title: '背单词', estimateMin: 20 }],
    }, {})
    const context = await toolNamed(tools, 'plan_context').execute({ date: '2026-05-10' }, {})
    assert.deepEqual(context.pool, [])
  })

  it('plan_write 往日必被拒（P4 构成冻结），报错要说清能改什么', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    await assert.rejects(
      () => toolNamed(tools, 'plan_write').execute({ date: '2020-01-01', items: [{ title: 'x', estimateMin: 10 }] }, {}),
      /冻结/,
    )
  })

  it('plan_write 拒绝空 items（防把今天清空当成排计划）', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    await assert.rejects(
      () => toolNamed(tools, 'plan_write').execute({ date: '2099-01-01', items: [] }, {}),
      /至少/,
    )
  })

  it('plan_item_update 勾选完成后回流任务池', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const task = await toolNamed(tools, 'task_save').execute({ title: '背单词', estimateMin: 20 }, {})
    const plan = await toolNamed(tools, 'plan_write').execute({
      date: '2026-05-10',
      items: [{ taskId: task.id, title: '背单词', estimateMin: 20 }],
    }, {})
    const value = await toolNamed(tools, 'plan_item_update').execute({
      date: '2026-05-10', itemId: plan.items[0].id, status: 'done',
    }, {})
    assert.equal(value.status, 'done')
    assert.equal(store.data.tasks[0].status, 'done')
  })

  it('plan_item_update 能写回未完成原因（第二天追问后落库）', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const plan = seedPastPlan(store, '2026-05-09', '跑步', 30)
    await toolNamed(tools, 'plan_item_update').execute({
      date: '2026-05-09', itemId: plan.items[0].id, status: 'missed', reason: '下班太晚',
    }, {})
    const value = await toolNamed(tools, 'plan_read').execute({ date: '2026-05-09' }, {})
    assert.equal(value.items[0].reason, '下班太晚')
  })

  it('plan_read 对没有计划的日期返回空而不是报错', async () => {
    const tools = toolsFor(memoryStore())
    const value = await toolNamed(tools, 'plan_read').execute({ date: '2026-05-10' }, {})
    assert.equal(value.items.length, 0)
    assert.equal(value.exists, false)
  })

  it('plan_history 支持按天与按周两种粒度', async () => {
    const store = memoryStore()
    const tools = toolsFor(store)
    const seeded = seedPastPlan(store, '2026-05-09', 'a', 10)
    const itemUpdate = toolNamed(tools, 'plan_item_update')
    await itemUpdate.execute({ date: '2026-05-09', itemId: seeded.items[0].id, status: 'done' }, {})

    const daily = await toolNamed(tools, 'plan_history').execute({ from: '2026-05-08', to: '2026-05-10' }, {})
    assert.equal(daily.granularity, 'day')
    assert.equal(daily.range.planned, 1)
    assert.equal(daily.range.done, 1)
    assert.equal(daily.days.length, 1) // 没有计划的日期不占行

    const weekly = await toolNamed(tools, 'plan_history').execute(
      { from: '2026-05-01', to: '2026-05-10', granularity: 'week' }, {},
    )
    assert.equal(weekly.granularity, 'week')
    assert.equal(weekly.buckets.length, 1)
    assert.equal(weekly.buckets[0].week, '2026-05-04') // 2026-05-09 所在周的周一
    assert.equal(weekly.buckets[0].done, 1)
  })
})

// ───────────────────────── 真 schema 校验（有 shipped 包时才跑） ─────────────────────────

describe('真 defineTool 的 schema 校验', { skip: realDefineTool === null ? '源码目录解析不到 @deepseek-ai/dsh-tools' : false }, () => {
  it('每个工具的 parameters 都能被真 DSL 编译', () => {
    const tools = buildTools({
      defineTool: realDefineTool,
      store: { read: () => ({ goals: [], tasks: [], plans: [] }), update: fn => fn({ goals: [], tasks: [], plans: [] }) },
    })
    assert.equal(tools.length, 9)
    for (const tool of tools) {
      assert.ok(tool.parameters && typeof tool.parameters === 'object', `${tool.name} 编译后应有 JSON Schema`)
    }
  })
})
