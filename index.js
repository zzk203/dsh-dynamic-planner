/**
 * dsh-dynamic-planner —— 宿主半侧入口。
 *
 * **这个文件刻意不 import 任何 `@deepseek-ai/*`。**
 *
 * 原因是实测出来的：`plugin_manager install_bundle` 用的是 **link 安装**，
 * profile 里只有一个指向源码目录的符号链接：
 *
 *   ~/.dsh/profiles/web/node_modules/dsh-dynamic-planner -> ../../../../geo/dsh-dynamic-planner
 *
 * 于是运行时 Node 从**真实路径**向上解析依赖，永远走不到
 * `~/.dsh/profiles/node_modules/@deepseek-ai`，import 会以
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'` 失败，
 * 插件状态停在 `failed to import`。
 *
 * 已有的 dsh-geo-workflow 同样是链接安装且工作正常 —— 因为它只 import `node:*`
 * 与相对路径。链接安装下只有这种写法可行。
 *
 * 因此两处依赖各自有了本地替代，语义照 shipped 实现复刻，并用对照测试保证一致：
 *   - `defineTool`          → lib/schema.js
 *   - `dshHomePath`         → lib/paths.js （见 lib/paths.js 的 doc）
 */

import { readFileSync } from 'node:fs'

import { applyPlanner } from './lib/plugin.js'
import { dataFilePath } from './lib/paths.js'

export const name = 'dsh-dynamic-planner'

/**
 * `tools` 与 `systemPrompt` 都是硬依赖：前者是对话侧的唯一入口，
 * 后者是「铁律」与「今日摘要」的落点，缺任何一个插件都没有意义。
 */
export const inject = ['tools', 'systemPrompt']

/** 版本号透给面板，用于排查"浏览器里跑的是旧 bundle"这类问题。 */
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null
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
    // 数据落在 <harness home>/dynamic-planner/data.json，而不是插件自己的目录里 ——
    // 插件目录会在重装、换版本、重新 link 时被替换，日程数据不能跟着一起没。
    dataFile: dataFilePath(),
    version: readVersion(),
  })
}
