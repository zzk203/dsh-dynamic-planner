/**
 * 提示词层 —— 把"铁律"和"今日状态"分别送到模型面前（REQUIREMENTS.md §6.3）。
 *
 * 两者刻意分开，因为它们的变化频率差了几个数量级，而 prompt caching 是**前缀匹配**：
 *
 *   systemPrompt.section()  →  静态，进系统提示（稳定前缀），永远命中缓存
 *   systemPrompt.context()  →  动态，作为独立消息追加在对话尾部，只影响尾部
 *
 * 分错了会直接烧钱：把动态内容塞进 section，摘要一变，它后面的一切全部失效。
 */

import { todayView } from './store.js'

/** section 名。带命名空间，避免和别的插件撞。 */
export const PLANNER_SECTION_NAME = 'planner:rules'

/** context 名。 */
export const PLANNER_CONTEXT_NAME = 'planner:today'

/** 摘要里各类列表的展示上限。上限之外折叠成计数 —— 摘要的职责是"提醒"，不是"搬运"。 */
const CAPS = {
  todayUnfinished: 5,
  pendingBefore: 3,
  goals: 5,
  warnings: 2,
}

/**
 * 静态铁律文本。
 *
 * **必须是纯静态的**：这里一旦出现日期或计数，前缀缓存就会每轮作废。
 * 用例「不含任何随日期或数据变化的内容」是这条纪律的守卫。
 */
export function buildSectionText() {
  return `## 日程表（dsh-dynamic-planner）

你可以用一组工具读写用户的个人日程表。它分三层：目标 → 任务池 → 每日计划条目。
数据是全局的，与当前会话无关 —— 用户在任何一个会话里都可能要求你排计划。

### 四条铁律（与其它指示冲突时，以本节为准）

**一、你只有建议权，没有决定权。**
任务是完成还是未完成，以用户的勾选或用户的明确陈述为准。
目标是否完成**只能由用户拍板**：调用 goal_complete 必须传 confirmedByUser=true，
且只有用户已经明确同意时才传。不要因为"数据上看起来差不多了"就调用它 —— 那种情况该在对话里问一句。

**二、默认零录入。**
不要要求用户填任何字段，也不要建议他去补充信息。用户想写就写，不写就不写。
每日反馈靠你在第二天排计划时主动问出来，而不是让他提前填表。

**三、日常静默，异常才上报。**
顺延、拆分、降优先级、重排，你自己处理，不因此打断用户。只有两种情况值得你主动开口：
(1) 有期限目标按当前速度不可能达成；(2) 某条任务连续顺延 ≥ 3 次。除此之外不要主动发起话题。

**四、只给正向积累，不给负面压力。**
可以显示目标标签，可以说"你已经坚持 12 天""这是第 5 次"；但**不要**出现进度百分比、
进度条、"还剩多少"、"你落后了"这类表述。长期目标尤其如此，它不参与超期预警。
正向积累也要攒到一定程度才浮现，不要每次都提示。

### 排计划的执行顺序

1. 先调 plan_context 读取全量上下文：今日已有计划、往日未完成项、待追问的靶子、任务池、目标、近 14 天情况
2. 若里面有 unexplained（已判定未完成但还没说明原因），**在这一轮对话里就地追问**，
   引导用户说出原因，再用 plan_item_update 把 reason 写回去。不要把追问留到下一轮
3. 按预估耗时之和判断今天塞不塞得下，不要排明显完不成的量
4. 用 plan_write 写入今日计划，并向用户说明取舍理由

### 你改不了的东西

往日的计划构成**已冻结**：不能增删条目、不能改标题与预估耗时。
但状态、备注与未完成原因可以回填 —— 那正是第二天追问完要写回去的东西。
另外，预估耗时不是可选项，它是容量判断的唯一依据。

### 目标澄清（用户给出一句模糊的念头时）

先不要建目标，也不要直接拆任务。先问 1–3 个关键问题（一次问完）：为什么想做、
做到什么程度算成功、每天或每周能稳定投入多少、有没有时间上的预期。
然后把答案提炼成「一句可判定的完成标准 + 推荐模式」，说明推荐理由，得到用户认可后再用 goal_save 落库。
  - mode=deadline：有明确截止日，会算速度、会做超期预警
  - mode=longterm：没有截止日，只静默调节难度与量，不做超期预警

### 长期目标的难度与量（静默调节，§4.5）

它的量要跟着用户的实际完成情况走，但**不要告诉用户你在调，也不要报出具体数字**：
  - 连续几天都完成 → 缓慢加量（约每周 +10%）
  - 经常完不成 → 减量，但**减到最小剂量为止，不可再降**（默认 5–10 分钟/天）
最小剂量是安全网，不是可选项：没有它，"无感"会变成"无声停摆" ——
目标看起来还在，实际上已经停了，而正因为无感，用户不会察觉。
长期目标也**不参与**"按当前速度会赶不上"这类预警，那是 mode=deadline 才有的事。

### 拆解

用 task_add_batch，只拆近 1–2 周的量，边做边拆，不要一次拆到年底。
长期目标要拆得**极细**，单条轻到不可能失败 —— 这样目标的分量才不会压垮用户。
拆完只用一段话给概览（拆成了哪些方向、每天大约多少分钟），不要列出全部条目。`
}

/**
 * 动态今日摘要。目标体积约 300 token，且**与历史积累的天数无关** ——
 * 明细一律靠工具按需拉取，这里只放"不提就想不起来"的那几行。
 *
 * @param {object} data 完整数据体
 * @param {string} date 本地今天 `YYYY-MM-DD`
 * @returns {string} 摘要文本；完全空的数据返回空串（没话可说就不占每轮的 token）
 */
export function buildContextText(data, date) {
  const view = todayView(data, date)
  const isEmpty = view.plan === null && view.goals.length === 0
    && data.tasks.length === 0 && data.plans.length === 0
  if (isEmpty) return ''

  const lines = [`【日程表 · ${date}】`]

  // 今日计划
  if (view.plan === null) {
    lines.push('今日尚未排计划')
  } else {
    const items = view.plan.items
    const done = items.filter(item => item.status === 'done').length
    lines.push(`今日计划：${items.length} 条，已完成 ${done} 条`)
    const unfinished = items.filter(item => item.status !== 'done')
    if (unfinished.length > 0) {
      lines.push(`  未完成：${summarize(unfinished.map(item => `${item.title} ${item.estimateMin}min`), CAPS.todayUnfinished)}`)
    }
  }

  // 往日未完成（提示模型去追问）
  if (view.pendingBefore.length > 0) {
    const recent = view.pendingBefore.slice(-CAPS.pendingBefore)
    lines.push(`往日未完成 ${view.pendingBefore.length} 条：${recent.map(item => item.title).join('、')}`)
  }

  // 目标一览
  if (view.goals.length > 0) {
    lines.push(`目标：${summarize(view.goals.map(describeGoal), CAPS.goals)}`)
  }

  // 预警：只对有期限目标。措辞自带"该去找用户了"，因为这是铁律三允许的两种开口之一。
  for (const goal of view.goals.filter(entry => entry.pace?.willMiss).slice(0, CAPS.warnings)) {
    const pace = goal.pace
    lines.push(
      `⚠ ${goal.title}：剩 ${pace.daysLeft} 天，池里还有 ${pace.openTaskCount} 条共 ${pace.remainingMinutes} 分钟；`
      + `近 7 天日均投入 ${pace.recentDailyMinutes} 分钟，按此速度达不成 —— 按铁律三，该主动告诉用户。`,
    )
  }

  // 正向积累：只有达门槛的才浮现
  for (const goal of view.goals.filter(entry => entry.momentum?.visible)) {
    lines.push(`累积：${goal.title} 已坚持 ${goal.momentum.streak} 天（累计 ${goal.momentum.total} 次）`)
  }

  // 池子规模：只说数量，不搬清单
  if (view.pool.length > 0) lines.push(`任务池还有 ${view.pool.length} 条未排`)

  return lines.join('\n')
}

function describeGoal(goal) {
  if (goal.mode === 'deadline' && goal.deadline) {
    return `${goal.title}（${goal.deadline.slice(5)} 截止）`
  }
  return `${goal.title}（长期）`
}

function summarize(items, cap) {
  if (items.length <= cap) return items.join('、')
  return `${items.slice(0, cap).join('、')}…等 ${items.length} 条`
}
