# 验收记录

对着 [`REQUIREMENTS.md`](./REQUIREMENTS.md) 第 8 章的 13 条标准逐条核。
**这份记录只写拿到了什么证据，不写"应该能行"。**

记录时间：2026-09-30 · 代码版本：`8c91173` + 本轮（§4.5 修复）

---

## 结论一览

| 状态 | 条数 | 含义 |
|---|---|---|
| ✅ 已实证 | 9 | 有可复现的证据 |
| 🟡 待你验 | 3 | 机制已通，只差一次真实对话或浏览器点击 |
| ⏳ 待重启 | 1 | 代码已改好、已安装，但当前进程仍是旧模块 |

---

## 逐条

### ✅ 3 · 今日计划里每条都带预估耗时

- `estimateMin` 在 `plan_write` 的 schema 里是 `required`，缺了会被本地的参数校验挡下
- `plan_write` 拒绝空 `items`
- 实测：写入的 3 条全部带 `estimateMin`（10 / 5 / 15），`/state` 原样返回

### ✅ 5 · 次日追问未完成项，并能写回原因

补了一段**真实的昨天**（用 `writePlan(data, '2026-09-29', …, '2026-09-29')` 生成，
把 yesterday 同时当作"今天"传进去，走的是与真实运行完全相同的代码路径，
不是手写 JSON），其中一条标为 `missed` 且**没写原因**。

`plan_context` 实测返回：

```
unexplained: [ { title: "跟读 3 句台词", date: "2026-09-29", status: "missed", reason: "" } ]
pendingBefore: [ { title: "跟读 3 句台词", date: "2026-09-29" } ]
pool: [ { title: "跟读 3 句台词", deferCount: 1 }, … ]
```

靶子被精确交出来了，而且该任务的 `deferCount` 已累到 1（这是 §4.6 异常上报的计数来源）。

写回路径也通：`plan_item_update` 对**往日**条目允许改 `status` / `note` / `reason`
（但改不了标题与预估耗时），所以"第二天追问出原因再写回昨天"这条路是通的。

### ✅ 6 · 长期目标挂标签，但无负面暗示；正向积累达门槛才出现

- `/state` 实测：计划项带 `goalTitle: "学英语"`；目标对象里 `momentum` 有值而 `pace` 为 `null`
- `momentum.visible = false`（只完成 2 次，门槛是 5）→ 面板不渲染任何计数
- **渲染级守卫**：`tests/client.test.js` 用 `react-dom/server` 把面板渲染成 HTML 后搜词，断言
  HTML 里不含 `%`、`％`、`落后`、`还差`、`进度条`、`完成度`、`未达标`、`剩余进度`；
  未达门槛时不含"已坚持"、"累计"，也不泄露具体次数
- `/goals` 响应里没有百分比类字段（显式断言）

### ✅ 7 · 面板默认只显示今日；目标总览需主动进入

`Panel` 的 `view` 初始值是 `'today'`；目标总览是第二个页签。
渲染测试断言首帧只出现今日视图的内容。

另外 §5.2 的"默认只呈现今日"还包含一层：**历史未完成项不摊在面板上**
（由对话去追问）。有用例专门断言 `pendingBefore` 里的标题不出现在今日面板。

### ✅ 9 · 目标无法被 LLM 自动标记完成

实测调用 `goal_complete(id, confirmedByUser=false)`：

```
Error: 目标完成必须由用户确认：请先在对话里问用户，得到肯定答复后再以 confirmedByUser=true 调用
```

随后 `curl /goals` 确认目标仍是 `status: "active"` —— 被拒时**没有发生任何变更**。

### ✅ 10 · 除两种异常外不主动打断

写在静态 section 里，`tests/prompt.test.js` 断言 section 同时包含
"连续顺延"与"不可能达成"两个触发条件，以及"除这两条外不要主动发起话题"。

### ✅ 11 · 跨会话一致性

派了一个**独立的 DSH 会话**（`subagent`）做只读检查。它的报告：

> 能读到一张不是我创建的、已经存在的日程表。数据看起来是**全局共享的**，
> 而不是属于当前会话：本会话没有任何创建动作，却读到了带 `generatedAt` 时间戳的既有计划、
> 跨天遗留项、池中已经累积 `deferCount=1` 的任务，以及一条长期目标 ——
> 判据还有两处明显的外部写入痕迹：「通勤路上背的，比想象中轻松」和「加班到十点，回家就睡了」，
> 我从未接触过这些字段。

它独立复现了 `plan_context` 与 `plan_history` 的返回，数字与我这边一致。

### ✅ 12 · 常驻上下文约 300 token，且与历史长度无关

实测「今日摘要」180 字符（含今日计划、往日未完成、目标、任务池计数）。

`tests/prompt.test.js` 有一条体积预算用例：往池里灌 60 条任务 + 20 条今日条目，
断言摘要仍 < 900 字符 —— 防止有人某天顺手把整个任务池倒进上下文。

摘要由 `systemPrompt.context()` 提供，作为**独立消息追加在对话尾部**；
明细一律靠工具按需拉取。所以它与聊了多久、积累了多少天都无关。

### ✅ 13 · 面板与 LLM 读到同一份数据

我用工具写入 → `curl /dynamic-planner/api/state` 读到同一份 → 独立会话也读到同一份。
不存在需要同步的两套状态。数据文件：`~/.dsh/dynamic-planner/data.json`。

---

## 🟡 需要你验的三条

### 🟡 1 · 模糊目标先追问，再落库，mode 正确

**已就位**：section 里有完整的目标澄清流程（先问 1–3 个问题、提炼成
「一句可判定的完成标准 + 推荐模式」、说明理由、得到认可再落库）；
`goal_save` 在 `mode=deadline` 但没给 `deadline` 时会降级为 `longterm`（有单测）。

**待验**：在一次真实对话里说一句模糊的话（例如"我想学吉他"），
看它是不是**先问**而不是直接建目标。

### 🟡 2 · 说"排今天的计划"能生成并出现在面板

**已就位**：`plan_write` 实测成功；`/state` 实测返回；`Panel` 有渲染测试。

**待验**：在对话里说一句"排今天的计划"，然后刷新面板看它出现。

### 🟡 4 · 勾选完成、写自由备注

**已就位**：`POST /item` 用 curl 实测通过（状态、备注、未完成原因三条路径都验过）；
面板的复选框与备注框有渲染测试。

**待验**：在浏览器里点一下。

---

## ⏳ 需要重启的一条

### ⏳ 8 · 连续完成会加量、经常完不成会减量，且量不会降到 0

**这一条原先落不了地**：`goal_save` 有 `dial` 旋钮、`clampDial` 有 `[0.2, 3]` 的下限，
但铁律 section 里只有一句"只静默调节难度与量"，**没有任何调节规则** ——
模型手上有个旋钮却不知道该怎么转。这是逐条核标准时才发现的。

**已修**（`8e858e2`）：section 里补了 §4.5 小节 —— 完成得好缓慢加量（约每周 +10%）、
完不成减量但减到最小剂量为止、不要报出具体数值、点明最小剂量是防"无声停摆"的安全网。

**为什么还没生效**：改 `lib/` 下的代码后，翻插件的启用开关**不会**让宿主重新加载模块
（ESM 缓存按 URL）。实测：文件里已是 1638 字符的新 section，而活着的系统提示里仍是旧版。

**已安装产物本身是好的** —— 直接 import 安装后的包并跑一遍 `apply`：

```
工具 (9)  : plan_context, plan_read, plan_history, plan_write, plan_item_update,
            goal_save, goal_complete, task_save, task_add_batch
section    : planner:rules | order 2450 | 静态 string | 含 §4.5: true | 1638 字符
context    : planner:today | order 200 | 是函数
路由 (4)  : /dynamic-planner/api/{state,goals,item,task}
```

所以**重启后新代码会干净加载**，这一条随之转 ✅。

---

## 复现这些证据

```bash
# 计划与目标
curl -s http://127.0.0.1:18080/dynamic-planner/api/state | python3 -m json.tool
curl -s http://127.0.0.1:18080/dynamic-planner/api/goals | python3 -m json.tool

# 错误路径
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://127.0.0.1:18080/dynamic-planner/api/state
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/dynamic-planner/api/nope

# 已安装产物的冷启动
cd ~/.dsh/profiles/web && node --input-type=module -e "
const m = await import('dsh-dynamic-planner')
console.log(m.name, JSON.stringify(m.inject))"

# 全部单测（源码目录下 175；接线后可跑到 195）
cd /home/zzk/geo/dsh-dynamic-planner && npm test
```

---

## 演示数据

`~/.dsh/dynamic-planner/data.json` 里是本次验收留下的演示数据：
一个「学英语」长期目标、若干任务、2026-09-29 与 09-30 两天的计划。
清掉：

```bash
rm ~/.dsh/dynamic-planner/data.json
```
