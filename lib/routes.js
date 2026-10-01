/**
 * 面板读写用的 HTTP 端点（REQUIREMENTS.md §5）。
 *
 * 边界刻意收得很紧 —— 面板能做的只有四件事：
 *   1. 看今天
 *   2. 改一条**已有**计划项的状态 / 备注 / 未完成原因
 *   3. 随手加一条无归属待办
 *   4. 把一个目标标记为完成（用户明确要求加的按钮；它不新建任何东西，
 *      只是把"用户拍板"从对话挪到按钮上，铁律一反而更硬）
 *
 * 没有"新建目标""拆解任务""生成计划"的端点，因为 §5.4 明确把这些留给对话。
 * 面板不做任何 AI 决策，也不承担触发职责，它的可靠性因此不依赖模型。
 */

import { completeGoal, dateKey, goalOverview, quickAddTask, todayView, updatePlanItem } from './store.js'

/** 端点前缀。带命名空间，避免和别的插件撞。 */
export const API_PREFIX = '/dynamic-planner/api'

/** 请求体上限。日程表的数据都很小，超过这个量级一定是哪里搞错了。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 构建路由表。handler 是纯业务函数：`({ params, body }) => 值`，
 * 不知道 HTTP 的存在，因此可以被直接单元测试。
 *
 * @param {{ store: object, now?: () => string, version?: string }} deps
 */
export function buildRouteTable({ store, now = dateKey, version = null }) {
  const today = () => now()
  const table = []
  const route = (method, path, handler) => table.push({ method, path, handler })

  route('GET', '/state', ({ params }) => {
    const date = params.get('date') ?? today()
    return { ok: true, date, version, today: todayView(store.read(), date) }
  })

  route('GET', '/goals', ({ params }) => {
    const date = params.get('date') ?? today()
    return { ok: true, date, goals: goalOverview(store.read(), date) }
  })

  route('POST', '/item', async ({ body }) => {
    const itemId = body?.itemId
    if (typeof itemId !== 'string' || itemId === '') {
      throw new Error('缺少 itemId：面板只能更新已存在的计划项，不能新建。')
    }
    const patch = {}
    if (body.status !== undefined) patch.status = body.status
    if (body.note !== undefined) patch.note = body.note
    if (body.reason !== undefined) patch.reason = body.reason
    const date = body.date ?? today()
    const item = await store.update(data => updatePlanItem(data, date, itemId, patch))
    return { ok: true, item }
  })

  // 用户在目标总览里点「标记完成」。
  // 这里传 confirmedByUser=true 是合法的：**点击本身就是他的确认** ——
  // 铁律一要的是"由用户拍板"，而不是"必须经过对话"。按钮反而是更直接的拍板方式。
  route('POST', '/goal/complete', async ({ body }) => {
    const goalId = body?.goalId
    if (typeof goalId !== 'string' || goalId === '') {
      throw new Error('缺少 goalId：面板只能标记已存在的目标。')
    }
    const goal = await store.update(data => completeGoal(data, goalId, true))
    return { ok: true, goal }
  })

  route('POST', '/task', async ({ body }) => {
    const title = String(body?.title ?? '').trim()
    if (title === '') throw new Error('标题不能为空。')
    const task = await store.update(data => quickAddTask(data, title, body?.estimateMin))
    return { ok: true, task }
  })

  return table
}

/**
 * 把路由表挂到宿主 webServer 上。
 * @returns {() => void} 释放函数，随 fiber 释放
 */
export function mountRoutes(host, deps) {
  const table = buildRouteTable(deps)
  // 同一路径的多个方法聚合成一个 handler —— webServer 按路径注册
  const byPath = new Map()
  for (const entry of table) {
    const key = `${API_PREFIX}${entry.path}`
    if (!byPath.has(key)) byPath.set(key, {})
    byPath.get(key)[entry.method] = entry.handler
  }

  const disposers = []
  for (const [path, methods] of byPath) {
    const off = host.webServer.register({ kind: 'exact', path, handler: makeDispatch(methods) })
    if (typeof off === 'function') disposers.push(off)
  }
  return () => {
    for (const off of disposers) {
      try { off() } catch { /* 已经释放过了 */ }
    }
  }
}

function makeDispatch(methods) {
  return async (request, response) => {
    const handler = methods[request.method]
    if (handler === undefined) {
      response.writeHead(405, { allow: Object.keys(methods).join(', ') })
      response.end()
      return
    }
    try {
      const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readBody(request)
      const result = await handler({ request, params: queryOf(request), body })
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

function queryOf(request) {
  try {
    return new URL(request.url ?? '', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`))
      }
    })
    request.on('error', reject)
  })
}
