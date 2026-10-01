# 交接提示词（粘贴到新会话）

下面整段可以直接复制到新会话作为第一条消息。

---

我在继续开发一个已经成型的 DSH 插件，请你先读完这几份文件再动手，不要凭猜测开始：

- `/home/zzk/geo/dsh-dynamic-planner/REQUIREMENTS.md` —— **需求唯一真相来源**，代码与它冲突时以它为准
- `/home/zzk/geo/dsh-dynamic-planner/VERIFICATION.md` —— 13 条验收标准逐条的证据、待验项、以及走过的弯路
- `/home/zzk/geo/dsh-dynamic-planner/README.md` —— 结构，以及**四个已经踩过的坑**（动手前必读）

## 这是什么

一个对话驱动的个人日程表 DSH 插件。三层模型：目标 → 任务池 → 每日计划条目。
对话是主操作界面，日程表面板是它的可视化产物。核心能力是"读取往日完成情况，动态重排今日计划"。

**四条铁律**（写在 `lib/prompt.js` 的 section 里，是产品的地基，改代码前先理解它们）：

1. LLM 只有建议权，没有决定权 —— 任务完成由用户勾选，目标完成由用户拍板
2. 默认零录入 —— 不强制填任何字段；反馈靠 LLM 第二天在对话里问出来
3. 日常静默，异常才上报 —— 只对「有期限目标按当前速度不可能达成」和「任务连续顺延 ≥3 次」主动开口
4. 只给正向积累，不给负面压力 —— 可以显示"已坚持 12 天"，绝不给百分比与落后提示

## 当前状态

- 23+ 次提交，已推送到 `git@github.com:zzk203/dsh-dynamic-planner.git`（origin 的 push 走 SSH，fetch 走 HTTPS）
- 测试：源码目录 `npm test` 全绿；接上 shipped 包与 React 后用例更多
- 已装进 `web` profile 并现场验证：9 个工具在 Agent 工具列表里、section 在系统提示里、4+1 个 HTTP 端点全通、面板在真实浏览器里渲染并写回

## 动手前必须知道的四个坑

**一、`install_bundle` 是 link 安装，所以插件必须自包含。**
profile 里只有符号链接指向源码目录，运行时 Node 从**真实路径**向上解析依赖，
永远走不到 `~/.dsh/profiles/node_modules/@deepseek-ai`。
所以**不要** `import '@deepseek-ai/*'` —— `defineTool` 与 `dshHomePath` 已在
`lib/schema.js` / `lib/paths.js` 里本地复刻，并有与真实现的逐字节对照测试。
（`dsh-geo-workflow` 同样是链接安装且工作正常，因为它只 import `node:*` 与相对路径。）

**二、改 `lib/` 后必须重启 `dsh web` 才生效。**
ESM 模块缓存按 URL，翻插件的启用开关**不会**重新加载。
`client.js` 走另一条路：重新扫描 + 刷新页面即可，通常不用重启。
**所以宿主侧改动攒一批再让用户重启一次 —— 别让他为同一个项目重启三次。**

**三、工具名重复会直接抛错**（不是覆盖）。`schedule_*` 与 `todo_write` 已被 DSH 自带插件占用。

**四、prompt caching 是前缀匹配。**
`systemPrompt.section()` 进系统提示（稳定前缀），`systemPrompt.context()` 作为独立消息追加在对话尾部。
把动态内容塞进 section 会让它后面的一切每轮失效。
另外**工具 schema 必须与数据无关** —— 绝不要在工具描述里塞"当前有 3 条待办"。

## 怎么跑

```bash
cd /home/zzk/geo/dsh-dynamic-planner
npm test                       # 源码目录，208+ 用例

# 有两组用例需要 shipped 包与 React，源码目录会 skip（不会假装通过）：
ln -sfn ~/.dsh/profiles/node_modules node_modules && npm test && rm node_modules
```

**面板的浏览器验证台**（`tests/harness/`）：DSH GUI 首页要进程级 token，只打在终端上、不落盘，
所以 agent 自己打不开真 GUI。而插件注册的 `/dynamic-planner/api/*` 不需要鉴权 ——
验证台据此在另一个端口起同源代理页，加载**真实 client.js**、转发到**真实 API**、写**真实数据文件**：

```bash
node tests/harness/serve.mjs          # 127.0.0.1:18999
# 然后（需在 /tmp 等可写目录下运行，快照会落在 .playwright-cli/）
playwright-cli open http://127.0.0.1:18999/
playwright-cli snapshot
playwright-cli click e37              # 用快照里的 ref
playwright-cli close
```

它已经抓到过一个真实缺陷（随手添加的待办不可见），值得继续用。
**注意：`playwright-cli open` 的自动快照可能抓在渲染完成之前**，
看到"读取中…"先别急着判定为 bug —— 用 `eval` 查 `performance.getEntriesByType('resource')` 更可靠。

## 开放项（需要用户拍板，别自己决定）

- §4.7：用户直接问"我进展怎么样了"时给不给具体数字 —— 已按"就直说"改过，可复核
- 面板要不要再放开别的写权限（新建目标？改预估耗时？）
- 第 8 条的**跨天行为**（连续完成加量 / 完不成减量）还没法验：规则已在模型上下文里，
  但要真实多天数据才能观察"量真的变了吗"

## 跟我（用户）的协作方式

- **TDD**：先写测试再实现，一个模块一次 commit。测试要对着需求写，不要对着实现写
- **不要猜我的意图**：不明确的地方就问我，一次一个问题，给出推荐答案
- **我说停下就停下**：不要在我明确让你等的时候继续找活干
- **先看再改**：`plan_write` 是替换语义，改之前先读现状
- 我关心的是**真实可用**，不是测试全绿 —— 如果一个能力结果不可见、或者旋钮没人能拧，
  那它等于不存在。这类问题单元测试抓不到，请主动去核

---

## 附：一句话版的起步指令

如果你想更简短，可以只发这句：

> 读 `/home/zzk/geo/dsh-dynamic-planner/` 下的 `REQUIREMENTS.md`、`VERIFICATION.md`、`README.md`，
> 然后告诉我这个插件的现状与下一步建议。动手前先跟我确认。
