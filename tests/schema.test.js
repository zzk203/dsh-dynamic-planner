/**
 * 本地 schema 编译器 —— 测试先于实现。
 *
 * 为什么需要它：`install_bundle` 用的是 **link 安装**，profile 里只是一个指向源码目录的
 * 符号链接。于是运行时 Node 从**真实路径**向上解析依赖，永远走不到
 * `profiles/node_modules/@deepseek-ai`。dsh-geo-workflow 同样是链接安装且工作正常，
 * 因为它只 import `node:*` 与相对路径 —— 这就是链接安装下唯一可行的写法。
 *
 * 所以这里复刻 `defineTool` 的两件事：
 *   1. 把参数 DSL 编译成宿主认的裸 JSON Schema（支持的子集见 json-schema.ts：
 *      type/oneOf/properties/required/additionalProperties/items/enum/const + 注解）
 *   2. 调用 execute 前做参数校验（真 defineTool 也做，不能因为自研就丢掉）
 *
 * 忠实度由「与真 defineTool 输出逐字节一致」那条用例保证（能解析到 shipped 包时才跑）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { compileParameters, compileValueSchema, defineTool } from '../lib/schema.js'
import { buildTools } from '../lib/tools.js'

/** ESM 下只有真能解析到才跑对照。 */
let realDefineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  realDefineTool = mod.defineTool ?? null
} catch { /* 源码目录解析不到，属于预期 */ }

const noop = () => [{ type: 'text', text: 'ok' }]

// ───────────────────────── 参数编译 ─────────────────────────

describe('参数 DSL 编译', () => {
  it('空参数编译成开放的 object 根', () => {
    assert.deepEqual(compileParameters({}), { type: 'object', properties: {} })
  })

  it('required:true 从属性上摘掉，提升到根的 required 数组', () => {
    const schema = compileParameters({
      a: { type: 'string', required: true, description: '甲的说明' },
      b: { type: 'string' },
    })
    assert.deepEqual(schema, {
      type: 'object',
      properties: { a: { type: 'string', description: '甲的说明' }, b: { type: 'string' } },
      required: ['a'],
    })
  })

  it('没有必填项时不生成 required 键', () => {
    assert.ok(!Object.hasOwn(compileParameters({ a: { type: 'string' } }), 'required'))
  })

  it('enum 与 description 原样保留', () => {
    const schema = compileParameters({
      mode: { type: 'string', enum: ['deadline', 'longterm'], description: '模式' },
    })
    assert.deepEqual(schema.properties.mode, {
      type: 'string', enum: ['deadline', 'longterm'], description: '模式',
    })
  })

  it('嵌套 object 保留 additionalProperties:false 并各自算 required', () => {
    const schema = compileParameters({
      item: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: { title: { type: 'string', required: true }, note: { type: 'string' } },
      },
    })
    assert.deepEqual(schema.properties.item, {
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string' }, note: { type: 'string' } },
      required: ['title'],
    })
    assert.deepEqual(schema.required, ['item'])
  })

  it('数组的 items 递归编译', () => {
    const schema = compileParameters({
      list: { type: 'array', items: { type: 'integer' } },
    })
    assert.deepEqual(schema.properties.list, { type: 'array', items: { type: 'integer' } })
  })

  it('{type:"json"} 编译成空 schema（= 任意值）', () => {
    assert.deepEqual(compileValueSchema({ type: 'json' }), {})
  })

  it('编译结果是纯数据，不含函数（宿主会拿去序列化）', () => {
    const schema = compileParameters({ a: { type: 'string', required: true } })
    assert.equal(JSON.parse(JSON.stringify(schema)).type, 'object')
  })
})

// ───────────────────────── defineTool ─────────────────────────

describe('本地 defineTool', () => {
  const base = {
    name: 'demo',
    description: '一个演示用的工具，描述要够长才能过检查。',
    parameters: { a: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: noop },
    execute: async () => ({ ok: true }),
  }

  it('产出宿主认的形状', () => {
    const tool = defineTool(base)
    assert.equal(tool.name, 'demo')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.output.schema, {})
    assert.equal(tool.output.render, noop)
    assert.equal(typeof tool.execute, 'function')
  })

  it('缺 name 或 description 直接抛错（而不是注册一个模型看不懂的工具）', () => {
    assert.throws(() => defineTool({ ...base, name: '' }), /name/)
    assert.throws(() => defineTool({ ...base, description: '' }), /description/)
  })

  it('参数校验：缺必填项时不调用 execute', async () => {
    let called = false
    const tool = defineTool({ ...base, execute: async () => { called = true; return {} } })
    await assert.rejects(() => tool.execute({}, {}), /a/)
    assert.equal(called, false, '校验没过就不该执行')
  })

  it('参数校验：类型不对时拒绝', async () => {
    const tool = defineTool(base)
    await assert.rejects(() => tool.execute({ a: 123 }, {}), /a/)
  })

  it('参数校验：enum 之外的值被拒绝', async () => {
    const tool = defineTool({
      ...base,
      parameters: { mode: { type: 'string', enum: ['x', 'y'], required: true } },
    })
    await assert.rejects(() => tool.execute({ mode: 'z' }, {}), /mode/)
    await assert.doesNotReject(() => tool.execute({ mode: 'x' }, {}))
  })

  it('参数校验：嵌套 object 与数组内部也查', async () => {
    const tool = defineTool({
      ...base,
      parameters: {
        items: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { title: { type: 'string', required: true } },
          },
        },
      },
    })
    await assert.rejects(() => tool.execute({ items: [{ title: 1 }] }, {}), /items/)
    await assert.doesNotReject(() => tool.execute({ items: [{ title: 'ok' }] }, {}))
  })

  it('参数校验：额外的未知字段被接受（根是开放的，与真 defineTool 一致）', async () => {
    const tool = defineTool(base)
    await assert.doesNotReject(() => tool.execute({ a: 'x', 多余的: 1 }, {}))
  })

  it('校验通过时把参数原样交给 execute', async () => {
    let received = null
    const tool = defineTool({ ...base, execute: async args => { received = args; return {} } })
    await tool.execute({ a: 'hello' }, {})
    assert.deepEqual(received, { a: 'hello' })
  })
})

// ───────────────────────── 与真 defineTool 的对照 ─────────────────────────

describe('与真 defineTool 输出逐字节一致', { skip: realDefineTool === null ? '源码目录解析不到 @deepseek-ai/dsh-tools' : false }, () => {
  it('9 个工具的 parameters 与 output.schema 完全一致', () => {
    const store = {
      read: () => ({ goals: [], tasks: [], plans: [] }),
      update: fn => fn({ goals: [], tasks: [], plans: [] }),
    }
    const mine = buildTools({ store, now: () => '2026-05-10', defineTool })
    const theirs = buildTools({ store, now: () => '2026-05-10', defineTool: realDefineTool })
    assert.equal(mine.length, theirs.length)
    for (let index = 0; index < mine.length; index += 1) {
      const a = mine[index]
      const b = theirs[index]
      assert.equal(a.name, b.name)
      assert.equal(a.description, b.description, `${a.name} 描述不一致`)
      assert.deepEqual(a.parameters, b.parameters, `${a.name} 的参数 schema 与真实现不一致`)
      assert.deepEqual(a.output.schema, b.output.schema, `${a.name} 的输出 schema 与真实现不一致`)
    }
  })
})

// ───────────────────────── schema 拼写守卫 ─────────────────────────

describe('schema 拼写守卫', () => {
  it('未知的键直接抛错，而不是被静默丢弃', () => {
    // "descriptoin" 这类拼写错误如果被静默丢掉，模型就永远看不到那段说明，
    // 而且不会报任何错 —— 属于几小时也查不出来的那种 bug
    assert.throws(
      () => compileParameters({ a: { type: 'string', descriptoin: '拼错了' } }),
      /descriptoin/,
    )
    assert.throws(() => compileParameters({ a: { type: 'string', requird: true } }), /requird/)
  })

  it('oneOf 明确报"尚未实现"，而不是产出错误的 schema', () => {
    assert.throws(
      () => compileParameters({ a: { oneOf: [{ type: 'string' }, { type: 'number' }] } }),
      /oneOf/,
    )
  })

  it('合法键一个都不误伤', () => {
    assert.doesNotThrow(() => compileParameters({
      a: {
        type: 'array',
        required: true,
        description: 'd',
        title: 't',
        default: [],
        examples: [[]],
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            b: { type: 'string', enum: ['x'], const: undefined, required: true },
            c: { type: 'integer' },
          },
        },
      },
    }))
  })
})
