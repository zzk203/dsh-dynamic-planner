/**
 * 数据层测试 —— 对着 REQUIREMENTS.md 的条款写，不是对着实现写。
 *
 * 每个 describe 的标题都标出它守的是哪一条：这样将来改需求时，
 * 能直接看出"哪条需求的守卫测试要一起改"，而不是盲改断言。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aggregateRange,
  clampDial,
  completeGoal,
  createStore,
  dateKey,
  daysBetween,
  emptyData,
  getPlan,
  goalMomentum,
  goalOverview,
  goalPace,
  loadData,
  pendingBefore,
  quickAddTask,
  recentStats,
  saveData,
  saveGoal,
  saveTask,
  shiftDate,
  todayView,
  unexplained,
  updatePlanItem,
  weekStartKey,
  weeklyAggregate,
  writePlan,
} from '../lib/store.js'

const TMP = mkdtempSync(join(tmpdir(), 'planner-test-'))
after(() => { rmSync(TMP, { recursive: true, force: true }) })

let fileSeq = 0
function tempFile() {
  fileSeq += 1
  return join(TMP, `data-${fileSeq}.json`)
}

/** 造一个已存在的计划，省去每个测试重复调 writePlan。 */
function seedPlan(data, date, items, today) {
  return writePlan(data, date, items, today)
}

// ───────────────────────── §日期工具 ─────────────────────────

describe('日期工具', () => {
  it('dateKey 用本地时区，深夜不串日', () => {
    // 23:30 本地时间：用 toISOString() 会跑到第二天，这是真实踩过的坑
    const late = new Date(2026, 0, 2, 23, 30, 0)
    assert.equal(dateKey(late), '2026-01-02')
    const early = new Date(2026, 0, 2, 0, 30, 0)
    assert.equal(dateKey(early), '2026-01-02')
  })

  it('shiftDate 正确跨月与跨年', () => {
    assert.equal(shiftDate('2026-03-01', -1), '2026-02-28')
    assert.equal(shiftDate('2026-01-01', -1), '2025-12-31')
    assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
    assert.equal(shiftDate('2024-02-28', 1), '2024-02-29') // 闰年
    assert.equal(shiftDate('2026-05-10', 0), '2026-05-10')
  })

  it('daysBetween 是整天数且带符号', () => {
    assert.equal(daysBetween('2026-05-01', '2026-05-10'), 9)
    assert.equal(daysBetween('2026-05-10', '2026-05-01'), -9)
    assert.equal(daysBetween('2026-05-10', '2026-05-10'), 0)
  })
})

// ───────────────────────── §持久化 ─────────────────────────

describe('持久化', () => {
  it('文件不存在时返回空数据', () => {
    const data = loadData(tempFile())
    assert.deepEqual(data, emptyData())
  })

  it('saveData / loadData 往返一致', () => {
    const file = tempFile()
    const data = emptyData()
    saveGoal(data, { title: '学英语', mode: 'longterm' }, '2026-05-10')
    saveData(file, data)
    const back = loadData(file)
    assert.equal(back.goals.length, 1)
    assert.equal(back.goals[0].title, '学英语')
  })

  it('损坏文件不抛错，重置为空的并另存 .corrupt-*', () => {
    const file = tempFile()
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const warnings = []
    const data = loadData(file, message => warnings.push(message))
    assert.deepEqual(data, emptyData())
    assert.equal(warnings.length, 1)
    assert.ok(readdirSync(TMP).some(name => name.startsWith(`data-${fileSeq}.json.corrupt-`)))
  })
})

// ───────────────────────── §3.1 目标的双模式 ─────────────────────────

describe('目标：双模式（§3.1）', () => {
  it('不给 mode 时默认长期目标', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语' }, '2026-05-10')
    assert.equal(goal.mode, 'longterm')
    assert.equal(goal.status, 'active')
  })

  it('声明 deadline 模式但没给截止日 → 降级为长期目标，不留坏状态', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语', mode: 'deadline' }, '2026-05-10')
    assert.equal(goal.mode, 'longterm')
  })

  it('有截止日的目标保持 deadline 模式', () => {
    const data = emptyData()
    const goal = saveGoal(
      data,
      { title: '跑 10 公里', mode: 'deadline', deadline: '2026-06-01', criteria: '能独立跑完 10 公里' },
      '2026-05-10',
    )
    assert.equal(goal.mode, 'deadline')
    assert.equal(goal.deadline, '2026-06-01')
    assert.equal(goal.criteria, '能独立跑完 10 公里')
  })

  it('模式可从长期切到有期限，也可切回', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '跑步', mode: 'longterm' }, '2026-05-10')
    saveGoal(data, { id: goal.id, mode: 'deadline', deadline: '2026-06-01' }, '2026-05-10')
    assert.equal(goal.mode, 'deadline')
    saveGoal(data, { id: goal.id, mode: 'longterm' }, '2026-05-10')
    assert.equal(goal.mode, 'longterm')
  })
})

// ───────────────────────── 铁律一：目标完成由用户拍板 ─────────────────────────

describe('铁律一：目标完成必须由用户确认', () => {
  it('未确认时拒绝标记完成', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '跑步' }, '2026-05-10')
    assert.throws(() => completeGoal(data, goal.id, false), /用户确认/)
    assert.throws(() => completeGoal(data, goal.id, undefined), /用户确认/)
    assert.equal(goal.status, 'active')
  })

  it('确认后置为完成并记录时间', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '跑步' }, '2026-05-10')
    completeGoal(data, goal.id, true)
    assert.equal(goal.status, 'done')
    assert.ok(goal.completedAt)
  })

  it('目标完成时，它名下还在池里的任务被移出池（不再被排进任何计划）', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '跑步' }, '2026-05-10')
    const task = saveTask(data, { title: '慢跑 20 分钟', goalId: goal.id, estimateMin: 20 })
    completeGoal(data, goal.id, true)
    assert.equal(task.status, 'dropped')
  })

  it('目标不存在时报错而不是静默成功', () => {
    const data = emptyData()
    assert.throws(() => completeGoal(data, 'goal_nope', true), /不存在/)
  })
})

// ───────────────────────── §4.5 难度旋钮 ─────────────────────────

describe('§4.5 难度旋钮有下限', () => {
  it('clampDial 夹在 [0.2, 3]', () => {
    assert.equal(clampDial(0), 0.2)
    assert.equal(clampDial(-5), 0.2)
    assert.equal(clampDial(99), 3)
    assert.equal(clampDial(1.5), 1.5)
    assert.equal(clampDial('nonsense'), 1)
  })

  it('saveGoal 落库时同样夹紧', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '学英语', dial: 0 }, '2026-05-10')
    assert.equal(goal.dial, 0.2)
  })
})

// ───────────────────────── 任务池 ─────────────────────────

describe('任务池', () => {
  it('新建任务默认进池，无归属、零顺延', () => {
    const data = emptyData()
    const task = saveTask(data, { title: '背单词' })
    assert.equal(task.status, 'pool')
    assert.equal(task.goalId, null)
    assert.equal(task.deferCount, 0)
    assert.equal(task.plannedFor, null)
  })

  it('预估耗时：没说就用默认 15，说了正数就至少 1 分钟', () => {
    const data = emptyData()
    assert.equal(saveTask(data, { title: 'a' }).estimateMin, 15)
    assert.equal(saveTask(data, { title: 'b', estimateMin: 0 }).estimateMin, 15)      // 0 视为"没说"
    assert.equal(saveTask(data, { title: 'c', estimateMin: -5 }).estimateMin, 15)     // 负数视为"没说"
    assert.equal(saveTask(data, { title: 'd', estimateMin: 'abc' }).estimateMin, 15)
    assert.equal(saveTask(data, { title: 'e', estimateMin: 0.4 }).estimateMin, 1)     // 正数下限 1 分钟
    assert.equal(saveTask(data, { title: 'f', estimateMin: 2.6 }).estimateMin, 3)     // 四舍五入
  })

  it('随手加的一条待办没有目标归属（需求 1：用户可以自己编写待完成事项）', () => {
    const data = emptyData()
    const task = quickAddTask(data, '给妈妈打电话')
    assert.equal(task.goalId, null)
    assert.equal(task.status, 'pool')
  })
})

// ───────────────────────── P4：往日计划构成冻结 ─────────────────────────

describe('P4：往日计划构成冻结', () => {
  it('不能往日的日期整体重写计划（那是改账本）', () => {
    const data = emptyData()
    assert.throws(
      () => writePlan(data, '2026-05-09', [{ title: 'x', estimateMin: 10 }], '2026-05-10'),
      /冻结/,
    )
  })

  it('今天可以写，明天也可以写', () => {
    const data = emptyData()
    assert.doesNotThrow(() => writePlan(data, '2026-05-10', [{ title: 'a', estimateMin: 10 }], '2026-05-10'))
    assert.doesNotThrow(() => writePlan(data, '2026-05-11', [{ title: 'b', estimateMin: 10 }], '2026-05-10'))
  })

  it('往日条目仍可回填状态与未完成原因（LLM 第二天要写回去）', () => {
    const data = emptyData()
    const plan = writePlan(data, '2026-05-09', [{ title: '跑步', estimateMin: 30 }], '2026-05-09')
    const itemId = plan.items[0].id
    updatePlanItem(data, '2026-05-09', itemId, { status: 'missed' })
    updatePlanItem(data, '2026-05-09', itemId, { reason: '下班太晚，没时间' })
    assert.equal(plan.items[0].status, 'missed')
    assert.equal(plan.items[0].reason, '下班太晚，没时间')
  })

  it('不能把往日条目的预估耗时改掉（构成冻结）', () => {
    const data = emptyData()
    const plan = writePlan(data, '2026-05-09', [{ title: '跑步', estimateMin: 30 }], '2026-05-09')
    updatePlanItem(data, '2026-05-09', plan.items[0].id, { estimateMin: 5 })
    assert.equal(plan.items[0].estimateMin, 30)
  })

  it('更新不存在的条目会报错，不静默吞掉', () => {
    const data = emptyData()
    writePlan(data, '2026-05-10', [{ title: 'a', estimateMin: 10 }], '2026-05-10')
    assert.throws(() => updatePlanItem(data, '2026-05-10', 'item_nope', { status: 'done' }), /不存在/)
    assert.throws(() => updatePlanItem(data, '2026-05-08', 'item_nope', { status: 'done' }), /没有计划/)
  })

  it('非法状态被拒绝', () => {
    const data = emptyData()
    const plan = writePlan(data, '2026-05-10', [{ title: 'a', estimateMin: 10 }], '2026-05-10')
    assert.throws(() => updatePlanItem(data, '2026-05-10', plan.items[0].id, { status: '半途而废' }), /非法状态/)
  })
})

// ───────────────────────── 计划项 → 任务池的状态回流 ─────────────────────────

describe('计划项状态回流任务池', () => {
  it('勾选完成 → 任务出池，顺延计数归零', () => {
    const data = emptyData()
    const task = saveTask(data, { title: '背单词', estimateMin: 20 })
    const plan = writePlan(data, '2026-05-10', [{ taskId: task.id, title: '背单词', estimateMin: 20 }], '2026-05-10')
    updatePlanItem(data, '2026-05-10', plan.items[0].id, { status: 'done' })
    assert.equal(task.status, 'done')
    assert.equal(task.deferCount, 0)
  })

  it('未完成 → 任务回池，顺延计数 +1（这是 §4.6 异常上报的计数来源）', () => {
    const data = emptyData()
    const task = saveTask(data, { title: '背单词', estimateMin: 20 })
    const plan = writePlan(data, '2026-05-10', [{ taskId: task.id, title: '背单词', estimateMin: 20 }], '2026-05-10')
    updatePlanItem(data, '2026-05-10', plan.items[0].id, { status: 'missed' })
    assert.equal(task.status, 'pool')
    assert.equal(task.deferCount, 1)
    assert.equal(task.plannedFor, null)
  })

  it('完成会清零累积的顺延计数', () => {
    const data = emptyData()
    const task = saveTask(data, { title: '背单词', estimateMin: 20 })
    task.deferCount = 3
    const plan = writePlan(data, '2026-05-10', [{ taskId: task.id, title: '背单词', estimateMin: 20 }], '2026-05-10')
    updatePlanItem(data, '2026-05-10', plan.items[0].id, { status: 'done' })
    assert.equal(task.deferCount, 0)
  })
})

// ───────────────────────── §4.3 排计划的输入 ─────────────────────────

describe('§4.3 排今日计划的输入', () => {
  it('pendingBefore 只给今天之前仍未完成的项，按日期升序', () => {
    const data = emptyData()
    writePlan(data, '2026-05-08', [{ title: '旧账A', estimateMin: 10 }], '2026-05-08')
    writePlan(data, '2026-05-09', [{ title: '旧账B', estimateMin: 10 }], '2026-05-09')
    writePlan(data, '2026-05-10', [{ title: '今天的', estimateMin: 10 }], '2026-05-10')
    const pending = pendingBefore(data, '2026-05-10')
    assert.deepEqual(pending.map(item => item.title), ['旧账A', '旧账B'])
    assert.deepEqual(pending.map(item => item.date), ['2026-05-08', '2026-05-09'])
  })

  it('unexplained 只给已判 missed 且还没写原因的项（追问的靶子）', () => {
    const data = emptyData()
    const plan = writePlan(data, '2026-05-09', [
      { title: '没做且没说原因', estimateMin: 10 },
      { title: '没做但已说原因', estimateMin: 10 },
      { title: '做完了', estimateMin: 10 },
    ], '2026-05-09')
    updatePlanItem(data, '2026-05-09', plan.items[0].id, { status: 'missed' })
    updatePlanItem(data, '2026-05-09', plan.items[1].id, { status: 'missed', reason: '加班' })
    updatePlanItem(data, '2026-05-09', plan.items[2].id, { status: 'done' })
    const targets = unexplained(data, '2026-05-10')
    assert.deepEqual(targets.map(item => item.title), ['没做且没说原因'])
  })

  it('池里不重复出现今天已经排过的任务', () => {
    const data = emptyData()
    const task = saveTask(data, { title: '背单词', estimateMin: 20 })
    writePlan(data, '2026-05-10', [{ taskId: task.id, title: '背单词', estimateMin: 20 }], '2026-05-10')
    const view = todayView(data, '2026-05-10')
    assert.deepEqual(view.pool, [])
  })

  it('今天没排过的池任务会出现在 pool 里，并带顺延次数', () => {
    const data = emptyData()
    const task = saveTask(data, { title: '背单词', estimateMin: 20 })
    task.deferCount = 2
    const view = todayView(data, '2026-05-10')
    assert.equal(view.pool.length, 1)
    assert.equal(view.pool[0].deferCount, 2)
  })
})

// ───────────────────────── 聚合 ─────────────────────────

describe('聚合', () => {
  it('aggregateRange 按目标分桶并区分 planned/done/minutes', () => {
    const data = emptyData()
    const goal = saveGoal(data, { title: '跑步', mode: 'deadline', deadline: '2026-06-01' }, '2026-05-01')
    const plan = writePlan(data, '2026-05-09', [
      { title: '慢跑', goalId: goal.id, estimateMin: 30 },
      { title: '拉伸', goalId: goal.id, estimateMin: 10 },
      { title: '随手事', estimateMin: 15 },
    ], '2026-05-09')
    updatePlanItem(data, '2026-05-09', plan.items[0].id, { status: 'done' })
    updatePlanItem(data, '2026-05-09', plan.items[1].id, { status: 'missed' })
    updatePlanItem(data, '2026-05-09', plan.items[2].id, { status: 'done' })

    const agg = aggregateRange(data, '2026-05-03', '2026-05-09')
    assert.equal(agg.planned, 3)
    assert.equal(agg.done, 2)
    assert.equal(agg.missed, 1)
    assert.equal(agg.plannedMinutes, 55)
    assert.equal(agg.doneMinutes, 45)
    assert.deepEqual(agg.byGoal[goal.id], { planned: 2, done: 1, plannedMinutes: 40, doneMinutes: 30 })
  })

  it('aggregateRange 是闭区间，边界日都算进去', () => {
    const data = emptyData()
    writePlan(data, '2026-05-03', [{ title: '边界起点', estimateMin: 10 }], '2026-05-03')
    writePlan(data, '2026-05-09', [{ title: '边界终点', estimateMin: 10 }], '2026-05-09')
    writePlan(data, '2026-05-02', [{ title: '区间外', estimateMin: 10 }], '2026-05-02')
    assert.equal(aggregateRange(data, '2026-05-03', '2026-05-09').planned, 2)
  })

  it('recentStats 给逐日汇总，缺计划的日期补 0 而不是缺行', () => {
    const data = emptyData()
    const plan = writePlan(data, '2026-05-10', [{ title: 'a', estimateMin: 25 }], '2026-05-10')
    updatePlanItem(data, '2026-05-10', plan.items[0].id, { status: 'done' })
    const stats = recentStats(data, '2026-05-10', 3)
    assert.deepEqual(stats.map(day => day.date), ['2026-05-08', '2026-05-09', '2026-05-10'])
    assert.deepEqual(stats[2], { date: '2026-05-10', planned: 1, done: 1, minutes: 25 })
    assert.deepEqual(stats[0], { date: '2026-05-08', planned: 0, done: 0, minutes: 0 })
  })
})

// ───────────────────────── §4.6 速度预警 ─────────────────────────

describe('§4.6 有期限目标的速度预警', () => {
  function deadlineGoalWithLoad(data, today, estimateMin) {
    const goal = saveGoal(
      data,
      { title: '跑 10 公里', mode: 'deadline', deadline: shiftDate(today, 10) },
      today,
    )
    saveTask(data, { title: '长距离慢跑', goalId: goal.id, estimateMin })
    // 近 7 天只产出了 60 分钟
    const plan = writePlan(data, shiftDate(today, -1), [{ title: '慢跑', goalId: goal.id, estimateMin: 60 }], shiftDate(today, -1))
    updatePlanItem(data, shiftDate(today, -1), plan.items[0].id, { status: 'done' })
    return goal
  }

  it('按当前速度会超期时 willMiss 为真，并给出算式所需的三项数字', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = deadlineGoalWithLoad(data, today, 600)
    const pace = goalPace(data, goal, today)
    assert.equal(pace.daysLeft, 10)
    assert.equal(pace.remainingMinutes, 600)
    assert.equal(pace.requiredDailyMinutes, 60)
    assert.equal(pace.recentDailyMinutes, 8.6) // 60 / 7 天，保留一位
    assert.equal(pace.willMiss, true)
  })

  it('进度足够快时不预警', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = deadlineGoalWithLoad(data, today, 30)
    assert.equal(goalPace(data, goal, today).willMiss, false)
  })

  it('截止日已过 → 一定预警', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: 'x', mode: 'deadline', deadline: '2026-05-01' }, today)
    saveTask(data, { title: 't', goalId: goal.id, estimateMin: 30 })
    const pace = goalPace(data, goal, today)
    assert.ok(pace.daysLeft < 0)
    assert.equal(pace.willMiss, true)
  })

  it('长期目标不做速度预警（§3.1：不制造紧迫感）', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    assert.equal(goalPace(data, goal, today), null)
  })

  it('已完成的目标不再预警', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = deadlineGoalWithLoad(data, today, 600)
    completeGoal(data, goal.id, true)
    assert.equal(goalPace(data, goal, today), null)
  })
})

// ───────────────────────── §4.7 铁律四：只给正向积累 ─────────────────────────

describe('§4.7 铁律四：正向积累与浮现门槛', () => {
  function goalWithDoneDays(data, goalId, today, days) {
    for (let i = 0; i < days; i += 1) {
      const date = shiftDate(today, -i)
      const plan = writePlan(data, date, [{ title: 'x', goalId, estimateMin: 10 }], date)
      updatePlanItem(data, date, plan.items[0].id, { status: 'done' })
    }
  }

  it('统计累计次数与连续天数', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    goalWithDoneDays(data, goal.id, today, 3)
    const momentum = goalMomentum(data, goal)
    assert.equal(momentum.total, 3)
    assert.equal(momentum.streak, 3)
  })

  it('未达门槛时不显示（避免退化成打卡压力）', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    goalWithDoneDays(data, goal.id, today, 4)
    assert.equal(goalMomentum(data, goal).visible, false)
  })

  it('达到门槛才浮现，并给出下一个里程碑', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    goalWithDoneDays(data, goal.id, today, 5)
    const momentum = goalMomentum(data, goal)
    assert.equal(momentum.visible, true)
    assert.equal(momentum.total, 5)
    assert.equal(momentum.nextMilestone, 10)
  })

  it('中断后连续天数重新计数，但累计次数不回退', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    goalWithDoneDays(data, goal.id, today, 2)          // 05-10, 05-09
    const older = shiftDate(today, -4)                  // 05-06，中间隔了 05-07/05-08
    const plan = writePlan(data, older, [{ title: 'x', goalId: goal.id, estimateMin: 10 }], older)
    updatePlanItem(data, older, plan.items[0].id, { status: 'done' })
    const momentum = goalMomentum(data, goal)
    assert.equal(momentum.total, 3)
    assert.equal(momentum.streak, 2)
  })

  it('铁律四守卫：动量对象里不含任何负面进度字段', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    goalWithDoneDays(data, goal.id, today, 5)
    const keys = Object.keys(goalMomentum(data, goal))
    for (const banned of ['percent', 'percentage', 'progress', 'remaining', 'behind', 'pace', 'ratio']) {
      assert.ok(!keys.includes(banned), `动量对象不该含 ${banned}`)
    }
  })
})

// ───────────────────────── 视图层：铁律四的落点 ─────────────────────────

describe('视图层是铁律四的落点', () => {
  it('长期目标只给 momentum，不给 pace（负面节奏不上桌）', () => {
    const data = emptyData()
    const today = '2026-05-10'
    saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    const view = todayView(data, today)
    assert.equal(view.goals.length, 1)
    assert.notEqual(view.goals[0].momentum, null)
    assert.equal(view.goals[0].pace, null)
  })

  it('有期限目标只给 pace，不给 momentum', () => {
    const data = emptyData()
    const today = '2026-05-10'
    saveGoal(data, { title: '跑 10 公里', mode: 'deadline', deadline: '2026-06-01' }, today)
    const view = todayView(data, today)
    assert.notEqual(view.goals[0].pace, null)
    assert.equal(view.goals[0].momentum, null)
  })

  it('已完成的目标不出现在今日视图', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: 'x', mode: 'longterm' }, today)
    completeGoal(data, goal.id, true)
    assert.deepEqual(todayView(data, today).goals, [])
  })

  it('今日视图带出未完成的历史项，供 LLM 追问', () => {
    const data = emptyData()
    writePlan(data, '2026-05-09', [{ title: '昨天没做的', estimateMin: 20 }], '2026-05-09')
    const view = todayView(data, '2026-05-10')
    assert.deepEqual(view.pendingBefore.map(item => item.title), ['昨天没做的'])
  })

  it('计划项带上目标标题用于显示，但顶层不给任何百分比', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(data, { title: '学英语', mode: 'longterm' }, today)
    writePlan(data, today, [{ title: '背单词', goalId: goal.id, estimateMin: 10 }], today)
    const view = todayView(data, today)
    assert.equal(view.plan.items[0].goalTitle, '学英语')
    assert.ok(!JSON.stringify(view.goals).includes('percent'))
  })

  it('goalOverview 保留完整账本（供 LLM 与该视图的二级入口使用）', () => {
    const data = emptyData()
    const today = '2026-05-10'
    const goal = saveGoal(
      data,
      { title: '跑 10 公里', mode: 'deadline', deadline: '2026-06-01', criteria: '能独立跑完 10 公里' },
      today,
    )
    saveTask(data, { title: '长距离慢跑', goalId: goal.id, estimateMin: 60 })
    const [overview] = goalOverview(data, today)
    assert.equal(overview.title, '跑 10 公里')
    assert.equal(overview.criteria, '能独立跑完 10 公里')
    assert.equal(overview.poolTaskCount, 1)
    assert.equal(overview.deadline, '2026-06-01')
  })
})

// ───────────────────────── 按周聚合（温层） ─────────────────────────

describe('按周聚合', () => {
  it('weekStartKey 落在周一，周日归到本周', () => {
    assert.equal(weekStartKey('2026-05-04'), '2026-05-04') // 周一
    assert.equal(weekStartKey('2026-05-06'), '2026-05-04') // 周三
    assert.equal(weekStartKey('2026-05-10'), '2026-05-04') // 周日仍属本周
    assert.equal(weekStartKey('2026-05-11'), '2026-05-11') // 下周一
  })

  it('同一周的多个计划聚成一个桶', () => {
    const data = emptyData()
    for (const date of ['2026-05-06', '2026-05-07', '2026-05-08']) {
      const plan = writePlan(data, date, [{ title: 'x', estimateMin: 20 }], date)
      updatePlanItem(data, date, plan.items[0].id, { status: 'done' })
    }
    const buckets = weeklyAggregate(data, '2026-05-01', '2026-05-10')
    assert.equal(buckets.length, 1)
    assert.equal(buckets[0].week, '2026-05-04')
    assert.equal(buckets[0].to, '2026-05-10')
    assert.equal(buckets[0].planned, 3)
    assert.equal(buckets[0].done, 3)
    assert.equal(buckets[0].doneMinutes, 60)
  })

  it('跨周的日期分成多个桶并按周升序', () => {
    const data = emptyData()
    for (const date of ['2026-05-08', '2026-05-12']) {
      writePlan(data, date, [{ title: 'x', estimateMin: 10 }], date)
    }
    const buckets = weeklyAggregate(data, '2026-05-01', '2026-05-31')
    assert.deepEqual(buckets.map(bucket => bucket.week), ['2026-05-04', '2026-05-11'])
  })

  it('区间外的计划不进桶', () => {
    const data = emptyData()
    writePlan(data, '2026-04-30', [{ title: 'x', estimateMin: 10 }], '2026-04-30')
    assert.deepEqual(weeklyAggregate(data, '2026-05-01', '2026-05-31'), [])
  })
})

// ───────────────────────── 存储门面 ─────────────────────────

describe('createStore 存储门面', () => {
  it('read 每次都落到磁盘，不缓存（面板与 LLM 是两个写入方）', async () => {
    const file = tempFile()
    const store = createStore(file)
    await store.update(data => { saveGoal(data, { title: '学英语', mode: 'longterm' }, '2026-05-10') })
    assert.equal(store.read().goals.length, 1)

    // 绕过这个 store 实例直接改磁盘：如果再读还能看到，说明没有缓存
    const direct = loadData(file)
    saveGoal(direct, { title: '跑步', mode: 'longterm' }, '2026-05-10')
    saveData(file, direct)
    assert.equal(store.read().goals.length, 2)
  })

  it('变更函数抛错时不落盘（校验失败不该留下半成品）', async () => {
    const file = tempFile()
    const store = createStore(file)
    await store.update(data => { saveGoal(data, { title: '第一个', mode: 'longterm' }, '2026-05-10') })

    await assert.rejects(
      () => store.update(data => {
        saveGoal(data, { title: '会失败的', mode: 'longterm' }, '2026-05-10')
        throw new Error('校验没过')
      }),
      /校验没过/,
    )
    const after = store.read()
    assert.equal(after.goals.length, 1)
    assert.equal(after.goals[0].title, '第一个')
  })
})
