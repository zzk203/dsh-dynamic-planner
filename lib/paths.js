/**
 * 数据文件路径 —— `@deepseek-ai/dsh-home-paths` 的本地替代（同样是因为 link 安装解析不到）。
 *
 * 语义照 `packages/util/home-paths/src/index.ts` 复刻：
 * 优先级为「显式配置 → $DSH_HOME → ~/.dsh」，且**空白字符的 $DSH_HOME 视为未设置**。
 * 最后一条不是洁癖：一个空的环境变量会把数据目录解析到当前工作目录，
 * 于是数据会随"在哪个目录启动"而漂移 —— 静默的数据错位，比报错难查得多。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 环境变量名，与宿主保持一致。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 默认的 harness 家目录名。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** 展开 `~` / `~/` / `~\` 前缀。 */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 解析 harness 家目录。
 * @param {string} [configured] 显式覆盖，优先级最高
 * @param {Record<string, string|undefined>} [env] 环境映射，默认 process.env
 * @returns {string} 规范化后的绝对路径
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.[DSH_HOME_ENV]
  const selected = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHomePath(selected))
}

/**
 * 日程表数据文件的绝对路径。
 *
 * 刻意放在 harness 家目录下，而不是插件自己的安装目录：插件目录会在重装、
 * 换版本、重新 link 时被替换，日程数据不能跟着一起没。
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function dataFilePath(env = process.env) {
  return join(resolveDshHome(undefined, env), 'dynamic-planner', 'data.json')
}
