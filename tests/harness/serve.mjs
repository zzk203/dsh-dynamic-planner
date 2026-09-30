/**
 * 面板的浏览器验证台。
 *
 * 为什么需要它：DSH 的首页需要进程级 token 才能打开，而那个 token 只打在用户终端的
 * stdout 上、不落盘。所以"打开真 GUI 看面板"这件事没法由 agent 自己完成。
 *
 * 但插件注册的 `/dynamic-planner/api/*` **不需要鉴权**（实测 200）。于是做法是：
 * 在另一个端口起一个同源代理页 —— 页面由本进程提供，API 请求转发给真的宿主。
 * 这样面板跑的是**真实的 client.js**、调的是**真实的 API**、写的是**真实的数据文件**，
 * 唯独省掉了那一层拿不到的 token。
 *
 * 用法：
 *   node tests/harness/serve.mjs            # 起在 127.0.0.1:18999
 *   HARNESS_PORT=19001 node tests/harness/serve.mjs
 *
 * 它只用于验证，不参与插件运行。
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..', '..')
const PROFILE_MODULES = process.env.HARNESS_MODULES
  ?? join(process.env.HOME ?? '/home/zzk', '.dsh', 'profiles', 'node_modules')

const PORT = Number(process.env.HARNESS_PORT ?? 18999)
const UPSTREAM = process.env.HARNESS_UPSTREAM ?? 'http://127.0.0.1:18080'
const API_PREFIX = '/dynamic-planner/api/'

/** 静态文件表：路径 → 真实文件。字段刻意写死，不做目录遍历。 */
const STATIC = {
  '/': join(HERE, 'page.html'),
  '/client.js': join(PLUGIN_ROOT, 'client.js'),
  '/react.js': join(PROFILE_MODULES, 'react', 'umd', 'react.development.js'),
  '/react-dom.js': join(PROFILE_MODULES, 'react-dom', 'umd', 'react-dom.development.js'),
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')

  // API：原样转发给真宿主，包括方法、请求体与状态码
  if (url.pathname.startsWith(API_PREFIX)) {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const upstream = await fetch(`${UPSTREAM}${request.url}`, {
        method: request.method,
        headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
        body: request.method === 'GET' || request.method === 'DELETE' ? undefined : body,
      })
      const payload = Buffer.from(await upstream.arrayBuffer())
      response.writeHead(upstream.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
      })
      response.end(payload)
    } catch (error) {
      const payload = Buffer.from(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length })
      response.end(payload)
    }
    return
  }

  const file = STATIC[url.pathname]
  if (file === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`not found: ${url.pathname}\n可用：${Object.keys(STATIC).join(' ')}`)
    return
  }
  try {
    const payload = readFileSync(file)
    response.writeHead(200, {
      'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': payload.length,
    })
    response.end(payload)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`读不到 ${file}：${String(error?.message ?? error)}\n`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`harness: http://127.0.0.1:${PORT}`)
  console.log(`  静态：${Object.keys(STATIC).join(' ')}`)
  console.log(`  代理：${API_PREFIX}* → ${UPSTREAM}`)
})
