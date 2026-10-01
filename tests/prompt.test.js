/**
 * 提示词层测试 —— 测试先于实现。
 *
 * 这一层守两件事：
 *   1. §6.3 缓存纪律：section 必须**字节静态**，context 必须**同数据同输出**
 *   2. 铁律四：长期目标的负面进度绝不能出现在注入给模型的文本里
 *
 * 第 2 条特别值得测：它是一句"不许出现什么"的约束，
 * 而这类约束在代码演进中最容易被悄悄破坏（比如某天顺手加了个"进度 60%"）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  PLANNER_CONTEXT_NAME,
  PLANNER_SECTION_NAME,
  buildContextText,
  buildSectionText,
} from '../lib/prompt.js'
import { completeGoal, emptyData, saveGoal, saveTask, updatePlanItem, writePlan } from '../lib/store.js'

const TODAY = '2026-05-10'

/** 造一份有历史、有目标、有任务池的数据。 */
function seeded() {
  const data = emptyData()
  const longterm = saveGoal(data, {
    title: '学英语', mode: 'longterm', criteria: '能不看字幕看剧',
  }, TODAY)
  const deadline = saveGoal(data, {
    title: '跑 10 公里', mode: 'deadline', deadline: '2026-06-01', criteria: '能独立跑完 10 公里',
  }, TODAY)
  saveTask(data, { title: '背单词', goalId: longterm.id, estimateMin: 15 })
  saveTask(data, { title: '给妈妈打电话', estimateMin: 10 })
  saveTask(data, { title: '长距离慢跑', goalId: deadline.id, estimateMin: 600 })
  // 昨天的计划：一条完成、一条没做
  const yesterday = writePlan(data, '2026-05-09', [
    { title: '听力练习', goalId: longterm.id, estimateMin: 20 },
    { title: '跑 3 公里', goalId: deadline.id, estimateMin: 30 },
  ], '2026-05-09')
  updatePlanItem(data, '2026-05-09', yesterday.items[0].id, { status: 'done' })
  updatePlanItem(data, '2026-05-09', yesterday.items[1].id, { status: 'missed' })
  return { data, longterm, deadline }
}

// ───────────────────────── 静态 section ─────────────────────────

describe('静态 section（铁律）', () => {
  it('是字节静态的：两次调用完全一致（§6.3 缓存纪律）', () => {
    assert.equal(buildSectionText(), buildSectionText())
  })

  it('不含任何随日期或数据变化的内容', () => {
    const text = buildSectionText()
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), 'section 里不该出现具体日期')
    for (const leak of ['当前有', '条待办', '条未完成']) {
      assert.ok(!text.includes(leak), `section 里不该出现动态内容：${leak}`)
    }
  })

  it('四条铁律各自的关键约定都在场', () => {
    const text = buildSectionText()
    // 铁律一：完成权归用户
    assert.match(text, /confirmedByUser|用户确认/)
    // 铁律二：默认零录入
    assert.match(text, /不要.*填|不强制|零录入/)
    // 铁律三：只在两种异常时主动开口
    assert.match(text, /连续顺延|不可能达成/)
    // 铁律四：只给正向积累
    assert.match(text, /正向|不许.*百分比|不要.*百分比/)
  })

  it('写明了往日计划构成冻结与可回填的边界', () => {
    const text = buildSectionText()
    assert.match(text, /冻结/)
  })

  it('给出排计划的执行顺序', () => {
    const text = buildSectionText()
    assert.match(text, /plan_context/)
  })

  it('名字是带命名空间的常量', () => {
    assert.equal(PLANNER_SECTION_NAME, 'planner:rules')
    assert.equal(PLANNER_CONTEXT_NAME, 'planner:today')
  })
})

// ───────────────────────── 动态 context ─────────────────────────

describe('动态 context（今日摘要）', () => {
  it('同一份数据两次生成完全一致（§6.3：同日稳定）', () => {
    const { data } = seeded()
    assert.equal(buildContextText(data, TODAY), buildContextText(data, TODAY))
  })

  it('完全空的数据返回空串 —— 没话可说就不要占每轮的 token', () => {
    assert.equal(buildContextText(emptyData(), TODAY), '')
  })

  it('有目标但还没排过计划时，仍然给出存在感（否则模型会忘了去查）', () => {
    const data = emptyData()
    saveGoal(data, { title: '学英语', mode: 'longterm' }, TODAY)
    const text = buildContextText(data, TODAY)
    assert.notEqual(text, '')
    assert.ok(text.includes('学英语'))
  })

  it('带出今天的计划与未完成条目', () => {
    const { data } = seeded()
    const plan = writePlan(data, TODAY, [
      { title: '背单词', estimateMin: 15 },
      { title: '拉伸', estimateMin: 10 },
    ], TODAY)
    updatePlanItem(data, TODAY, plan.items[0].id, { status: 'done' })
    const text = buildContextText(data, TODAY)
    assert.ok(text.includes('拉伸'), '未完成的条目应在摘要里')
    assert.ok(text.includes('背单词') || /已完成\s*1/.test(text), '应体现已完成数量')
  })

  it('带出昨日未完成项，让模型知道该去追问', () => {
    const { data } = seeded()
    const text = buildContextText(data, TODAY)
    assert.ok(text.includes('跑 3 公里'), '昨日未完成项应出现在摘要里')
  })

  it('有期限目标按当前速度不可能达成时，给出一条预警', () => {
    const { data } = seeded()
    const text = buildContextText(data, TODAY)
    assert.match(text, /跑 10 公里/)
    assert.match(text, /预警|超期|来不及|达不成/)
  })

  it('长期目标未达积累门槛时，摘要里不出现任何该目标的计数', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, TODAY)
    // 只完成 2 次，未达门槛（5）
    for (let i = 0; i < 2; i += 1) {
      const date = `2026-05-0${9 - i}`
      const plan = writePlan(data, date, [{ title: 'x', goalId: goal.id, estimateMin: 10 }], date)
      updatePlanItem(data, date, plan.items[0].id, { status: 'done' })
    }
    const text = buildContextText(data, TODAY)
    assert.ok(!/\d+\s*次/.test(text), `未达门槛不该出现次数：${text}`)
    assert.ok(!text.includes('累计'), '未达门槛不该出现累计字样')
  })

  it('长期目标达到门槛时才出现正向积累，且是正向措辞', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, TODAY)
    for (let i = 0; i < 5; i += 1) {
      const date = `2026-05-${String(10 - i).padStart(2, '0')}`
      const plan = writePlan(data, date, [{ title: 'x', goalId: goal.id, estimateMin: 10 }], date)
      updatePlanItem(data, date, plan.items[0].id, { status: 'done' })
    }
    const text = buildContextText(data, TODAY)
    assert.ok(text.includes('学英语'))
    assert.match(text, /累计|坚持|第\s*\d+\s*次/)
  })

  it('铁律四守卫：摘要里绝不出现负面进度措辞', () => {
    const { data } = seeded()
    writePlan(data, TODAY, [{ title: '背单词', estimateMin: 15 }], TODAY)
    const text = buildContextText(data, TODAY)
    for (const banned of ['%', '％', '落后', '还差', '剩余进度', '进度不足', '未达标']) {
      assert.ok(!text.includes(banned), `铁律四：摘要里不该出现「${banned}」→ ${text}`)
    }
  })

  it('铁律四守卫：长期目标不参与速度/超期类表述', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, TODAY)
    saveTask(data, { title: '背单词', goalId: goal.id, estimateMin: 600 })
    const text = buildContextText(data, TODAY)
    assert.ok(!/超期|来不及|达不成/.test(text), `长期目标不该有节奏预警：${text}`)
  })

  it('已完成的目标从摘要里消失', () => {
    const { data, longterm } = seeded()
    completeGoal(data, longterm.id, true)
    const text = buildContextText(data, TODAY)
    assert.ok(!text.includes('学英语'))
  })

  it('体积预算：摘要必须短，防止有人把整个任务池倒进来', () => {
    const { data } = seeded()
    // 往池里灌很多任务，摘要不该跟着膨胀
    for (let i = 0; i < 60; i += 1) saveTask(data, { title: `灌水任务 ${i}`, estimateMin: 15 })
    writePlan(data, TODAY, Array.from({ length: 20 }, (_, i) => ({ title: `今日条目 ${i}`, estimateMin: 15 })), TODAY)
    const text = buildContextText(data, TODAY)
    assert.ok(text.length < 900, `摘要长度 ${text.length} 超出预算：多的条目应该被折叠成计数`)
  })
})

// ───────────────────────── §4.5 调节规则必须在场 ─────────────────────────

describe('§4.5 难度调节规则写在了 section 里', () => {
  it('加量、减量、最小剂量三件事都有交代', () => {
    const text = buildSectionText()
    assert.match(text, /加量/, '要说清完成得好会加量')
    assert.match(text, /减量/, '要说清完不成会减量')
    assert.match(text, /最小剂量/, '要有不可再降的下限')
  })

  it('要求不告知用户具体数值（否则就从"静默"变回"压力"了）', () => {
    assert.match(buildSectionText(), /不要.*报出具体数字|不要告诉用户/)
  })

  it('点明最小剂量是防"无声停摆"的安全网，而不只是一个参数', () => {
    assert.match(buildSectionText(), /停摆/)
  })

  it('明确长期目标不做超期预警（与 mode=deadline 划清界限）', () => {
    assert.match(buildSectionText(), /不参与.*赶不上|不参与.*预警/)
  })
})

// ───────────────────────── 行为测试暴露出的两个缺口 ─────────────────────────

describe('行为测试暴露的缺口（一次独立会话跑真实对话时踩到）', () => {
  it('禁止写占位式 reason —— 模型当时自己造了「待用户说明（尚未追问）」', () => {
    const text = buildSectionText()
    assert.match(text, /不要动那条记录|不要写.*占位/)
    assert.match(text, /留空本身/, '要说清"留空"本身就是有效状态，否则模型会自己发明一个')
  })

  it('说明今天已有计划时不要整表重写 —— 模型当时重写了一次，抹掉了已完成状态', () => {
    const text = buildSectionText()
    assert.match(text, /今天已经有计划|已经有计划时/)
    assert.match(text, /先看再改/)
    assert.match(text, /plan_item_update/, '要给出更省事的替代动作，而不只是说"别这么做"')
  })
})

describe('§4.5 要告诉模型旋钮在哪、依据是什么', () => {
  it('点明 dial 就是调量的旋钮（不然拿到数据也不知道那是用来拧的）', () => {
    const text = buildSectionText()
    assert.match(text, /dial/)
    assert.match(text, /goal_save/)
  })

  it('点明调量的两个依据来自 plan_context', () => {
    const text = buildSectionText()
    assert.match(text, /minDailyMinutes/)
    assert.match(text, /recentDailyMinutes/)
    assert.match(text, /盲调/, '要说清没有反馈就是盲调')
  })
})

// ───────────────────────── 摘要不能把同一件事重复列 ─────────────────────────

describe('今日摘要的去重', () => {
  it('同一条任务被顺延多天时，摘要里只出现一次（否则模型会问两遍同一件事）', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, '2026-05-01')
    const task = saveTask(data, { title: '跟读 3 句台词', goalId: goal.id, estimateMin: 5 })
    // 连续两天排进计划都没做
    for (const date of ['2026-05-08', '2026-05-09']) {
      const plan = writePlan(data, date, [{ taskId: task.id, title: '跟读 3 句台词', estimateMin: 5, goalId: goal.id }], date)
      updatePlanItem(data, date, plan.items[0].id, { status: 'missed' })
    }
    const text = buildContextText(data, '2026-05-10')
    const occurrences = text.split('跟读 3 句台词').length - 1
    assert.equal(occurrences, 1, `同一件事只该列一次，实际出现 ${occurrences} 次：\n${text}`)
    assert.match(text, /往日未完成 1 条/, '计数也该按"事情"算，不是按"条目"算')
  })

  it('没带 taskId 的独立待办按标题去重（同一件事不该算两件）', () => {
    const data = emptyData()
    for (const date of ['2026-05-08', '2026-05-09']) {
      writePlan(data, date, [{ title: '给妈妈打电话', estimateMin: 10 }], date)
    }
    const text = buildContextText(data, '2026-05-10')
    assert.equal(text.split('给妈妈打电话').length - 1, 1)
    assert.match(text, /往日未完成 1 条/)
  })

  it('确实是两件不同的事就都列出来', () => {
    const data = emptyData()
    writePlan(data, '2026-05-09', [
      { title: '给妈妈打电话', estimateMin: 10 },
      { title: '预约体检', estimateMin: 20 },
    ], '2026-05-09')
    const text = buildContextText(data, '2026-05-10')
    assert.match(text, /往日未完成 2 条/)
    assert.ok(text.includes('给妈妈打电话') && text.includes('预约体检'))
  })
})

// ───────────────────────── 用户决定：直接问就给直观进展 ─────────────────────────

describe('§4.7：门槛只管主动展示，不拦用户直接问', () => {
  it('写明用户直接问进展时照实说（门槛不是让他瞒着）', () => {
    const text = buildSectionText()
    assert.match(text, /直接问/, '要有一条专门讲"用户直接问"的情形')
    assert.match(text, /照实说|直接告诉他|直说/, '要说清这时候该给')
  })

  it('即便如此，仍然不给百分比与落后提示（铁律四的底线不因用户问了而放开）', () => {
    const text = buildSectionText()
    const section = text.slice(text.indexOf('用户直接问') - 400, text.indexOf('用户直接问') + 400)
    assert.match(section, /百分比/)
  })
})

// ───────────────────────── 对话里打勾 + 整理备注的工作流 ─────────────────────────

describe('用户在对话里说"我做完了"', () => {
  it('说明要标成 done —— 用户的明确陈述等同于他自己勾选（铁律一）', () => {
    const text = buildSectionText()
    assert.match(text, /做完了|完成了/, '要有这条工作流')
    assert.match(text, /plan_item_update/)
    assert.match(text, /等同于/, '要讲清为什么模型有权这么做')
  })

  it('说明要顺手问一句想法，并整理进 note', () => {
    const text = buildSectionText()
    assert.match(text, /note/)
    assert.match(text, /想法|感受|心得/)
  })

  it('问一次就够，用户不说就算了 —— 不要替他编（铁律二）', () => {
    const text = buildSectionText()
    assert.match(text, /只问一次|问一次/)
    assert.match(text, /不要替他编|不要编/)
  })
})
