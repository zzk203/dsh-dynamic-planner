/**
 * 数据层 —— 三层模型的唯一真相来源（REQUIREMENTS.md §3）。
 *
 *   目标 Goal  ──┐
 *                ├─► 任务池 Task ──► 每日计划条目 PlanItem
 *   独立待办 ────┘
 *
 * 设计约束（来自需求文档，不要在这里"优化"掉）：
 *  - §3.2  滚动拆解：任务池只承载近期的量，历史靠计划快照回溯
 *  - P4    历史计划【构成冻结】：往日计划不能再增删条目、不能改预估耗时；
 *          但状态与备注允许回填（用户可能忘了勾选，LLM 第二天还要写回未完成原因）
 *  - 铁律四 长期目标对用户只呈现正向积累；负面进度不上桌（由 UI 层与提示词层共同保证，
 *          本层只负责如实计算，不负责隐藏）
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 目标模式。`deadline` 参与速度预警，`longterm` 只做静默调节（§3.1）。 */
export const GOAL_MODES = ['deadline', 'longterm']

/** 任务与计划项的终结状态。 */
export const ITEM_STATUSES = ['pending', 'done', 'missed']

/** 长期目标的最小剂量（分钟/天）—— 不可再降的安全网（§4.5）。 */
export const MIN_DOSE_MINUTES = 8

/** 正向积累的浮现门槛（§4.7）：达到才显示，避免退化成打卡压力。 */
export const MILESTONE_STEP = 5

// ───────────────────────── 日期工具（一律本地时区） ─────────────────────────

/** 本地日期键 `YYYY-MM-DD`。刻意不用 toISOString —— 那是 UTC，会在晚上 8 点后串日。 */
export function dateKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 在日期键上加减天数，返回新键。 */
export function shiftDate(key, days) {
  const [y, m, d] = key.split('-').map(Number)
  const base = new Date(y, m - 1, d)
  base.setDate(base.getDate() + days)
  return dateKey(base)
}

/** 两个日期键之间的整天数（to - from）。 */
export function daysBetween(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  const a = Date.UTC(y1, m1 - 1, d1)
  const b = Date.UTC(y2, m2 - 1, d2)
  return Math.round((b - a) / 86400000)
}

/** 该日期所在周的周一（本地时区）。 */
export function weekStartKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const dow = (dt.getDay() + 6) % 7 // 周一为 0
  dt.setDate(dt.getDate() - dow)
  return dateKey(dt)
}

/** 生成一个短 id。 */
export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

/**
 * 规范化预估耗时（分钟）。
 * 契约：未提供、非有限数、或不是正数 → 默认值（视为"没说"）；
 * 正数 → 四舍五入后至少 1 分钟。不接受 0 或负数落库。
 */
export function normalizeEstimate(value, fallback = 15) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.round(n))
}

// ───────────────────────── 持久化 ─────────────────────────

/** 空数据体。 */
export function emptyData() {
  return { version: 1, goals: [], tasks: [], plans: [] }
}

/**
 * 读取数据文件。任何损坏都退回空数据 —— 日程表读不出来不该让整个会话崩掉，
 * 但也不能静默丢数据，所以损坏时把原文件另存为 `.corrupt-<时间>` 再返回空。
 */
export function loadData(file, onWarn) {
  try {
    if (!existsSync(file)) return emptyData()
    const raw = readFileSync(file, 'utf8')
    if (raw.trim().length === 0) return emptyData()
    const parsed = JSON.parse(raw)
    return normalize(parsed)
  } catch (error) {
    onWarn?.(`[planner] 数据文件损坏，已另存并重置：${String(error?.message ?? error)}`)
    try {
      if (existsSync(file)) renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* 另存失败也不该阻断启动 */ }
    return emptyData()
  }
}

/** 原子写入：先写临时文件再 rename，避免进程中断留下半个 JSON。 */
export function saveData(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function normalize(parsed) {
  const base = emptyData()
  if (parsed === null || typeof parsed !== 'object') return base
  return {
    version: 1,
    goals: Array.isArray(parsed.goals) ? parsed.goals : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
  }
}

// ───────────────────────── 查询 ─────────────────────────

export function findGoal(data, id) {
  return data.goals.find(goal => goal.id === id)
}

export function findTask(data, id) {
  return data.tasks.find(task => task.id === id)
}

export function getPlan(data, date) {
  return data.plans.find(plan => plan.date === date)
}

/**
 * 某天之前、仍未完成的计划项（含所属日期）。排计划时追问未完成项就是问这批。
 *
 * "未完成"同时包含 `pending`（用户根本没碰过）与 `missed`（已被判定没做）——
 * 这两种对用户来说是同一件事：昨天那件没做。只有 `done` 才算完成。
 */
export function pendingBefore(data, date) {
  const out = []
  for (const plan of data.plans) {
    if (plan.date >= date) continue
    for (const item of plan.items) {
      if (item.status !== 'done') out.push({ ...item, date: plan.date })
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/**
 * 某条任务连续顺延了几次 —— §4.6「连续顺延 ≥ 3 次」上报的计数来源。
 *
 * 刻意**算出来**而不是在状态变更时累加，因为累加两头都不对，而且两头都伤核心承诺：
 *
 *  - **会虚高**：累加不幂等。同一条被重复标成 missed 就会把计数刷高，
 *    于是一条其实只拖了一天的任务会误触上报。实测踩到过：计数被刷到 2，
 *    而那只是同一轮会话重复写了一次状态。
 *  - **会漏记**：任务被顺延最常见的形态是"没人动它" ——
 *    一直被反复重排、状态始终是 pending。只数"明确标成没做"会严重低估，
 *    于是该报的永远不报。
 *
 * 口径：把该任务被排进计划的日子按时间排好，从最近一次往回数，
 * 连续多少个"排了但没完成"的日子；遇到一次完成就停。
 * 不要求日历连续 —— 数的是"排了没做"的次数，不是天数。
 *
 * **今天不算**：今天还没过完，今天那条 pending 不是"顺延"，只是"还没做"。
 * 把它算进去会让昨天拖一次的任务今天就显示 2 次，同样会提前触发上报。
 *
 * @param {object} data 完整数据体
 * @param {string} taskId 任务 id
 * @param {string} [today] 本地今天 `YYYY-MM-DD`；给了就只数今天之前的日子
 * @returns {number} 连续顺延次数
 */
export function deferStreak(data, taskId, today) {
  const itemOn = (date) => getPlan(data, date)?.items.find(entry => entry.taskId === taskId)
  const dates = []
  for (const plan of data.plans) {
    if (today !== undefined && plan.date >= today) continue
    if (plan.items.some(entry => entry.taskId === taskId)) dates.push(plan.date)
  }
  dates.sort()
  let streak = 0
  for (let index = dates.length - 1; index >= 0; index -= 1) {
    const item = itemOn(dates[index])
    if (item === undefined || item.status === 'done') break
    streak += 1
  }
  return streak
}

/** 某天标记为 missed 但尚未写回原因的条目 —— LLM 追问的靶子。 */
export function unexplained(data, date) {
  const out = []
  for (const plan of data.plans) {
    if (plan.date >= date) continue
    for (const item of plan.items) {
      if (item.status === 'missed' && !item.reason) out.push({ ...item, date: plan.date })
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** 汇总 [from, to] 闭区间的完成情况。 */
export function aggregateRange(data, from, to) {
  let planned = 0
  let done = 0
  let missed = 0
  let plannedMinutes = 0
  let doneMinutes = 0
  const byGoal = {}
  for (const plan of data.plans) {
    if (plan.date < from || plan.date > to) continue
    for (const item of plan.items) {
      planned += 1
      plannedMinutes += item.estimateMin ?? 0
      if (item.status === 'done') {
        done += 1
        doneMinutes += item.estimateMin ?? 0
      } else if (item.status === 'missed') {
        missed += 1
      }
      if (item.goalId) {
        const bucket = (byGoal[item.goalId] ??= { planned: 0, done: 0, plannedMinutes: 0, doneMinutes: 0 })
        bucket.planned += 1
        bucket.plannedMinutes += item.estimateMin ?? 0
        if (item.status === 'done') {
          bucket.done += 1
          bucket.doneMinutes += item.estimateMin ?? 0
        }
      }
    }
  }
  return { from, to, planned, done, missed, plannedMinutes, doneMinutes, byGoal }
}

/** 近 `days` 天的逐日汇总（热层），以及按周聚合（温层）。 */
export function recentStats(data, today, days = 14) {
  const daily = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = shiftDate(today, -i)
    const plan = getPlan(data, key)
    daily.push({
      date: key,
      planned: plan?.items.length ?? 0,
      done: plan?.items.filter(item => item.status === 'done').length ?? 0,
      minutes: plan?.items.filter(item => item.status === 'done')
        .reduce((sum, item) => sum + (item.estimateMin ?? 0), 0) ?? 0,
    })
  }
  return daily
}

/**
 * 有期限目标的「按当前速度能否达成」（§4.6 异常上报的判据）。
 * 返回 null 表示不该预警 —— 无 DDL 的目标、已完成的、或根本还没排过任务的都不预警。
 */
export function goalPace(data, goal, today) {
  if (goal.mode !== 'deadline' || !goal.deadline || goal.status !== 'active') return null
  const daysLeft = daysBetween(today, goal.deadline)
  const openTasks = data.tasks.filter(task => task.goalId === goal.id && task.status === 'pool')
  const remainingMinutes = openTasks.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0)
  const recent = aggregateRange(data, shiftDate(today, -7), shiftDate(today, -1))
  const producedMinutes = recent.doneMinutes
  const dailyRate = producedMinutes / 7
  const neededRate = daysLeft > 0 ? remainingMinutes / daysLeft : remainingMinutes
  const willMiss = daysLeft < 0 || neededRate > dailyRate + 1e-9
  return {
    daysLeft,
    openTaskCount: openTasks.length,
    remainingMinutes,
    recentDailyMinutes: Math.round(dailyRate * 10) / 10,
    requiredDailyMinutes: Math.round(neededRate * 10) / 10,
    willMiss,
  }
}

/**
 * 长期目标的正向积累（§4.7）。只返回正向计数，且带浮现门槛 ——
 * 未达门槛时 `visible` 为 false，UI 不该显示任何东西。
 */
export function goalMomentum(data, goal) {
  const dates = new Set()
  for (const plan of data.plans) {
    for (const item of plan.items) {
      if (item.goalId === goal.id && item.status === 'done') dates.add(plan.date)
    }
  }
  const sorted = [...dates].sort()
  const total = sorted.length
  // 连续天数：从最后一次完成日往回数
  let streak = 0
  if (sorted.length > 0) {
    let cursor = sorted[sorted.length - 1]
    const set = new Set(sorted)
    while (set.has(cursor)) {
      streak += 1
      cursor = shiftDate(cursor, -1)
    }
  }
  return {
    total,
    streak,
    visible: total >= MILESTONE_STEP,
    nextMilestone: Math.ceil((total + 1) / MILESTONE_STEP) * MILESTONE_STEP,
  }
}

// ───────────────────────── 变更 ─────────────────────────

/**
 * 建/改目标。`mode` 由调用方（LLM）推荐、用户拍板后传入（§3.1）。
 * 这里不做"完成"写入 —— 完成只走 `completeGoal`，它要求显式的用户确认。
 */
export function saveGoal(data, input, today) {
  const existing = input.id ? findGoal(data, input.id) : undefined
  if (existing) {
    if (input.title !== undefined) existing.title = String(input.title)
    if (input.criteria !== undefined) existing.criteria = String(input.criteria)
    if (input.mode !== undefined && GOAL_MODES.includes(input.mode)) existing.mode = input.mode
    if (input.deadline !== undefined) existing.deadline = input.deadline || null
    if (input.rawInput !== undefined) existing.rawInput = String(input.rawInput)
    if (input.dial !== undefined) existing.dial = clampDial(input.dial)
    // 模式与必填项的一致性：有期限必须有截止日，否则降级为长期目标而不是留一个坏状态
    if (existing.mode === 'deadline' && !existing.deadline) existing.mode = 'longterm'
    existing.updatedAt = new Date().toISOString()
    return existing
  }
  const goal = {
    id: newId('goal'),
    title: String(input.title ?? '未命名目标'),
    criteria: String(input.criteria ?? ''),
    rawInput: String(input.rawInput ?? ''),
    mode: GOAL_MODES.includes(input.mode) ? input.mode : 'longterm',
    deadline: input.deadline || null,
    status: 'active',
    dial: clampDial(input.dial),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    createdDate: today,
  }
  if (goal.mode === 'deadline' && !goal.deadline) goal.mode = 'longterm'
  data.goals.push(goal)
  return goal
}

/**
 * 标记目标完成。**铁律一**：只有用户拍板才能走这里，
 * 所以 `confirmedByUser` 是必填的真值 —— 提示词层要求 LLM 先问、再传。
 */
export function completeGoal(data, id, confirmedByUser) {
  const goal = findGoal(data, id)
  if (!goal) throw new Error(`目标不存在：${id}`)
  if (confirmedByUser !== true) {
    throw new Error('目标完成必须由用户确认：请先在对话里问用户，得到肯定答复后再以 confirmedByUser=true 调用')
  }
  goal.status = 'done'
  goal.completedAt = new Date().toISOString()
  for (const task of data.tasks) {
    if (task.goalId === goal.id && task.status === 'pool') task.status = 'dropped'
  }
  return goal
}

/** 长期目标的难度/量旋钮（§4.5）。下限由 `clampDial` 保证。 */
export function clampDial(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(3, Math.max(0.2, n))
}

/** 建/改任务池条目。 */
export function saveTask(data, input) {
  const existing = input.id ? findTask(data, input.id) : undefined
  if (existing) {
    if (input.title !== undefined) existing.title = String(input.title)
    if (input.goalId !== undefined) existing.goalId = input.goalId || null
    if (input.estimateMin !== undefined) existing.estimateMin = normalizeEstimate(input.estimateMin)
    if (input.priority !== undefined) existing.priority = Math.max(0, Math.min(3, Math.round(Number(input.priority) || 0)))
    if (input.status !== undefined) existing.status = String(input.status)
    if (input.difficulty !== undefined) existing.difficulty = String(input.difficulty)
    return existing
  }
  const task = {
    id: newId('task'),
    goalId: input.goalId || null,
    title: String(input.title ?? '未命名任务'),
    estimateMin: normalizeEstimate(input.estimateMin),
    priority: Math.max(0, Math.min(3, Math.round(Number(input.priority) || 0))),
    difficulty: String(input.difficulty ?? 'small'),
    status: 'pool',
    createdAt: new Date().toISOString(),
    lastPlannedDate: null,
    /** 已被排进哪一天的计划。池视图据此排除"今天已经排过"的任务，避免重复排期。 */
    plannedFor: null,
  }
  data.tasks.push(task)
  return task
}

/**
 * 当计划项没带 taskId 时，尝试从池里认领对应的任务。
 *
 * 为什么需要这一步：计划项与池任务是两个对象。如果 LLM 从池里挑了一条任务排进今天
 * 却忘了带 taskId，那条任务会一直留在池里，明天被**再排一次** —— 用户会看到同一件事
 * 出现两次，而且是无声出现的。
 *
 * 只在**唯一精确匹配**（标题完全相同 + 归属目标相同）时才认领。有歧义就返回 null：
 * 猜错了比不猜更糟，因为错连会把两条不相干的事绑成一条，且同样无声。
 */
function inferTaskId(data, entry) {
  const title = String(entry.title ?? '').trim()
  if (title === '') return null
  const goalId = entry.goalId ?? null
  const matches = data.tasks.filter(task =>
    task.status === 'pool'
    && task.title.trim() === title
    && (task.goalId ?? null) === goalId)
  return matches.length === 1 ? matches[0].id : null
}

/**
 * 在今日已有计划里，找出与新条目对应的那一条（用于把进度带过去）。
 *
 * 先按 taskId 认，再退到"标题完全相同且归属相同"的**唯一**匹配。
 * 有歧义时返回 undefined —— 猜错了会把两条不相干的事的进度串在一起。
 */
function findPriorItem(existingItems, entry) {
  if (!Array.isArray(existingItems)) return undefined
  if (entry.taskId) {
    const byTask = existingItems.find(item => item.taskId === entry.taskId)
    if (byTask !== undefined) return byTask
  }
  const title = String(entry.title ?? '').trim()
  if (title === '') return undefined
  const goalId = entry.goalId ?? null
  const matches = existingItems.filter(item =>
    item.title.trim() === title && (item.goalId ?? null) === goalId)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 写入某天的计划。
 *
 * P4：往日【构成冻结】—— 只有今天（或未来）能整体重写；往日的计划不允许增删条目。
 * 这不是保守，是因为"昨天到底排了什么"是速度计算的输入，改它等于改账本。
 *
 * 铁律一：今天的重排**必须保全已有的勾选**。整体替换语义本身没错，但如果替换时
 * 把用户已经勾掉的条目标回 pending，就等于无声地抹掉了他做过的事 —— 而且用户不会收到
 * 任何提示。实测中这确实发生过：一次"帮我排今天的计划"把当天已完成的两条连同备注、
 * 未完成原因一起清空了，模型只好再花两次调用把它们补回去。补得回来是运气，不是设计。
 */
export function writePlan(data, date, items, today) {
  if (date < today) {
    throw new Error(`往日计划构成已冻结（${date}）：只能改状态、备注与未完成原因，不能增删条目或改预估耗时`)
  }
  const existing = getPlan(data, date)

  const carriedIds = new Set()
  const nextItems = items.map(entry => {
    const prior = findPriorItem(existing?.items, entry)
    if (prior !== undefined) carriedIds.add(prior.id)
    return {
      // 沿用原 id：这样别人（面板、模型）手里攥着的 itemId 不会突然失效
      id: entry.id ?? prior?.id ?? newId('item'),
      taskId: entry.taskId ?? prior?.taskId ?? inferTaskId(data, entry),
      title: String(entry.title ?? ''),
      goalId: entry.goalId ?? null,
      estimateMin: normalizeEstimate(entry.estimateMin),
      status: prior?.status ?? 'pending',
      completedAt: prior?.completedAt ?? null,
      note: prior?.note ?? '',
      reason: prior?.reason ?? '',
    }
  })

  // 已完成的条目不允许被重排悄悄丢掉。未完成的被换掉是重排的意义所在，
  // 已完成的是**账本**——丢了就再也算不出那天到底做成了什么。
  if (existing !== undefined) {
    const lost = existing.items.filter(item => item.status === 'done' && !carriedIds.has(item.id))
    if (lost.length > 0) {
      throw new Error(
        `重排会丢掉 ${lost.length} 条今天已完成的条目：${lost.map(item => item.title).join('、')}。`
        + '请把它们一并写回新的 items 里（已完成状态、备注与原因都会被保留），'
        + '或者改用 plan_item_update 只调整需要变的那几条。',
      )
    }
  }

  if (existing !== undefined) {
    existing.items = nextItems
    existing.generatedAt = new Date().toISOString()
  } else {
    data.plans.push({ date, generatedAt: new Date().toISOString(), items: nextItems })
  }
  // 重排是"整体替换"语义：先把这一天的排期标记全部撤掉，再按新计划重新打上。
  // 否则被移出今日计划的任务会永远留在"已排期"状态里，再也排不进来。
  for (const task of data.tasks) {
    if (task.plannedFor === date) task.plannedFor = null
  }
  for (const item of nextItems) {
    if (!item.taskId) continue
    const task = findTask(data, item.taskId)
    if (!task) continue
    task.lastPlannedDate = date
    task.plannedFor = date
  }
  data.plans.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return getPlan(data, date)
}

/**
 * 更新一条计划项。
 *
 * 可改：status / note / reason。
 * 不可改：title / estimateMin / 归属 —— 那是【构成】，冻结。
 * 这条规则对往日同样生效，所以 LLM 第二天仍然能把"为什么没做完"写回去。
 */
export function updatePlanItem(data, date, itemId, patch) {
  const plan = getPlan(data, date)
  if (!plan) throw new Error(`该日期没有计划：${date}`)
  const item = plan.items.find(entry => entry.id === itemId)
  if (!item) throw new Error(`计划项不存在：${itemId}`)
  if (patch.status !== undefined) {
    if (!ITEM_STATUSES.includes(patch.status)) throw new Error(`非法状态：${patch.status}`)
    item.status = patch.status
    item.completedAt = patch.status === 'done' ? new Date().toISOString() : null
    syncTaskFromItem(data, item)
  }
  if (patch.note !== undefined) item.note = String(patch.note)
  if (patch.reason !== undefined) item.reason = String(patch.reason)
  return item
}

/**
 * 计划项状态回流任务池：完成即出池，未完成则回池。
 *
 * 这里**刻意不再累加任何顺延计数** —— 顺延次数改由 {@link deferStreak} 从计划本身算出来。
 * 原因见那个函数的注释：累加既不幂等（重复标记会刷高）又会漏（没人动它就不计）。
 */
function syncTaskFromItem(data, item) {
  if (!item.taskId) return
  const task = findTask(data, item.taskId)
  if (!task) return
  if (item.status === 'done') {
    task.status = 'done'
    task.plannedFor = null
  } else if (item.status === 'missed') {
    task.status = 'pool'
    task.plannedFor = null
  }
}

/** 面板的「随手加一条待办」：直接建一个无归属的池任务。 */
export function quickAddTask(data, title, estimateMin) {
  return saveTask(data, { title, estimateMin: estimateMin ?? 15, goalId: null, priority: 1 })
}

/**
 * 面板/上下文用的今日视图。
 *
 * 铁律四的落点：这里对长期目标**只输出正向积累计数**（且受门槛约束），
 * 绝不输出百分比、剩余量或落后提示；有期限目标的 pace 才带负面节奏信息。
 */
export function todayView(data, today) {
  const plan = getPlan(data, today)
  const goals = data.goals.filter(goal => goal.status === 'active')
  return {
    date: today,
    plan: plan
      ? {
          date: plan.date,
          generatedAt: plan.generatedAt,
          items: plan.items.map(item => ({
            id: item.id,
            title: item.title,
            estimateMin: item.estimateMin,
            goalId: item.goalId ?? null,
            goalTitle: item.goalId ? (findGoal(data, item.goalId)?.title ?? null) : null,
            status: item.status,
            note: item.note ?? '',
            reason: item.reason ?? '',
          })),
        }
      : null,
    pendingBefore: pendingBefore(data, today).map(item => ({
      id: item.id, date: item.date, title: item.title, goalId: item.goalId ?? null,
    })),
    // 池里只给"还没被排进今天或以后"的任务。今天已排过的任务仍算未完成工作量
    // （goalPace 会把它算进剩余工时），但不该再被排一次 —— 这两个口径是刻意不同的。
    pool: data.tasks
      .filter(task => task.status === 'pool' && !(task.plannedFor && task.plannedFor >= today))
      .map(task => ({
        id: task.id, title: task.title, estimateMin: task.estimateMin,
        goalId: task.goalId ?? null, deferCount: deferStreak(data, task.id, today),
      })),
    goals: goals.map(goal => ({
      id: goal.id,
      title: goal.title,
      mode: goal.mode,
      status: goal.status,
      deadline: goal.deadline ?? null,
      // 长期目标只给正向积累，且未达门槛时 UI 不该显示（visible=false）
      momentum: goal.mode === 'longterm' ? goalMomentum(data, goal) : null,
      // 有期限目标才给节奏判断
      pace: goal.mode === 'deadline' ? goalPace(data, goal, today) : null,
    })),
    stats: recentStats(data, today, 14),
  }
}

/** 目标总览（二级视图，默认不展开）。刻意不返回百分比 —— 那是 UI 层禁止显示的东西。 */
export function goalOverview(data, today) {
  return data.goals.map(goal => {
    const tasks = data.tasks.filter(task => task.goalId === goal.id)
    return {
      id: goal.id,
      title: goal.title,
      criteria: goal.criteria,
      mode: goal.mode,
      status: goal.status,
      deadline: goal.deadline ?? null,
      dial: goal.dial ?? 1,
      poolTaskCount: tasks.filter(task => task.status === 'pool').length,
      doneTaskCount: tasks.filter(task => task.status === 'done').length,
      momentum: goal.mode === 'longterm' ? goalMomentum(data, goal) : null,
      pace: goal.mode === 'deadline' ? goalPace(data, goal, today) : null,
      createdAt: goal.createdAt,
      completedAt: goal.completedAt ?? null,
    }
  })
}

/** 按自然周聚合（温层）。用于让 LLM 看趋势而不必读全部流水。 */
export function weeklyAggregate(data, from, to) {
  const buckets = new Map()
  for (const plan of data.plans) {
    if (plan.date < from || plan.date > to) continue
    const week = weekStartKey(plan.date)
    const bucket = buckets.get(week) ?? {
      week, from: week, to: shiftDate(week, 6), planned: 0, done: 0, missed: 0, doneMinutes: 0,
    }
    for (const item of plan.items) {
      bucket.planned += 1
      if (item.status === 'done') {
        bucket.done += 1
        bucket.doneMinutes += item.estimateMin ?? 0
      } else if (item.status === 'missed') {
        bucket.missed += 1
      }
    }
    buckets.set(week, bucket)
  }
  return [...buckets.values()].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0))
}

/**
 * 存储门面：每次读都落到磁盘，不做内存缓存。
 *
 * 日程表数据量极小，而面板与 LLM 是同一进程里的两个写入方 ——
 * 缓存省下的那点开销，远不值得冒"两边看到不同状态"的风险。
 */
export function createStore(file, onWarn) {
  return {
    read: () => loadData(file, onWarn),
    /**
     * 读 → 变更 → 落盘。变更函数抛错时**不落盘**，
     * 这样校验失败不会把半成品写进账本。
     */
    async update(mutator) {
      const data = loadData(file, onWarn)
      const result = await mutator(data)
      saveData(file, data)
      return result
    },
  }
}
