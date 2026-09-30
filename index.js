/**
 * dsh-dynamic-planner —— 宿主半侧入口。
 *
 * 这个文件刻意保持极薄：它唯一的职责是 import shipped package 并把它们转发给
 * 装配层（`lib/plugin.js`）。所有逻辑都在那边的纯模块里，因此可以被单元测试覆盖 ——
 * 而这里因为 `@deepseek-ai/*` 只在 profile 的 node_modules 里可达，只能在安装后验证。
 *
 * `tools` 与 `systemPrompt` 都声明为硬依赖：前者是对话侧的唯一入口，
 * 后者是"铁律"与"今日摘要"的落点，缺任何一个插件都没有意义。
 */

import { readFileSync } from 'node:fs'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { applyPlanner } from './lib/plugin.js'

export const name = 'dsh-dynamic-planner'

export const inject = ['tools', 'systemPrompt']

/** 版本号透给面板，用于排查"浏览器里跑的是旧 bundle"这类问题。 */
function readVersion() {
  try {
    const raw = readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    return JSON.parse(raw).version ?? null
  } catch {
    return null
  }
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} config 插件 config（MVP 暂无配置项）
 */
export function apply(ctx, config) {
  applyPlanner(ctx, config, {
    defineTool,
    // 数据放在 ~/.dsh/dynamic-planner/ 下，而不是插件自己的目录里：
    // 插件目录会在重装时被替换，日程数据不能跟着一起没。
    dataFile: dshHomePath('dynamic-planner', 'data.json'),
    version: readVersion(),
  })
}
