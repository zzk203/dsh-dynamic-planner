/**
 * 插件装配 —— 把数据层、工具、提示词、路由接到 Cordis 上下文上。
 *
 * 这一层刻意不 import 任何 `@deepseek-ai/*`：shipped package 只在 profile 的
 * node_modules 里可达，源码目录解析不到。把 `defineTool` 与数据文件路径作为参数
 * 传进来之后，本模块可以用一个假 ctx 完整验证，而 `index.js` 只剩下 import 与转发。
 */

import { createStore, dateKey } from './store.js'
import { buildTools } from './tools.js'
import { PLANNER_CONTEXT_NAME, PLANNER_SECTION_NAME, buildContextText, buildSectionText } from './prompt.js'
import { mountRoutes } from './routes.js'

/** effect 名字的统一前缀，释放时一眼能看出是谁注册的。 */
const NS = 'dsh-dynamic-planner'

/**
 * @param {object} ctx Cordis 上下文（已注入 tools 与 systemPrompt）
 * @param {object} _config 插件 config（MVP 暂无配置项）
 * @param {object} deps
 * @param {(options: object) => object} deps.defineTool shipped 的 defineTool
 * @param {string} deps.dataFile 数据文件绝对路径
 * @param {() => string} [deps.now] 本地今天，默认取系统时钟
 * @param {string|null} [deps.version] 透给面板用于排查旧 bundle
 */
export function applyPlanner(ctx, _config, { defineTool, dataFile, now = dateKey, version = null }) {
  const logger = ctx.get('logger')
  const store = createStore(dataFile, message => logger?.warn?.(message))

  // 启动时先读一次。store 本身是惰性的，不读就不会发现问题 ——
  // 而"数据文件坏了"这件事应该在启动日志里就暴露，不是等用户第一次排计划才蹦出来。
  // 代价是启动时多读一个小 JSON 文件。
  store.read()

  // ── 工具：全局注册。这样任何一个会话里的 Agent 工具列表里都有它们，
  //    而数据是 profile 级的共享状态 —— 会话与插件之间没有任何绑定关系。
  for (const tool of buildTools({ defineTool, store, now })) {
    ctx.effect(() => ctx.tools.register(tool), `${NS}: tool ${tool.name}`)
  }

  // ── 静态铁律：进系统提示，是稳定前缀的一部分，永远命中缓存
  ctx.effect(() => ctx.systemPrompt.section({
    name: PLANNER_SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + 50,
    text: buildSectionText(),
    // 正文是字面量，不该走 {{变量}} 插值 —— 显式关掉，防止将来正文里出现花括号时炸掉
    interpolate: false,
  }), `${NS}: rules section`)

  // ── 动态摘要：必须传函数。传字符串会把它固化成"进程启动那一刻的状态"，
  //    之后无论用户排了多少计划，模型看到的都还是启动时那份 —— 而且不会报错。
  ctx.effect(() => ctx.systemPrompt.context({
    name: PLANNER_CONTEXT_NAME,
    order: 200,
    text: () => buildContextText(store.read(), now()),
  }), `${NS}: today context`)

  // ── 面板路由：可选依赖。宿主没装 webServer 时，对话那条路必须照常能用，
  //    不能因为"没有界面"就整个插件不挂载。
  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = mountRoutes(hostCtx, { store, now, version })
    ctx.effect(() => dispose, `${NS}: routes`)
    logger?.info?.(`[planner] 面板端点已挂载，数据文件：${dataFile}`)
  })
}
