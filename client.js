/**
 * dsh-dynamic-planner —— 客户端半侧：侧边栏入口 + 中央面板。
 *
 * 面板的职责边界（REQUIREMENTS.md §5.4）刻意很窄：
 *   能：看今天、勾选完成、写自由备注、随手加一条待办、看目标总览（二级）
 *   不能：新建目标、拆解任务、生成计划 —— 那些留给对话
 *
 * 所以这里**不做任何 AI 决策，也不承担触发职责**。它的可靠性因此不依赖模型：
 * 即使模型完全不可用，今天这份清单照样能看、能勾、能记。
 *
 * 铁律四在这里的落点：长期目标只显示**达门槛的正向积累**，
 * 绝不出现百分比、进度条、"还剩多少"、"你落后了"。注意本文件里刻意没有任何
 * 除法 —— 不计算百分比，就不会有一天顺手把它渲染出来。
 */

window.__ModuleLoader__.load({
  id: 'dsh-dynamic-planner',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/dynamic-planner/api'
    const NS = 'dsh-dynamic-planner'

    const CSS = `
      .pl-root { height: 100%; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
      .pl-wrap { max-width: 780px; margin: 0 auto; padding: 28px 24px 64px; }
      .pl-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
      .pl-title { font-size: 20px; font-weight: 600; margin: 0; }
      .pl-date { color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .pl-spacer { flex: 1; }
      .pl-tabs { display: flex; gap: 4px; margin: 16px 0 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .pl-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
                font: inherit; font-size: 14px; padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent;
                margin-bottom: -1px; }
      .pl-tab:hover { color: var(--dsw-alias-label-primary); }
      .pl-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .pl-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
                color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; padding: 5px 10px;
                border-radius: 6px; cursor: pointer; }
      .pl-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .pl-btn:disabled { opacity: .5; cursor: default; }
      .pl-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
                 border-radius: 10px; padding: 16px 18px; }
      .pl-empty { color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 1.7; }
      .pl-empty code { background: var(--dsw-alias-bg-layer-2); padding: 2px 6px; border-radius: 4px;
                       border: 1px solid var(--dsw-alias-border-l1); font-size: 13px; }
      .pl-section { margin-top: 24px; }
      .pl-section-title { font-size: 12px; letter-spacing: .04em; text-transform: none;
                          color: var(--dsw-alias-label-secondary); margin: 0 0 8px; font-weight: 500; }
      .pl-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 8px; }
      .pl-hint code { background: var(--dsw-alias-bg-layer-2); padding: 1px 5px; border-radius: 4px;
                      border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
      .pl-item { display: flex; align-items: flex-start; gap: 10px; padding: 11px 0;
                 border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .pl-item:last-child { border-bottom: 0; }
      .pl-check { appearance: none; width: 17px; height: 17px; flex: none; margin: 2px 0 0; cursor: pointer;
                  border: 1.5px solid var(--dsw-alias-border-l2); border-radius: 5px; background: transparent;
                  position: relative; }
      .pl-check:checked { background: var(--dsw-alias-state-success-primary);
                          border-color: var(--dsw-alias-state-success-primary); }
      .pl-check:checked::after { content: ''; position: absolute; left: 5px; top: 1.5px; width: 4px; height: 8px;
                                 border: solid var(--dsw-alias-bg-base); border-width: 0 2px 2px 0;
                                 transform: rotate(45deg); }
      .pl-body { flex: 1; min-width: 0; }
      .pl-row1 { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .pl-item-title { font-size: 14px; line-height: 1.5; }
      .pl-item[data-done="true"] .pl-item-title { color: var(--dsw-alias-label-secondary);
                                                  text-decoration: line-through; }
      .pl-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .pl-chip { font-size: 11px; padding: 1px 7px; border-radius: 999px; white-space: nowrap;
                 border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
      .pl-note { width: 100%; margin-top: 6px; appearance: none; border: 0; background: transparent;
                 color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; padding: 2px 0;
                 border-bottom: 1px dashed transparent; }
      .pl-note:hover { border-bottom-color: var(--dsw-alias-border-l1); }
      .pl-note:focus { outline: none; color: var(--dsw-alias-label-primary);
                       border-bottom-color: var(--dsw-alias-brand-primary); }
      .pl-reason { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; font-style: italic; }
      .pl-add { display: flex; gap: 8px; margin-top: 14px; }
      .pl-input { flex: 1; appearance: none; background: var(--dsw-alias-bg-layer-2);
                  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
                  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; padding: 8px 10px; }
      .pl-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
      .pl-stale { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .pl-goal { padding: 14px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .pl-goal:last-child { border-bottom: 0; }
      .pl-goal-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .pl-goal-title { font-size: 15px; font-weight: 550; }
      .pl-goal-criteria { font-size: 13px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
      .pl-goal-facts { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 6px; }
      .pl-warn { color: var(--dsw-alias-state-warn-primary); }
      .pl-error { color: var(--dsw-alias-state-error-primary); font-size: 13px; margin-top: 10px; }
      .pl-momentum { color: var(--dsw-alias-state-success-primary); }
    `

    // ───────────────────────── 数据访问 ─────────────────────────

    async function call(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const payload = await response.json().catch(() => ({ ok: false, error: '响应不是 JSON' }))
      if (!response.ok || payload.ok === false) {
        throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`)
      }
      return payload
    }

    // ───────────────────────── 小组件 ─────────────────────────

    function Icon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', {
        x: 3, y: 5, width: 18, height: 16, rx: 3.5,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
      }),
      h('path', { d: 'M3 10h18', stroke: 'currentColor', strokeWidth: 1.7 }),
      h('path', { d: 'M8 3v4M16 3v4', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      h('path', {
        d: 'M8.5 15.2l2.3 2.3 4.7-5', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /**
     * 一条计划项。
     *
     * 备注框走"本地草稿 + 失焦/回车提交"，而不是每敲一个字就发一次请求 ——
     * 面板不该把用户的输入过程变成网络流量。
     */
    function ItemRow({ item, onPatch }) {
      const [note, setNote] = useState(item.note ?? '')
      const [busy, setBusy] = useState(false)
      const committed = useRef(item.note ?? '')

      useEffect(() => {
        setNote(item.note ?? '')
        committed.current = item.note ?? ''
      }, [item.id, item.note])

      const commitNote = useCallback(async () => {
        if (note === committed.current) return
        setBusy(true)
        try {
          await onPatch(item.id, { note })
          committed.current = note
        } finally {
          setBusy(false)
        }
      }, [item.id, note, onPatch])

      return h('div', { className: 'pl-item', 'data-done': item.status === 'done' },
        h('input', {
          className: 'pl-check',
          type: 'checkbox',
          checked: item.status === 'done',
          disabled: busy,
          'aria-label': `${item.title}${item.status === 'done' ? '（已完成）' : ''}`,
          onChange: (event) => {
            void onPatch(item.id, { status: event.target.checked ? 'done' : 'pending' })
          },
        }),
        h('div', { className: 'pl-body' },
          h('div', { className: 'pl-row1' },
            h('span', { className: 'pl-item-title' }, item.title),
            h('span', { className: 'pl-spacer' }),
            // 目标标签：铁律四允许显示归属，但不带任何进度暗示
            item.goalTitle ? h('span', { className: 'pl-chip' }, item.goalTitle) : null,
            h('span', { className: 'pl-meta' }, `${item.estimateMin} 分钟`),
          ),
          // 未完成原因由 LLM 在对话里问出来后写回，这里只是把它显示出来
          item.reason ? h('div', { className: 'pl-reason' }, item.reason) : null,
          h('input', {
            className: 'pl-note',
            type: 'text',
            value: note,
            placeholder: '备注（可选）',
            'aria-label': `${item.title} 的备注`,
            onChange: (event) => setNote(event.target.value),
            onBlur: () => { void commitNote() },
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            },
          }),
        ),
      )
    }

    function QuickAdd({ onAdd }) {
      const [title, setTitle] = useState('')
      const [busy, setBusy] = useState(false)
      // busy 是 state，两次极快的回车可能在同一帧里都通过判断，于是添加两条。
      // 用 ref 做真正的闸门 —— 实测出现过用户以为没生效、连点两次产生重复。
      const inFlight = useRef(false)

      const submit = useCallback(async () => {
        const value = title.trim()
        if (value === '' || inFlight.current) return
        inFlight.current = true
        setBusy(true)
        try {
          await onAdd(value)
          setTitle('')
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }, [onAdd, title])

      return h('div', { className: 'pl-add' },
        h('input', {
          className: 'pl-input',
          type: 'text',
          value: title,
          placeholder: '随手加一条待办，回车即可',
          'aria-label': '随手加一条待办',
          onChange: (event) => setTitle(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); void submit() }
          },
        }),
        h('button', {
          className: 'pl-btn', type: 'button', disabled: busy || title.trim() === '',
          onClick: () => { void submit() },
        }, '添加'),
      )
    }

    // ───────────────────────── 今日视图 ─────────────────────────

    function TodayView({ today, onRefresh, onError }) {
      const patch = useCallback(async (itemId, body) => {
        try {
          await call('/item', { method: 'POST', body: JSON.stringify({ itemId, ...body }) })
          await onRefresh()
        } catch (error) {
          onError(String(error?.message ?? error))
        }
      }, [onError, onRefresh])

      const add = useCallback(async (title) => {
        try {
          await call('/task', { method: 'POST', body: JSON.stringify({ title }) })
          await onRefresh()
        } catch (error) {
          onError(String(error?.message ?? error))
        }
      }, [onError, onRefresh])

      const items = today?.plan?.items ?? []
      const pool = today?.pool ?? []

      return h('div', null,
        items.length === 0
          ? h('div', { className: 'pl-card pl-empty' },
              '今天还没有计划。在对话里说一句 ',
              h('code', null, '排今天的计划'),
              ' 就可以 —— 我会先看看前几天实际做得怎么样，再决定今天排什么。')
          : h('div', { className: 'pl-card' }, items.map(item => h(ItemRow, { key: item.id, item, onPatch: patch }))),

        // 随手添加的待办落进任务池，所以池必须在这里可见 ——
        // 否则用户点了"添加"之后屏幕上什么都没有，会以为没生效（实测踩到过）。
        pool.length > 0
          ? h('div', { className: 'pl-section' },
              h('div', { className: 'pl-section-title' }, `还没排进今天的 · ${pool.length} 条`),
              h('div', { className: 'pl-card' }, pool.map(task => h(PoolRow, { key: task.id, task }))),
              h('div', { className: 'pl-hint' },
                '在对话里说一句 ',
                h('code', null, '排今天的计划'),
                '，我会把它们一起考虑进去。'),
            )
          : null,

        h(QuickAdd, { onAdd: add }),
      )
    }

    /**
     * 池里的一条。刻意是只读的：
     * 它还没被排进今天，在这里勾"完成"没有意义；而"把哪条排进今天"是对话那边的事。
     */
    function PoolRow({ task }) {
      return h('div', { className: 'pl-item' },
        h('div', { className: 'pl-body' },
          h('div', { className: 'pl-row1' },
            h('span', { className: 'pl-item-title' }, task.title),
            h('span', { className: 'pl-spacer' }),
            task.goalTitle ? h('span', { className: 'pl-chip' }, task.goalTitle) : null,
            h('span', { className: 'pl-meta' }, `${task.estimateMin} 分钟`),
          ),
        ),
      )
    }

    // ───────────────────────── 目标总览（二级） ─────────────────────────

    function GoalCard({ goal }) {
      const facts = []
      if (goal.mode === 'deadline' && goal.deadline) facts.push(`截止 ${goal.deadline}`)
      if (goal.poolTaskCount > 0) facts.push(`池里还有 ${goal.poolTaskCount} 条`)

      return h('div', { className: 'pl-goal' },
        h('div', { className: 'pl-goal-head' },
          h('span', { className: 'pl-goal-title' }, goal.title),
          h('span', { className: 'pl-chip' }, goal.mode === 'deadline' ? '有期限' : '长期'),
          goal.status === 'done' ? h('span', { className: 'pl-chip' }, '已完成') : null,
        ),
        goal.criteria ? h('div', { className: 'pl-goal-criteria' }, goal.criteria) : null,
        facts.length > 0 ? h('div', { className: 'pl-goal-facts' }, facts.join(' · ')) : null,

        // 有期限目标：§3.1 允许显示进度与节奏
        goal.pace
          ? h('div', { className: `pl-goal-facts${goal.pace.willMiss ? ' pl-warn' : ''}` },
              `剩 ${goal.pace.daysLeft} 天 · 待做 ${goal.pace.openTaskCount} 条共 ${goal.pace.remainingMinutes} 分钟`
              + ` · 近 7 天日均 ${goal.pace.recentDailyMinutes} 分钟`
              + (goal.pace.willMiss ? ' —— 按这个速度会赶不上，值得调整一下' : ''))
          : null,

        // 长期目标：**只有**达门槛的正向积累。未达门槛时什么都不显示，
        // 这正是"润物细无声"——不要每次都提醒他。
        goal.momentum?.visible
          ? h('div', { className: 'pl-goal-facts pl-momentum' },
              `已坚持 ${goal.momentum.streak} 天 · 累计 ${goal.momentum.total} 次`)
          : null,
      )
    }

    function GoalsView({ goals }) {
      if (goals.length === 0) {
        return h('div', { className: 'pl-card pl-empty' },
          '还没有目标。在对话里说一句你想做的事（哪怕很模糊），我会先帮你问清楚，再落成一个目标。')
      }
      return h('div', { className: 'pl-card' }, goals.map(goal => h(GoalCard, { key: goal.id, goal })))
    }

    // ───────────────────────── 面板 ─────────────────────────

    function Panel() {
      const [state, setState] = useState(null)
      const [goals, setGoals] = useState(null)
      const [view, setView] = useState('today')
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const payload = await call('/state')
          setState(payload)
          setError('')
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setLoading(false)
        }
      }, [])

      const loadGoals = useCallback(async () => {
        try {
          const payload = await call('/goals')
          setGoals(payload.goals ?? [])
          setError('')
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        if (view === 'goals' && goals === null) void loadGoals()
      }, [goals, loadGoals, view])

      // 计划是在**对话里**生成的，面板不会自己变。窗口重新获得焦点时刷一次，
      // 覆盖"切到对话排完计划再切回来"这个最常见的路径。
      useEffect(() => {
        const onFocus = () => { void load() }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [load])

      const today = state?.today
      const version = state?.version

      return h('div', { className: 'pl-root' },
        h('div', { className: 'pl-wrap' },
          h('div', { className: 'pl-head' },
            h('h1', { className: 'pl-title' }, '日程表'),
            today?.date ? h('span', { className: 'pl-date' }, today.date) : null,
            h('span', { className: 'pl-spacer' }),
            h('button', {
              className: 'pl-btn', type: 'button', disabled: loading,
              onClick: () => { void load(); if (view === 'goals') void loadGoals() },
            }, loading ? '刷新中…' : '刷新'),
          ),

          h('div', { className: 'pl-tabs' },
            h('button', {
              className: 'pl-tab', type: 'button', 'data-active': view === 'today',
              onClick: () => setView('today'),
            }, '今天'),
            h('button', {
              className: 'pl-tab', type: 'button', 'data-active': view === 'goals',
              onClick: () => setView('goals'),
            }, '目标'),
          ),

          error ? h('div', { className: 'pl-error' }, error) : null,

          // 首帧还没拿到数据时不要显示"今天还没有计划" —— 那是个会被误读的假结论
          state === null && !error
            ? h('div', { className: 'pl-card pl-empty' }, '读取中…')
            : view === 'today'
              ? h(TodayView, { today, onRefresh: load, onError: setError })
              : h(GoalsView, { goals: goals ?? [] }),

          version ? h('div', { className: 'pl-stale', style: { marginTop: 28 } },
            `插件版本 ${version} · 数据文件在 ~/.dsh/dynamic-planner/data.json`) : null,
        ),
      )
    }

    // ───────────────────────── 插件 ─────────────────────────

    return {
      // 'slots' 是硬依赖：没有它就没有任何界面可注册
      inject: ['slots'],

      /**
       * 测试缝：把纯展示组件暴露出来，好在 Node 里用 react-dom/server 渲染并断言。
       *
       * 值得为此开一个口子的原因：铁律四（不许出现百分比与落后提示）是一句
       * "不许出现什么"的约束，而这类约束最容易被某天顺手加的一个"进度 60%"破坏。
       * 有了它，`tests/client.test.js` 就能真的把面板渲染成 HTML 去搜那些词。
       * 模块加载器只读 inject 与 apply，多出来的键会被忽略。
       */
      __internals: { Icon, ItemRow, QuickAdd, TodayView, GoalCard, GoalsView, Panel },

      apply(ctx) {
        // 样式随 fiber 释放（外壳会在卸载时移除插件自有的 <style data-plugin>）
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.setAttribute('data-plugin', NS)
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, `${NS}: styles`)

        // 侧边栏图标：外壳负责点击切面板，这里只提供字形
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'planner',
          order: 40,
          label: () => '日程表',
        }, props => h(Icon, { size: props?.size })))

        // 中央主面板：key 必须与 sidebar.panellist 的 id 一致
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'planner',
        }, () => h(Panel)))
      },
    }
  },
})
