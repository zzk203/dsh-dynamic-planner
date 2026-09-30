/**
 * HTTP 路由测试 —— 测试先于实现。
 *
 * 分两层：
 *   - 业务层：直接调 handler，验证数据语义（这是主要价值）
 *   - 传输层：用假 req/res 走一遍 dispatch，验证状态码与 JSON 编解码
 *
 * §5.4 有一条"面板**不能**做什么"的约束，这里用"路由表里不存在对应端点"来守 ——
 * 能力缺失比能力存在更需要被测试，因为它不会在运行时报错，只会悄悄被加上。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { API_PREFIX, buildRouteTable, mountRoutes } from '../lib/routes.js'
import { emptyData, saveGoal, saveTask, updatePlanItem, writePlan } from '../lib/store.js'

const TODAY = '2026-05-10'

function memoryStore(data = emptyData()) {
  return { data, read: () => data, update(fn) { return fn(data) } }
}

function routesFor(store) {
  return buildRouteTable({ store, now: () => TODAY })
}

function handlerFor(table, method, path) {
  const entry = table.find(item => item.method === method && item.path === path)
  assert.ok(entry, `缺少路由 ${method} ${path}`)
  return entry.handler
}

function params(query = {}) {
  return new URLSearchParams(query)
}

// ───────────────────────── 路由表形状 ─────────────────────────

describe('路由表', () => {
  it('前缀带命名空间，不会和别的插件撞', () => {
    assert.equal(API_PREFIX, '/dynamic-planner/api')
  })

  it('恰好暴露 4 个端点，方法明确', () => {
    const table = routesFor(memoryStore())
    assert.deepEqual(
      table.map(entry => `${entry.method} ${entry.path}`).sort(),
      ['GET /goals', 'GET /state', 'POST /item', 'POST /task'],
    )
  })

  it('§5.4 守卫：面板没有新建目标、拆解任务的端点（能力缺失不会自己报错，只能靠测试守）', () => {
    const table = routesFor(memoryStore())
    const paths = table.map(entry => entry.path)
    for (const forbidden of ['/goal', '/goals/create', '/task/batch', '/plan']) {
      assert.ok(!paths.includes(forbidden), `面板不该能 ${forbidden}`)
    }
    // 创建类端点一律不存在；写操作只有"改一条已有条目"和"随手加一条待办"
    assert.deepEqual(table.filter(entry => entry.method === 'POST').map(entry => entry.path).sort(), ['/item', '/task'])
  })
})

// ───────────────────────── GET /state ─────────────────────────

describe('GET /state', () => {
  it('返回今日视图', async () => {
    const store = memoryStore()
    writePlan(store.data, TODAY, [{ title: '背单词', estimateMin: 15 }], TODAY)
    const value = await handlerFor(routesFor(store), 'GET', '/state')({ params: params() })
    assert.equal(value.ok, true)
    assert.equal(value.date, TODAY)
    assert.equal(value.today.plan.items.length, 1)
  })

  it('date 参数可查别的日期', async () => {
    const store = memoryStore()
    writePlan(store.data, '2026-05-09', [{ title: '旧的', estimateMin: 15 }], '2026-05-09')
    const value = await handlerFor(routesFor(store), 'GET', '/state')({ params: params({ date: '2026-05-09' }) })
    assert.equal(value.date, '2026-05-09')
    assert.equal(value.today.plan.items[0].title, '旧的')
  })

  it('空数据也返回结构完整的响应，面板不用做 null 判断', async () => {
    const value = await handlerFor(routesFor(memoryStore()), 'GET', '/state')({ params: params() })
    assert.equal(value.ok, true)
    assert.equal(value.today.plan, null)
    assert.deepEqual(value.today.pool, [])
    assert.deepEqual(value.today.goals, [])
  })

  it('铁律四守卫：长期目标在响应里没有 pace（负面节奏不上桌）', async () => {
    const store = memoryStore()
    saveGoal(store.data, { title: '学英语', mode: 'longterm' }, TODAY)
    const value = await handlerFor(routesFor(store), 'GET', '/state')({ params: params() })
    assert.equal(value.today.goals[0].pace, null)
  })
})

// ───────────────────────── GET /goals ─────────────────────────

describe('GET /goals（二级视图）', () => {
  it('返回目标总览，含完成标准与完成情况', async () => {
    const store = memoryStore()
    const goal = saveGoal(store.data, {
      title: '跑 10 公里', mode: 'deadline', deadline: '2026-06-01', criteria: '能独立跑完 10 公里',
    }, TODAY)
    saveTask(store.data, { title: '长距离慢跑', goalId: goal.id, estimateMin: 60 })
    const value = await handlerFor(routesFor(store), 'GET', '/goals')({ params: params() })
    assert.equal(value.ok, true)
    assert.equal(value.goals.length, 1)
    assert.equal(value.goals[0].criteria, '能独立跑完 10 公里')
    assert.equal(value.goals[0].poolTaskCount, 1)
  })
})

// ───────────────────────── POST /item ─────────────────────────

describe('POST /item（勾选、备注）', () => {
  function seeded() {
    const store = memoryStore()
    const task = saveTask(store.data, { title: '背单词', estimateMin: 15 })
    const plan = writePlan(store.data, TODAY, [{ taskId: task.id, title: '背单词', estimateMin: 15 }], TODAY)
    return { store, itemId: plan.items[0].id, task }
  }

  it('勾选完成', async () => {
    const { store, itemId, task } = seeded()
    const value = await handlerFor(routesFor(store), 'POST', '/item')({ body: { itemId, status: 'done' } })
    assert.equal(value.ok, true)
    assert.equal(value.item.status, 'done')
    assert.equal(task.status, 'done', '状态要回流任务池')
  })

  it('写自由备注', async () => {
    const { store, itemId } = seeded()
    const value = await handlerFor(routesFor(store), 'POST', '/item')({
      body: { itemId, note: '今天状态不错' },
    })
    assert.equal(value.item.note, '今天状态不错')
  })

  it('写未完成原因', async () => {
    const { store, itemId } = seeded()
    const value = await handlerFor(routesFor(store), 'POST', '/item')({
      body: { itemId, status: 'missed', reason: '临时开会' },
    })
    assert.equal(value.item.status, 'missed')
    assert.equal(value.item.reason, '临时开会')
  })

  it('缺 itemId 时给出能看懂的错误', async () => {
    const { store } = seeded()
    await assert.rejects(
      () => handlerFor(routesFor(store), 'POST', '/item')({ body: {} }),
      /itemId|计划项/,
    )
  })

  it('非法状态被拒，不会写进账本', async () => {
    const { store, itemId } = seeded()
    await assert.rejects(
      () => handlerFor(routesFor(store), 'POST', '/item')({ body: { itemId, status: '随便' } }),
      /非法状态/,
    )
  })
})

// ───────────────────────── POST /task ─────────────────────────

describe('POST /task（随手加一条待办）', () => {
  it('加一条无归属的池任务', async () => {
    const store = memoryStore()
    const value = await handlerFor(routesFor(store), 'POST', '/task')({ body: { title: '给妈妈打电话' } })
    assert.equal(value.ok, true)
    assert.equal(value.task.title, '给妈妈打电话')
    assert.equal(value.task.goalId, null)
    assert.equal(store.data.tasks.length, 1)
  })

  it('接受预估耗时', async () => {
    const store = memoryStore()
    const value = await handlerFor(routesFor(store), 'POST', '/task')({ body: { title: 'x', estimateMin: 25 } })
    assert.equal(value.task.estimateMin, 25)
  })

  it('空标题被拒（防误点产生一条空待办）', async () => {
    const store = memoryStore()
    await assert.rejects(() => handlerFor(routesFor(store), 'POST', '/task')({ body: { title: '   ' } }), /标题/)
    assert.equal(store.data.tasks.length, 0)
  })
})

// ───────────────────────── 传输层 ─────────────────────────

/** 假 request：按 geo-workflow 的 readBody 惯例（on('data')/on('end')）驱动。 */
function fakeRequest(method, url, body) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method,
    url,
    on(event, callback) {
      (listeners[event] ??= []).push(callback)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      const chunk = Buffer.from(JSON.stringify(body))
      for (const callback of listeners.data) callback(chunk)
    }
    for (const callback of listeners.end) callback()
  })
  return req
}

function fakeResponse() {
  const res = { status: null, headers: null, text: null }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (text) => { res.text = text }
  res.json = () => JSON.parse(res.text)
  return res
}

function fakeHost() {
  const registered = []
  return {
    registered,
    webServer: {
      register(route) {
        registered.push(route)
        return () => { registered.splice(registered.indexOf(route), 1) }
      },
    },
  }
}

describe('传输层 dispatch', () => {
  it('mountRoutes 给每个端点注册一次，并在释放时注销', () => {
    const host = fakeHost()
    const dispose = mountRoutes(host, { store: memoryStore(), now: () => TODAY })
    assert.deepEqual(host.registered.map(route => route.path).sort(), [
      `${API_PREFIX}/goals`, `${API_PREFIX}/item`, `${API_PREFIX}/state`, `${API_PREFIX}/task`,
    ])
    assert.ok(host.registered.every(route => route.kind === 'exact'))
    dispose()
    assert.equal(host.registered.length, 0)
  })

  it('GET 返回 200 与 JSON', async () => {
    const host = fakeHost()
    mountRoutes(host, { store: memoryStore(), now: () => TODAY })
    const route = host.registered.find(entry => entry.path.endsWith('/state'))
    const res = fakeResponse()
    await route.handler(fakeRequest('GET', `${API_PREFIX}/state?date=2026-05-09`), res)
    assert.equal(res.status, 200)
    assert.equal(res.json().date, '2026-05-09')
  })

  it('POST 能读到 JSON body', async () => {
    const host = fakeHost()
    const store = memoryStore()
    mountRoutes(host, { store, now: () => TODAY })
    const route = host.registered.find(entry => entry.path.endsWith('/task'))
    const res = fakeResponse()
    await route.handler(fakeRequest('POST', `${API_PREFIX}/task`, { title: '打电话' }), res)
    assert.equal(res.status, 200)
    assert.equal(res.json().task.title, '打电话')
  })

  it('handler 抛错时返回 400 与可读的 error，而不是 500 空响应', async () => {
    const host = fakeHost()
    mountRoutes(host, { store: memoryStore(), now: () => TODAY })
    const route = host.registered.find(entry => entry.path.endsWith('/task'))
    const res = fakeResponse()
    await route.handler(fakeRequest('POST', `${API_PREFIX}/task`, { title: '' }), res)
    assert.equal(res.status, 400)
    assert.match(res.json().error, /标题/)
  })

  it('方法不允许时返回 405 并带上 allow 头', async () => {
    const host = fakeHost()
    mountRoutes(host, { store: memoryStore(), now: () => TODAY })
    const route = host.registered.find(entry => entry.path.endsWith('/state'))
    const res = fakeResponse()
    await route.handler(fakeRequest('DELETE', `${API_PREFIX}/state`), res)
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET')
  })

  it('非法 JSON body 返回 400 而不是崩掉', async () => {
    const host = fakeHost()
    mountRoutes(host, { store: memoryStore(), now: () => TODAY })
    const route = host.registered.find(entry => entry.path.endsWith('/task'))
    const res = fakeResponse()
    const listeners = { data: [], end: [] }
    const req = {
      method: 'POST',
      url: `${API_PREFIX}/task`,
      on(event, callback) { (listeners[event] ??= []).push(callback); return req },
      destroy() {},
    }
    queueMicrotask(() => {
      for (const callback of listeners.data) callback(Buffer.from('{ 这不是 JSON'))
      for (const callback of listeners.end) callback()
    })
    await route.handler(req, res)
    assert.equal(res.status, 400)
    assert.match(res.json().error, /JSON/)
  })
})
