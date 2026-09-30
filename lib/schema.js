/**
 * 参数 schema 编译与工具定义 —— `@deepseek-ai/dsh-tools` 的本地替代。
 *
 * 为什么不用 shipped 的 `defineTool`：`plugin_manager install_bundle` 用的是 **link 安装**，
 * profile 里只有一个指向源码目录的符号链接。运行时 Node 从**真实路径**向上解析依赖，
 * 因此永远走不到 `profiles/node_modules/@deepseek-ai`，`import '@deepseek-ai/dsh-tools'`
 * 会以 ERR_MODULE_NOT_FOUND 失败（实测报错见下）。dsh-geo-workflow 同样是链接安装
 * 且工作正常，因为它只 import `node:*` 与相对路径 —— 链接安装下只有这种写法可行。
 *
 *   实测：Cannot find package '@deepseek-ai/dsh-tools'
 *         imported from /home/zzk/geo/dsh-dynamic-planner/index.js
 *
 * 支持的 schema 子集照 `packages/core/tools/src/json-schema.ts` 的
 * `assertSupportedJsonSchema` 来：type / oneOf / properties / required /
 * additionalProperties / items / enum / const，加上 description/title/default/examples 注解。
 * 忠实度由 `tests/schema.test.js` 里「与真 defineTool 输出逐字节一致」的对照用例保证。
 */

/** 声明为必填的注解键 —— 编译时从属性上摘掉，提升到父级的 required 数组。 */
const REQUIRED_KEY = 'required'

/** 会原样透传给宿主的注解键。 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

/** 合法的标量类型。`json` 是作者侧的「任意值」，编译成空 schema。 */
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

/** 节点上允许出现的键。写错的键会被静默丢弃 —— 那是几小时也查不出来的那种 bug，所以直接拦。 */
const ALLOWED_KEYS = new Set([
  'type', REQUIRED_KEY, 'enum', 'const', 'items', 'properties', 'additionalProperties', 'oneOf',
  ...ANNOTATION_KEYS,
])

/**
 * 把一个属性 spec 编译成 JSON Schema 节点。
 * @param {object} spec 属性定义
 */
function compileNode(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new Error(`schema 节点必须是对象，收到：${JSON.stringify(spec)}`)
  }
  for (const key of Object.keys(spec)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`schema 节点上有不支持的键「${key}」：${JSON.stringify(spec)}。`
        + `允许的是 ${[...ALLOWED_KEYS].join(' / ')}`)
    }
  }
  if (Object.hasOwn(spec, 'oneOf')) {
    // 宿主支持 oneOf，但本插件目前用不到。与其静默产出错误的 schema，不如明说不支持。
    throw new Error('oneOf 尚未在本地的 schema 编译器中实现；需要时请照 json-schema.ts 的 ONE_OF_SIBLING_KEYWORDS 补齐')
  }
  if (!Object.hasOwn(spec, 'type')) {
    throw new Error(`schema 节点缺少 type：${JSON.stringify(spec)}`)
  }

  const node = {}
  // `json` 是「任意 lossless JSON」的作者侧写法，落地为空 schema
  if (spec.type !== 'json') {
    node.type = spec.type
    if (!SCALAR_TYPES.includes(spec.type) && spec.type !== 'array' && spec.type !== 'object') {
      throw new Error(`不支持的 type：${spec.type}`)
    }
  }

  for (const key of ANNOTATION_KEYS) {
    if (spec[key] !== undefined) node[key] = spec[key]
  }
  if (spec.enum !== undefined) node.enum = spec.enum
  if (spec.const !== undefined) node.const = spec.const

  if (spec.type === 'array' && spec.items !== undefined) {
    node.items = compileNode(spec.items)
  }
  if (spec.type === 'object') {
    const compiled = compilePropertyMap(spec.properties ?? {})
    node.properties = compiled.properties
    if (compiled.required !== undefined) node.required = compiled.required
    if (spec.additionalProperties !== undefined) node.additionalProperties = spec.additionalProperties
  }
  return node
}

/**
 * 编译一个属性映射。返回 `{ properties, required? }` ——
 * `required` 只在非空时出现，与真实现一致。
 */
function compilePropertyMap(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('parameters 必须是「属性名 → 定义」的对象')
  }
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(map)) {
    const { [REQUIRED_KEY]: isRequired, ...rest } = spec
    properties[key] = compileNode(rest)
    if (isRequired === true) required.push(key)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

/**
 * 编译工具参数。根是**开放**的 object（不写 additionalProperties），与真实现一致。
 * @param {object} spec 属性映射
 */
export function compileParameters(spec) {
  const { properties, required } = compilePropertyMap(spec)
  return required === undefined
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/**
 * 编译输出 schema。工具的输出统一声明为 `{ type: 'json' }`，编译结果是空 schema。
 * @param {object} spec
 */
export function compileValueSchema(spec) {
  return compileNode(spec)
}

// ───────────────────────── 参数校验 ─────────────────────────

/** 校验一个值是否满足编译后的 schema，返回违规描述数组。 */
function validateNode(node, value, path) {
  const violations = []
  if (node.type === undefined) return violations // 空 schema：任意值

  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${path} 应为对象`)
      return violations
    }
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} 是必填项`)
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) {
        violations.push(...validateNode(child, value[key], `${path}.${key}`))
      }
    }
    return violations
  }

  if (node.type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} 应为数组`)
      return violations
    }
    if (node.items !== undefined) {
      value.forEach((entry, index) => {
        violations.push(...validateNode(node.items, entry, `${path}[${index}]`))
      })
    }
    return violations
  }

  const actual = value === null ? 'null' : typeof value
  if (node.type === 'integer') {
    if (actual !== 'number' || !Number.isInteger(value)) violations.push(`${path} 应为整数`)
  } else if (node.type === 'number') {
    if (actual !== 'number' || !Number.isFinite(value)) violations.push(`${path} 应为数字`)
  } else if (actual !== node.type) {
    violations.push(`${path} 应为 ${node.type}`)
  }
  if (violations.length === 0 && Array.isArray(node.enum) && !node.enum.includes(value)) {
    violations.push(`${path} 只能是 ${node.enum.join(' / ')}，收到 ${JSON.stringify(value)}`)
  }
  return violations
}

/** 校验工具参数，抛出可读错误。 */
export function validateArguments(parameters, args) {
  const violations = validateNode(parameters, args, 'arguments')
  if (violations.length > 0) throw new Error(`参数不合法：${violations.join('；')}`)
}

// ───────────────────────── defineTool ─────────────────────────

/**
 * 本地版 `defineTool`：编译 schema，并在调用 execute 前校验参数。
 *
 * 校验这一步不能省 —— 真 `defineTool` 也做，丢掉它会让"必填项缺失"从
 * 一句清楚的报错退化成工具体内的 undefined 崩溃。
 *
 * @param {object} options
 */
export function defineTool(options) {
  const { name, description, parameters = {}, output, execute } = options
  if (typeof name !== 'string' || name === '') throw new Error('defineTool：name 不能为空')
  if (typeof description !== 'string' || description === '') throw new Error(`defineTool(${name})：description 不能为空`)
  if (output === undefined || typeof output.render !== 'function') {
    throw new Error(`defineTool(${name})：output.render 必须是函数`)
  }
  if (typeof execute !== 'function') throw new Error(`defineTool(${name})：execute 必须是函数`)

  const compiledParameters = compileParameters(parameters)
  return {
    name,
    description,
    parameters: compiledParameters,
    output: {
      schema: compileValueSchema(output.schema),
      render: output.render,
    },
    async execute(args, exec) {
      validateArguments(compiledParameters, args)
      return execute(args, exec)
    },
  }
}
