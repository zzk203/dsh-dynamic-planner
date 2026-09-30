/**
 * 数据文件路径解析 —— 测试先于实现。
 *
 * 复刻 `dshHomePath` 的语义（packages/util/home-paths/src/index.ts）：
 * 优先级为「显式配置 → $DSH_HOME → ~/.dsh」，且**空白字符的 $DSH_HOME 视为未设置** ——
 * 否则一个空的环境变量会把数据目录解析到当前工作目录，那是静默的数据错位。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { dataFilePath, resolveDshHome } from '../lib/paths.js'

describe('resolveDshHome', () => {
  it('没有 DSH_HOME 时用 ~/.dsh', () => {
    assert.equal(resolveDshHome(undefined, {}), resolve(join(homedir(), '.dsh')))
  })

  it('有 DSH_HOME 时用它', () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '/tmp/custom-home' }), resolve('/tmp/custom-home'))
  })

  it('空白字符的 DSH_HOME 视为未设置（空值不该把数据目录带到工作目录）', () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '' }), resolve(join(homedir(), '.dsh')))
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '   ' }), resolve(join(homedir(), '.dsh')))
  })

  it('显式配置的优先级高于 DSH_HOME', () => {
    assert.equal(resolveDshHome('/explicit', { DSH_HOME: '/from-env' }), resolve('/explicit'))
  })

  it('展开 ~ 前缀', () => {
    assert.equal(resolveDshHome('~/custom', {}), resolve(join(homedir(), 'custom')))
    assert.equal(resolveDshHome('~', {}), resolve(homedir()))
  })
})

describe('dataFilePath', () => {
  it('固定落在 <home>/dynamic-planner/data.json', () => {
    assert.equal(
      dataFilePath({ DSH_HOME: '/tmp/dsh-home' }),
      join(resolve('/tmp/dsh-home'), 'dynamic-planner', 'data.json'),
    )
  })

  it('默认（无 DSH_HOME）落在 ~/.dsh/dynamic-planner/data.json', () => {
    assert.equal(
      dataFilePath({}),
      join(resolve(join(homedir(), '.dsh')), 'dynamic-planner', 'data.json'),
    )
  })

  it('返回绝对路径（相对路径会被写进进程 cwd，是数据丢失的常见来源）', () => {
    const file = dataFilePath({ DSH_HOME: 'relative-home' })
    assert.ok(file.startsWith('/'), `应返回绝对路径：${file}`)
  })
})
