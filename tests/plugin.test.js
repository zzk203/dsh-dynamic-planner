/**
 * 装配层测试 —— 测试先于实现。
 *
 * `index.js` 只负责 import shipped package 并把它们传进来，真正的接线在这里。
 * 这样接线逻辑可以用一个假 ctx 完整验证，而不需要真的启动一个 Cordis 宿主。
 *
 * 重点守两件事：
 *   - 动态 context 必须传**函数**而不是字符串，否则它会退化成"进程启动那一刻的快照"
 *   - 宿主没有 webServer 时，插件必须照常工作（工具与提示词还在），而不是整个不挂载
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyPlanner } from '../lib/plugin.js'
import { PLANNER_CONTEXT_NAME, PLANNER_SECTION_NAME } from '../lib/prompt.js'
import { API_PREFIX } from '../lib/routes.js'
import { loadData, saveData, saveGoal, emptyData } from '../lib/store.js'

const TODAY = '2026-05-10'
const TMP = mkdtempSync(join(tmpdir(), 'planner-plugin-'))
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))

let seq = 0
function dataFile() {
  seq += 1
  return join(TMP, `data-${seq}.json`)
}

const stubDefineTool = options => ({ ...options })

/** 假 ctx：只实现插件真正用到的那几个成员。 */
function fakeCtx({ withWebServer = true } = {}) {
  const record = {
    tools: [], sections: [], contexts: [], effects: [], injected: [], routes: [], logs: [],
  }
  const disposers = []
  const track = (off) => { disposers.push(off); return off }

  const ctx = {
    tools: {
      register(tool) {
        record.tools.push(tool)
        return track(() => { record.tools = record.tools.filter(entry => entry !== tool) })
      },
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section)
        return track(() => { record.sections = record.sections.filter(entry => entry !== section) })
      },
      context(context) {
        record.contexts.push(context)
        return track(() => { record.contexts = record.contexts.filter(entry => entry !== context) })
      },
      getSectionOrder(name) { assert.equal(name, 'TOOL_GOAL'); return 2400 },
      getContextOrder(name) { return name === 'SUBAGENT_DELEGATION' ? 120 : 0 },
    },
    effect(callback, name) {
      const off = callback()
      record.effects.push({ name, off })
      return track(typeof off === 'function' ? off : () => {})
    },
    inject(names, callback) {
      record.injected.push(names)
      if (!withWebServer) return
      const hostCtx = {
        webServer: {
          register(route) {
            record.routes.push(route)
            return track(() => { record.routes = record.routes.filter(entry => entry !== route) })
          },
        },
      }
      callback(hostCtx)
    },
    get(name) {
      if (name !== 'logger') return undefined
      return {
        info: message => record.logs.push(['info', message]),
        warn: message => record.logs.push(['warn', message]),
      }
    },
  }
  return { ctx, record, disposeAll: () => { for (const off of disposers.splice(0)) { try { off() } catch { /* 已释放 */ } } } }
}

function applyTo(options = {}) {
  const harness = fakeCtx(options)
  const file = dataFile()
  applyPlanner(harness.ctx, {}, { defineTool: stubDefineTool, dataFile: file, version: '9.9.9', now: () => TODAY })
  return { ...harness, file }
}

// ───────────────────────── 工具注册 ─────────────────────────

describe('装配：工具', () => {
  it('把 9 个工具全部注册到全局 ctx.tools', () => {
    const { record } = applyTo()
    assert.equal(record.tools.length, 9)
    assert.ok(record.tools.every(tool => typeof tool.execute === 'function'))
  })

  it('用的是注入进来的 defineTool（而不是自己另造一套 schema 编译）', () => {
    let calls = 0
    const spy = options => { calls += 1; return { ...options } }
    const harness = fakeCtx()
    applyPlanner(harness.ctx, {}, { defineTool: spy, dataFile: dataFile(), now: () => TODAY })
    assert.equal(calls, 9)
    assert.equal(harness.record.tools.length, 9)
  })
})

// ───────────────────────── 提示词注册 ─────────────────────────

describe('装配：提示词', () => {
  it('注册静态 section，名字与 order 都正确', () => {
    const { record } = applyTo()
    assert.equal(record.sections.length, 1)
    const [section] = record.sections
    assert.equal(section.name, PLANNER_SECTION_NAME)
    assert.ok(section.order > 2400, 'section 应排在 TOOL_GOAL 之后')
    assert.equal(typeof section.text, 'string', 'section 必须是静态字符串，不能是函数')
    assert.equal(section.interpolate, false, '文本是字面量，不该走变量插值')
  })

  it('注册动态 context —— 传的必须是函数，不是启动时的快照', () => {
    const { record } = applyTo()
    assert.equal(record.contexts.length, 1)
    const [context] = record.contexts
    assert.equal(context.name, PLANNER_CONTEXT_NAME)
    assert.equal(typeof context.text, 'function', 'context 必须是函数，否则会固化成启动那一刻的状态')
    assert.ok(context.order > 120, 'context 应排在宿主自带 context 之后')
  })

  it('context 每次求值都反映当前数据（不是缓存住的老状态）', async () => {
    const { record, file, ctx } = applyTo()
    const [context] = record.contexts
    assert.equal(context.text(), '', '空数据时摘要为空串')

    // 从插件自己的工具写数据，再问摘要
    const goalSave = record.tools.find(tool => tool.name === 'goal_save')
    await goalSave.execute({ title: '学英语', mode: 'longterm' }, {})
    assert.match(context.text(), /学英语/, '摘要应反映刚写入的数据')
    assert.ok(readFileSync(file, 'utf8').includes('学英语'), '数据应已落盘')
    assert.ok(ctx, '保持引用避免未使用告警')
  })

  it('插件不往 section 里塞任何动态内容（缓存纪律在装配层同样成立）', async () => {
    const { record } = applyTo()
    const [section] = record.sections
    const before = section.text
    const goalSave = record.tools.find(tool => tool.name === 'goal_save')
    await goalSave.execute({ title: '学英语', mode: 'longterm' }, {})
    assert.equal(section.text, before, 'section 不该随数据变化')
  })
})

// ───────────────────────── 路由挂载 ─────────────────────────

describe('装配：路由', () => {
  it('宿主有 webServer 时挂上 5 个端点，并把 version 透出去', async () => {
    const { record } = applyTo()
    assert.deepEqual(record.injected, [['webServer']])
    assert.equal(record.routes.length, 5)
    assert.ok(record.routes.every(route => route.path.startsWith(API_PREFIX)))

    const state = record.routes.find(route => route.path.endsWith('/state'))
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(text) { this.text = text },
    }
    await state.handler({ method: 'GET', url: `${API_PREFIX}/state`, on() { return this } }, res)
    assert.equal(JSON.parse(res.text).version, '9.9.9')
  })

  it('宿主没有 webServer 时，插件照常装配工具与提示词，而不是整个不挂载', () => {
    const { record } = applyTo({ withWebServer: false })
    assert.equal(record.tools.length, 9, '工具必须还在 —— 对话那条路不能因为没界面就断掉')
    assert.equal(record.sections.length, 1)
    assert.equal(record.contexts.length, 1)
    assert.equal(record.routes.length, 0)
  })
})

// ───────────────────────── 生命周期 ─────────────────────────

describe('装配：生命周期', () => {
  it('所有注册都通过 ctx.effect，名字带命名空间', () => {
    const { record } = applyTo()
    const names = record.effects.map(entry => entry.name)
    assert.equal(names.length, 12, '9 个工具 + 1 个 section + 1 个 context + 1 组路由')
    assert.ok(names.every(name => typeof name === 'string' && name.startsWith('dsh-dynamic-planner:')),
      `effect 名字应带命名空间：${names.join(', ')}`)
  })

  it('释放后不留残余注册', () => {
    const { record, disposeAll } = applyTo()
    disposeAll()
    assert.equal(record.tools.length, 0)
    assert.equal(record.sections.length, 0)
    assert.equal(record.contexts.length, 0)
    assert.equal(record.routes.length, 0)
  })

  it('数据文件是坏 JSON 时记一条 warn 并重置，不阻断装配', () => {
    const file = dataFile()
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const harness = fakeCtx()
    applyPlanner(harness.ctx, {}, { defineTool: stubDefineTool, dataFile: file, now: () => TODAY })
    assert.equal(harness.record.tools.length, 9, '工具必须照常注册')
    assert.ok(
      harness.record.logs.some(([level, message]) => level === 'warn' && message.includes('损坏')),
      `应记一条 warn：${JSON.stringify(harness.record.logs)}`,
    )
  })

  it('结构不完整（字段类型不对）时静默规范化，不必打扰用户', () => {
    const file = dataFile()
    saveData(file, { goals: 'not-an-array', tasks: null, plans: 3 })
    const harness = fakeCtx()
    applyPlanner(harness.ctx, {}, { defineTool: stubDefineTool, dataFile: file, now: () => TODAY })
    assert.deepEqual(loadData(file).goals, [])
    assert.ok(!harness.record.logs.some(([level]) => level === 'warn'))
  })

  it('复用一个已存在的数据文件（重启后接着用）', () => {
    const file = dataFile()
    const data = emptyData()
    saveGoal(data, { title: '学英语', mode: 'longterm' }, TODAY)
    saveData(file, data)

    const harness = fakeCtx()
    applyPlanner(harness.ctx, {}, { defineTool: stubDefineTool, dataFile: file, now: () => TODAY })
    const [context] = harness.record.contexts
    assert.match(context.text(), /学英语/)
  })
})
