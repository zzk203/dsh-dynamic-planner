/**
 * LLM 工具集 —— 对话侧操纵日程表的唯一入口（REQUIREMENTS.md §6.1）。
 *
 * 两个刻意的设计约束：
 *
 * 1. **依赖注入**：`defineTool` 与 `store` 都从外部传入。这样本模块在源码目录里
 *    也能被纯逻辑测试覆盖，不会因为解析不到 shipped package 而假装失败。
 *
 * 2. **工具 schema 与数据无关**（§6.3 缓存纪律）：描述里绝不出现"当前有 3 条待办"
 *    这类动态内容。工具列表一变，整个前缀缓存作废，代价远大于摘要本身。
 *    测试 `工具定义必须与数据无关` 就是这条纪律的守卫。
 */

import {
  aggregateRange,
  completeGoal,
  dateKey,
  findGoal,
  findTask,
  getPlan,
  saveGoal,
  saveTask,
  shiftDate,
  todayView,
  unexplained,
  updatePlanItem,
  weeklyAggregate,
  writePlan,
} from './store.js'

/** 工具体共用的 JSON 渲染器。 */
const jsonRender = (compact = false) => (_args, value) => [
  { type: 'text', text: compact ? JSON.stringify(value) : JSON.stringify(value, null, 2) },
]

const jsonOutput = (compact = false) => ({ schema: { type: 'json' }, render: jsonRender(compact) })

/** 计划项参数的 schema（plan_write 用）。 */
const planItemSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', description: '任务池里某条任务的 id。独立待办可以不填。' },
    title: { type: 'string', required: true, description: '这一条今天要做的事。' },
    estimateMin: {
      type: 'integer',
      required: true,
      description: '预估耗时（分钟）。这是判断"今天塞不塞得下"的唯一依据，必须给。',
    },
    goalId: { type: 'string', description: '归属目标 id。长期目标也要填，但界面上只会显示成正向积累。' },
  },
}

/**
 * 构建全部工具定义。
 * @param {object} deps
 * @param {(options: object) => object} deps.defineTool shipped 的 defineTool
 * @param {{ read: () => object, update: (fn: (data: object) => unknown) => Promise<unknown> }} deps.store
 * @param {() => string} [deps.now] 返回本地今天 `YYYY-MM-DD`。可注入，以便测试用固定时钟。
 * @returns {object[]} 可直接交给 ctx.tools.register 的定义数组
 */
export function buildTools({ defineTool, store, now = dateKey }) {
  const today = () => now()

  return [
    // ───────────────────────── 读 ─────────────────────────

    defineTool({
      name: 'plan_context',
      description:
        '读取"排今日计划"所需的全部上下文：今日已有计划、往日仍未完成的项、'
        + '已判定未完成但还没说明原因的项（这是你该去追问的靶子）、可用任务池、'
        + '目标（有期限目标给速度判断，长期目标给正向积累计数）、近 14 天逐日完成情况。'
        + '用户说"排今天的计划"时，先调这个工具，再决定怎么排。',
      parameters: {
        date: { type: 'string', description: '目标日期 YYYY-MM-DD，默认本地今天。' },
      },
      output: jsonOutput(),
      async execute(args) {
        const data = store.read()
        const date = args.date ?? today()
        const view = todayView(data, date)
        return {
          date,
          todayPlan: view.plan,
          pendingBefore: view.pendingBefore,
          unexplained: unexplained(data, date),
          pool: view.pool,
          goals: view.goals,
          recentDays: view.stats,
        }
      },
    }),

    defineTool({
      name: 'plan_read',
      description: '读取某一天的完整计划，含每条的状态、你的自由备注与未完成原因。',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认本地今天。' },
      },
      output: jsonOutput(),
      async execute(args) {
        const data = store.read()
        const date = args.date ?? today()
        const plan = getPlan(data, date)
        return {
          date,
          exists: plan !== undefined,
          generatedAt: plan?.generatedAt ?? null,
          items: plan?.items ?? [],
        }
      },
    }),

    defineTool({
      name: 'plan_history',
      description:
        '查询历史完成情况。granularity=day 给逐日汇总与区间合计，week 给按自然周的聚合。'
        + '用来判断趋势、连续失败、以及给长期目标计算"最近是否被推进"。明细很多时用 week。',
      parameters: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）。默认 14 天前。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）。默认今天。' },
        granularity: { type: 'string', enum: ['day', 'week'], description: '默认 day。' },
      },
      output: jsonOutput(true),
      async execute(args) {
        const data = store.read()
        const to = args.to ?? today()
        const from = args.from ?? shiftDate(to, -13)
        const granularity = args.granularity ?? 'day'
        if (granularity === 'week') {
          return { granularity, from, to, buckets: weeklyAggregate(data, from, to) }
        }
        const days = []
        for (let cursor = from; cursor <= to; cursor = shiftDate(cursor, 1)) {
          const plan = getPlan(data, cursor)
          if (plan === undefined) continue
          days.push({
            date: cursor,
            planned: plan.items.length,
            done: plan.items.filter(item => item.status === 'done').length,
            missed: plan.items.filter(item => item.status === 'missed').length,
            doneMinutes: plan.items
              .filter(item => item.status === 'done')
              .reduce((sum, item) => sum + (item.estimateMin ?? 0), 0),
          })
        }
        return { granularity, from, to, days, range: aggregateRange(data, from, to) }
      },
    }),

    // ───────────────────────── 写：计划 ─────────────────────────

    defineTool({
      name: 'plan_write',
      description:
        '把某一天的计划**整体替换**成给定的一组条目。这是替换语义，不是追加 —— '
        + '传进来的 items 就是这一天的全部安排。只能写今天或未来的日期；'
        + '往日的计划构成已冻结，只能改状态与说明（见 plan_item_update）。'
        + '每条都必须给出 estimateMin，那是判断今天塞不塞得下的依据。',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD，默认本地今天。' },
        items: {
          type: 'array',
          required: true,
          description: '这一天的全部安排，至少要有一条。',
          items: planItemSpec,
        },
      },
      output: jsonOutput(),
      async execute(args) {
        if (!Array.isArray(args.items) || args.items.length === 0) {
          throw new Error('items 至少要有一条。如果用户是想清空今天，请先向用户确认，再在面板上处理。')
        }
        const date = args.date ?? today()
        return store.update(data => writePlan(data, date, args.items, today()))
      },
    }),

    defineTool({
      name: 'plan_item_update',
      description:
        '更新一条计划项的状态、自由备注或未完成原因。任务是"完成"还是"未完成"，以这里的 status 为准。'
        + '往日条目也允许改这三项 —— 所以第二天追问出原因后，仍然可以写回昨天那一条。'
        + '但条目的构成（标题、预估耗时、归属）是冻结的，改不了。',
      parameters: {
        date: { type: 'string', description: '该条目所在日期 YYYY-MM-DD，默认本地今天。' },
        itemId: { type: 'string', required: true, description: '计划项 id，来自 plan_read 或 plan_context。' },
        status: { type: 'string', enum: ['pending', 'done', 'missed'], description: 'done=做完了，missed=没做。' },
        note: { type: 'string', description: '代用户记录的自由备注。只在用户确实说了什么时写。' },
        reason: { type: 'string', description: '未完成的原因，用你自己的话概括用户说的，不要自行编造。' },
      },
      output: jsonOutput(),
      async execute(args) {
        const date = args.date ?? today()
        const patch = {}
        if (args.status !== undefined) patch.status = args.status
        if (args.note !== undefined) patch.note = args.note
        if (args.reason !== undefined) patch.reason = args.reason
        return store.update(data => updatePlanItem(data, date, args.itemId, patch))
      },
    }),

    // ───────────────────────── 写：目标 ─────────────────────────

    defineTool({
      name: 'goal_save',
      description:
        '创建或更新一个目标。不带 id 是新建（必须给 title），带 id 是更新。'
        + '新建前应先按"目标澄清"流程追问 1–3 个关键问题，把模糊的念头提炼成'
        + '「一句可判定的完成标准 + 推荐模式」，向用户说明推荐理由，得到认可后再调用本工具。'
        + 'mode=deadline 必须有 deadline，否则会被降级为 longterm。'
        + '本工具不能标记目标完成 —— 那是 goal_complete，且必须用户同意。',
      parameters: {
        id: { type: 'string', description: '要更新的目标 id。省略表示新建。' },
        title: { type: 'string', description: '目标标题。新建时必填。' },
        criteria: { type: 'string', description: '完成标准：一句可判定的话，例如"能独立跑完 10 公里"。' },
        mode: {
          type: 'string',
          enum: ['deadline', 'longterm'],
          description: 'deadline=有期限目标（算速度、会预警）；longterm=长期目标（只静默调节难度与量）。',
        },
        deadline: { type: 'string', description: '截止日 YYYY-MM-DD，仅 deadline 模式需要。' },
        rawInput: { type: 'string', description: '用户最初那句模糊的话，原样留存，便于以后回看初衷。' },
        dial: {
          type: 'number',
          description: '长期目标的难度/量旋钮，1 是基准，范围 0.2~3。调低不要低于最小剂量。',
        },
      },
      output: jsonOutput(),
      async execute(args) {
        return store.update(data => {
          if (args.id !== undefined && findGoal(data, args.id) === undefined) {
            throw new Error(`目标不存在：${args.id}。新建目标请不要传 id。`)
          }
          if (args.id === undefined && (args.title === undefined || String(args.title).trim() === '')) {
            throw new Error('新建目标必须提供 title。')
          }
          const input = { ...args }
          if (input.id !== undefined && input.title === undefined) {
            input.title = findGoal(data, input.id)?.title
          }
          return saveGoal(data, input, today())
        })
      },
    }),

    defineTool({
      name: 'goal_complete',
      description:
        '把一个目标标记为完成。**只能在用户明确表示这个目标已经达成之后调用**，'
        + '并必须传 confirmedByUser=true。如果你只是从数据上觉得"看起来差不多了"，'
        + '那就在对话里问一句，不要调用本工具 —— 完成与否由用户判断。',
      parameters: {
        id: { type: 'string', required: true, description: '目标 id。' },
        confirmedByUser: {
          type: 'boolean',
          required: true,
          description: '只有用户已明确同意时才传 true。其余情况一律传 false 或不要调用。',
        },
      },
      output: jsonOutput(),
      async execute(args) {
        return store.update(data => completeGoal(data, args.id, args.confirmedByUser === true))
      },
    }),

    // ───────────────────────── 写：任务池 ─────────────────────────

    defineTool({
      name: 'task_save',
      description:
        '创建或更新一条任务池条目。任务可以不挂任何目标 —— 那就是一条独立待办。'
        + '任务池是跨天滚动的，只有被排进某一天的计划才会出现在当天。',
      parameters: {
        id: { type: 'string', description: '要更新的任务 id。省略表示新建。' },
        goalId: { type: 'string', description: '归属目标 id。独立待办可以不填。' },
        title: { type: 'string', description: '任务标题。新建时必填。' },
        estimateMin: { type: 'integer', description: '预估耗时（分钟），默认 15。' },
        priority: { type: 'integer', description: '0 最低，3 最高。' },
        status: { type: 'string', enum: ['pool', 'done', 'dropped'], description: '默认 pool。' },
        difficulty: {
          type: 'string',
          enum: ['tiny', 'small', 'medium'],
          description: '长期目标拆解时用小粒度：tiny 表示"轻到不可能失败"。',
        },
      },
      output: jsonOutput(),
      async execute(args) {
        return store.update(data => {
          if (args.id !== undefined && findTask(data, args.id) === undefined) {
            throw new Error(`任务不存在：${args.id}。新建任务请不要传 id。`)
          }
          if (args.id === undefined && (args.title === undefined || String(args.title).trim() === '')) {
            throw new Error('新建任务必须提供 title。')
          }
          return saveTask(data, args)
        })
      },
    }),

    defineTool({
      name: 'task_add_batch',
      description:
        '一次性把一批任务加进任务池，用于把一个目标**滚动拆解**成若干条小任务。'
        + '拆解只做近 1–2 周的量，不要一次拆到年底。'
        + '长期目标的条目要拆得极细，单条轻到不可能失败。'
        + '拆完先给用户一段概览（方向、每天大约多少分钟），不要列出全部条目。',
      parameters: {
        goalId: { type: 'string', description: '这批任务归属的目标 id。省略则是若干条独立待办。' },
        tasks: {
          type: 'array',
          required: true,
          description: '要加入任务池的条目，至少一条。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true, description: '任务标题。' },
              estimateMin: { type: 'integer', description: '预估耗时（分钟）。' },
              difficulty: { type: 'string', enum: ['tiny', 'small', 'medium'], description: '粒度。' },
              priority: { type: 'integer', description: '0 最低，3 最高。' },
            },
          },
        },
      },
      output: jsonOutput(),
      async execute(args) {
        if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
          throw new Error('tasks 至少要有一条。空拆解通常意味着拆解没做成。')
        }
        return store.update(data => {
          if (args.goalId !== undefined && findGoal(data, args.goalId) === undefined) {
            throw new Error(`目标不存在：${args.goalId}`)
          }
          const added = args.tasks.map(entry => saveTask(data, { ...entry, goalId: args.goalId ?? null }))
          return { goalId: args.goalId ?? null, added }
        })
      },
    }),
  ]
}
