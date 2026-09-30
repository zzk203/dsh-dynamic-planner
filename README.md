# dsh-dynamic-planner

对话驱动的个人日程表 DSH 插件。**需求以 [`REQUIREMENTS.md`](./REQUIREMENTS.md) 为准**——那份文档是唯一真相来源，代码与它冲突时以文档为准。

## 它解决什么

普通待办工具不会因为你昨天没做完而改变今天的安排。这个插件会：

```
你说「排今天的计划」
  → LLM 读目标 + 任务池 + 往日完成记录
  → 识别未完成项，在对话里追问原因（引导式，不让你填表）
  → 生成今日计划（每条带预估耗时 + 说明取舍理由）
  → 写入面板 ← 你在这里勾选完成 / 写自由备注
```

## 四条铁律

1. **LLM 只有建议权，没有决定权** —— 任务完成由你勾选，目标完成由你拍板
2. **默认零录入** —— 不强制填任何字段；反馈靠 LLM 第二天问出来
3. **日常静默，异常才上报** —— 只对「有期限目标按当前速度不可能达成」和「某任务连续顺延 ≥3 次」主动开口
4. **只给正向积累，不给负面压力** —— 可以挂目标标签、可以显示"第 5 次"，但绝不给百分比和落后提示

## 结构

| 文件 | 职责 |
|---|---|
| `index.js` | 入口。**唯一允许 import `node:*` 的地方**，逻辑全在 `lib/` |
| `lib/store.js` | 数据层：三层模型、持久化、聚合与速度/动量计算 |
| `lib/schema.js` | 参数 schema 编译 + 工具定义（`defineTool` 的本地替代） |
| `lib/paths.js` | 数据文件路径（`dshHomePath` 的本地替代） |
| `lib/tools.js` | 9 个 LLM 工具 |
| `lib/prompt.js` | `systemPrompt` 的静态 section（铁律）与动态 context（今日摘要） |
| `lib/routes.js` | 面板读写的 4 个 HTTP 端点 |
| `lib/plugin.js` | 装配：把上面这些接到 Cordis 上下文 |
| `client.js` | 面板：侧边栏入口 + 中央面板 |

数据文件：`~/.dsh/dynamic-planner/data.json`

## 开发

```bash
npm test          # node --test
```

TDD：每个模块先写测试，再实现，通过后单独提交一次 commit。

### 两个测试要跑起来需要一点环境

`tests/schema.test.js` 里「与真 defineTool 输出逐字节一致」和 `tests/client.test.js`
整组，需要能解析到 shipped 的 `@deepseek-ai/*` 与 `react`。源码目录解析不到，
所以本地会 skip。想真跑一次：

```bash
ln -sfn ~/.dsh/profiles/node_modules node_modules   # 用完记得 rm
npm test
```

它们 skip 时不会变红，但也**不会假装通过**。

## 踩过的坑（改代码前请先读）

### 1. `install_bundle` 是 link 安装，所以插件必须自包含

profile 里只有一个符号链接指向源码目录：

```
~/.dsh/profiles/web/node_modules/dsh-dynamic-planner -> ../../../../geo/dsh-dynamic-planner
```

运行时 Node 从**真实路径**向上解析依赖，永远走不到
`~/.dsh/profiles/node_modules/@deepseek-ai`。于是 `import '@deepseek-ai/dsh-tools'`
以 `ERR_MODULE_NOT_FOUND` 失败，插件状态停在 `failed to import`。

已有的 `dsh-geo-workflow` 同样是链接安装且工作正常 —— 因为它只 import `node:*`
与相对路径。**这就是链接安装下唯一可行的写法。**

所以 `defineTool` 与 `dshHomePath` 各自有了本地复刻，并由对照测试保证忠实。

### 2. 改 `lib/` 下的代码后必须重启 `dsh web`

**翻插件的启用开关没用。** ESM 模块缓存是按 URL 的，再 `apply` 一次拿到的还是老模块。

实测：`lib/prompt.js` 已经加上 §4.5 小节（1638 字符），禁用→启用插件后，
活着的系统提示里仍然是旧版、没有那一节。

`client.js` 走另一条路：客户端插件图由宿主重新扫描并热替换，通常不用重启，
但**已经打开的页面**要刷新才会加载新条目（boot graph 在页面加载时取一次）。

顺序上也踩过一次：第一次激活插件时 `client.js` 还不存在，客户端条目因此没被登记；
后来再翻一次开关才重新扫描到。

### 3. 工具名重复会直接抛错

`ctx.tools.register` 对重名是抛错而不是覆盖。`schedule_*` 与 `todo_write`
已被 DSH 自带插件占用，别碰。

### 4. 动态内容放错位置会烧钱

prompt caching 是**前缀匹配**：

- `systemPrompt.section()` → 进系统提示（稳定前缀），永远命中缓存
- `systemPrompt.context()` → 作为独立消息追加在对话尾部，只影响尾部

把动态内容塞进 section，摘要一变，它后面的一切全部失效。
`tests/prompt.test.js` 里有守这条的用例。

另外工具 schema 也必须与数据无关 —— 绝不要在工具描述里塞"当前有 3 条待办"。
