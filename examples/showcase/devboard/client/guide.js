import { homeNavigation, openApplicationWork } from '@agnes/web-client'
import { Badge, Button, Segmented } from '@agnes/web-ui'
import React from 'react'
import { MAIN_STEPS, ROLE_STEPS } from './guide-data.js'
import { guideMemory } from './guide-memory.js'
import { OPTIONAL_STEPS } from './guide-optional.js'
import { mainProgress, stepProject } from './guide-progress.js'

// Demo guide: a side panel next to the page (not a modal, so the audience still sees the page), step cards
// with a "带我去" jump and a spotlight (outline plus a text bubble), and local-only progress. Nothing here
// writes to the board or the backend; guide-memory.js remembers ticks and first visits in this browser.

const h = React.createElement
const PROJECT_KEY = 'devboard.project'
const PANEL_ID = 'devboard-guide-panel'
const TITLE_ID = 'devboard-guide-title'
const FIND_MS = 3000
const SPOT_MS = 9000
const MISSING = '（页面上暂时没有这一块：先选对项目，或把「只看与我相关」切到「全部」。）'
const NO_LIVE =
  '还没有现场项目：先做主线第 2 步让研发协调员新建一个，或在「项目组合」点「快进演示到…」得到一个。'
const STEPS = new Map(
  [...MAIN_STEPS, ...OPTIONAL_STEPS, ...Object.values(ROLE_STEPS).flat()].map((s) => [s.id, s]),
)
const message = (error) => (error instanceof Error ? error.message : String(error))

// ── Progress (guide-memory.js keeps it in this browser) ────────────────────────────────────────────

const setTick = (step, role, on) => {
  guideMemory.setTick(Boolean(step.role), role, step.id, on)
  touch()
}

// ── Shared state: the panel stays open while the audience moves between pages ───────────────────────

let lastJump = 0
// `focus` maps a tab to its expanded step id ('' = all collapsed); it survives page changes with the panel.
let state = { open: false, tab: 'role', spot: null, focusPanel: false, focus: {}, v: 0 }
const listeners = new Set()
const subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const getState = () => state
function update(patch) {
  state = { ...state, ...patch }
  for (const fn of listeners) fn()
}
const touch = () => update({ v: state.v + 1 })
const useGuide = () => React.useSyncExternalStore(subscribe, getState)
const showSpot = (step) =>
  update({ spot: { ids: [].concat(step.target ?? []), text: step.spot, plain: step.plain, key: Date.now() } })
const returnFocus = () =>
  setTimeout(() => document.querySelector('[data-guide="guide-button"] button')?.focus(), 0)
function closePanel(focusButton) {
  update({ open: false })
  if (focusButton) returnFocus()
}

/** "带我去": open the step's page (the target page lights the spot on arrival) or the coordinator. */
function go(step, board, page) {
  if (step.action === 'new-project') {
    try {
      openApplicationWork('new-project')
    } catch (e) {
      board.setError(`无法打开研发协调员：${message(e)}。请先在智能体页采纳 DevBoard。`)
    }
    return
  }
  // The project list of the pages is shared (board.js PROJECT_KEY); '' means all projects, or the first one
  // on the pages that always show one project. A page reads it only when it mounts.
  if (step.page === page && !step.project) return showSpot(step)
  const project = stepProject(step, board.data)
  if (project === null) return showSpot({ spot: NO_LIVE, plain: true })
  let stored = null
  try {
    stored = window.sessionStorage.getItem(PROJECT_KEY)
    window.sessionStorage.setItem(PROJECT_KEY, project)
  } catch {}
  if (step.page === page && stored === project) return showSpot(step)
  try {
    homeNavigation.open(step.page, {
      devboard: { guide: [].concat(step.target ?? []), step: step.id, project, at: Date.now() },
    })
  } catch (e) {
    board.setError(`无法打开页面：${message(e)}`)
  }
}

// ── Spotlight: outline on the target (data-guide) plus a bubble with words, never colour alone ───────

function bubbleAt(node, above) {
  const r = node.getBoundingClientRect()
  const width = Math.min(320, window.innerWidth - 16)
  const clamp = (x) => Math.max(8, Math.min(x, window.innerWidth - width - 8))
  // A tall target (a whole table): the bubble straddles the top right of its outline, where pages are usually empty.
  if (r.height > window.innerHeight * 0.4)
    return {
      top: Math.max(8, Math.min(r.top - 18, window.innerHeight - 120)),
      left: clamp(r.right - width - 12),
      width,
    }
  if (above && r.top > 100)
    return { top: r.top - 12, left: clamp(r.left), width, transform: 'translateY(-100%)' }
  if (window.innerHeight - r.bottom > 110) return { top: r.bottom + 12, left: clamp(r.left), width }
  if (r.top > 130) return { top: r.top - 12, left: clamp(r.left), width, transform: 'translateY(-100%)' }
  return { top: Math.max(8, r.top + 8), left: clamp(r.left + 8), width }
}

function Spotlight() {
  const { spot } = useGuide()
  const [bubble, setBubble] = React.useState(null)
  React.useEffect(() => {
    if (!spot) {
      setBubble(null)
      return undefined
    }
    const timers = []
    let target = null
    let anchor = null
    let text = spot.text
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const place = () => anchor && setBubble({ ...bubbleAt(anchor, !target), text, leaving: false })
    const stop = () => update({ spot: null })
    const started = Date.now()
    const find = () => {
      target = spot.ids.map((id) => document.querySelector(`[data-guide="${id}"]`)).find(Boolean) ?? null
      if (!target && Date.now() - started < FIND_MS) return timers.push(setTimeout(find, 150))
      anchor = target ?? document.querySelector('[data-guide="page-title"]')
      if (!anchor) return stop()
      if (target) {
        target.setAttribute('data-guide-spot', 'on')
        // A tall target (a whole table) is only brought into view; a small one is centred.
        const tall = target.getBoundingClientRect().height > window.innerHeight * 0.6
        target.scrollIntoView({ block: tall ? 'nearest' : 'center', behavior: reduced ? 'auto' : 'smooth' })
      } else if (!spot.plain) text = `${spot.text}${MISSING}`
      place()
      timers.push(
        setTimeout(() => setBubble((b) => b && { ...b, leaving: true }), SPOT_MS - 700),
        setTimeout(stop, SPOT_MS),
      )
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      stop()
    }
    find()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', stop, true)
    return () => {
      for (const t of timers) clearTimeout(t)
      target?.removeAttribute('data-guide-spot')
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', stop, true)
    }
  }, [spot])
  if (!bubble) return null
  const { text, leaving, ...position } = bubble
  return h(
    'div',
    { className: `devboard-spot-bubble${leaving ? ' is-leaving' : ''}`, role: 'status', style: position },
    text,
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────────────────────────────

export function GuideButton() {
  const { open } = useGuide()
  return h(
    'span',
    { 'data-guide': 'guide-button' },
    h(
      Button,
      {
        'aria-expanded': open,
        'aria-controls': PANEL_ID,
        onClick: () => (open ? closePanel(false) : update({ open: true, focusPanel: true })),
      },
      '演示指引',
    ),
  )
}

function StepCard({ step, index, role, expanded, done, auto, actions }) {
  const { toggle, tick, next, go: jump, switchRole, toMain } = actions
  const mine = !step.role || step.role === role
  return h(
    'li',
    { className: `devboard-guide-step${done ? ' is-done' : ''}${expanded ? ' is-open' : ''}` },
    h(
      'div',
      { className: 'devboard-guide-head' },
      h('input', {
        type: 'checkbox',
        checked: done,
        disabled: auto,
        'aria-label': `标记第 ${index + 1} 步完成：${step.title}${auto ? '（看板数据已确认，自动打勾）' : ''}`,
        onChange: (e) => tick(step, e.target.checked),
      }),
      h(
        'button',
        { type: 'button', 'aria-expanded': expanded, onClick: () => toggle(step.id) },
        h('span', { className: 'devboard-guide-no' }, index + 1),
        h('span', null, step.title),
        step.script && h(Badge, { tone: 'off' }, step.script),
        step.role && h(Badge, { tone: mine ? 'ok' : 'off' }, step.role),
      ),
    ),
    expanded &&
      h(
        'div',
        { className: 'devboard-guide-body' },
        h('p', null, h('strong', null, '怎么做：'), step.how),
        h('p', null, h('strong', null, '你会看到：'), step.see),
        h('p', null, h('strong', null, '在实际工作中：'), step.value),
        step.note && h('p', { className: 'devboard-muted', role: 'note' }, `提示：${step.note}`),
        step.done &&
          h(
            'p',
            { className: 'devboard-muted' },
            auto ? '看板数据显示这一步已完成。' : '这一步完成后，看板数据会让它自动打勾。',
          ),
        h(
          'div',
          { className: 'devboard-buttons' },
          h(Button, { appearance: 'primary', onClick: () => jump(step) }, '带我去'),
          step.role && !mine && h(Button, { onClick: () => switchRole(step.role) }, `切换为 ${step.role}`),
          step.main?.map((n) => h(Button, { key: n, onClick: () => toMain(n) }, `看主线第 ${n} 步`)),
          h(Button, { onClick: () => next(step) }, step.done ? '下一步' : '完成，下一步'),
        ),
      ),
  )
}

export function GuidePanel({ board, role, setRole, page, jump }) {
  const { open, tab, focusPanel, focus } = useGuide()
  const setFocus = (next) => update({ focus: next })
  const panel = React.useRef(null)
  const title = React.useRef(null)
  const steps = { main: MAIN_STEPS, optional: OPTIONAL_STEPS }[tab] ?? ROLE_STEPS[role] ?? []
  const auto = React.useMemo(() => (board.data ? mainProgress(board.data, MAIN_STEPS) : {}), [board.data])
  // Optional steps are ticked by the presenter and kept with the main line's ticks (their ids do not clash).
  const ticked = guideMemory.ticks(tab !== 'role', role)
  const isDone = (s) => Boolean(tab === 'main' && auto[s.id]) || ticked.has(s.id)
  const firstOpen = steps.find((s) => !isDone(s))?.id
  const current = focus[tab] === '' || steps.some((s) => s.id === focus[tab]) ? focus[tab] : firstOpen

  // First visit of a role: open the panel on "我的角色" and light step 1 when it is on this page.
  React.useEffect(() => {
    if (!board.data || !role) return
    if (guideMemory.seen(role)) return
    if (open) return guideMemory.markSeen(role)
    if (guideMemory.shouldAutoOpen(role)) {
      guideMemory.markSeen(role)
      update({ open: true, tab: 'role' })
      const first = ROLE_STEPS[role]?.[0]
      if (first?.page === page) setTimeout(() => showSpot(first), 400)
    }
  }, [board.data, role, page, open])
  // A jump from the panel of another page: light the spot once the page has its data.
  React.useEffect(() => {
    const step = STEPS.get(jump?.step)
    if (!board.data || !step || jump.at === lastJump || Date.now() - jump.at > SPOT_MS) return
    lastJump = jump.at
    showSpot(step)
  }, [board.data, jump])
  React.useEffect(() => {
    if (!open || !focusPanel) return
    title.current?.focus()
    update({ focusPanel: false })
  }, [open, focusPanel])
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || getState().spot) return
      if (!panel.current?.contains(document.activeElement)) return
      e.preventDefault()
      closePanel(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return h(Spotlight)
  const total = MAIN_STEPS.length
  const finished = MAIN_STEPS.filter((s) => (auto[s.id] ?? false) || guideMemory.ticks(true).has(s.id)).length
  const actions = {
    toggle: (id) => setFocus({ ...focus, [tab]: current === id ? '' : id }),
    tick: (step, on) => setTick(step, role, on),
    next: (step) => {
      if (!step.done) setTick(step, role, true)
      const at = steps.indexOf(step)
      setFocus({ ...focus, [tab]: steps[at + 1]?.id ?? step.id })
    },
    go: (step) => go(step, board, page),
    switchRole: setRole,
    toMain: (n) => {
      update({ tab: 'main', focus: { ...focus, main: `m${n}` } })
    },
  }
  return h(
    React.Fragment,
    null,
    h(
      'aside',
      { id: PANEL_ID, ref: panel, className: 'devboard-guide', 'aria-labelledby': TITLE_ID },
      h(
        'div',
        { className: 'devboard-guide-top' },
        h('h2', { id: TITLE_ID, ref: title, tabIndex: -1 }, '演示指引'),
        h(Button, { size: 'small', onClick: () => closePanel(true) }, '收起'),
      ),
      h(Segmented, {
        label: '指引类型',
        value: tab,
        onChange: (value) => update({ tab: value }),
        options: [
          { value: 'main', label: '全流程主线' },
          { value: 'optional', label: '可选剧本' },
          { value: 'role', label: '我的角色' },
        ],
      }),
      h(
        'p',
        { className: 'devboard-muted' },
        tab === 'main'
          ? `一个需求怎样变成可运行的项目，共 ${total} 步，已完成 ${finished} 步。每一步标出由哪个角色操作；有看板依据的步骤会自动打勾。`
          : tab === 'optional'
            ? '两段可选剧本，不在 12 步主线里：「客户变更」（客户中途改要求，过 CCB 后返工）和「缺陷卡门」（A 类缺陷挡住 TR5）。演示者自己打勾。'
            : `当前演示角色：${role}，共 ${steps.length} 步。换一个角色，这里的步骤会跟着变。`,
      ),
      h(
        'ol',
        {
          className: 'devboard-guide-steps',
          'aria-label': { main: '全流程主线', optional: '可选剧本' }[tab] ?? `${role}的上手步骤`,
        },
        steps.map((step, i) =>
          h(StepCard, {
            key: step.id,
            step,
            index: i,
            role,
            expanded: current === step.id,
            done: isDone(step),
            auto: Boolean(tab === 'main' && auto[step.id]),
            actions,
          }),
        ),
      ),
      h(
        'div',
        { className: 'devboard-guide-foot' },
        h(
          'label',
          { className: 'devboard-guide-check' },
          h('input', {
            type: 'checkbox',
            checked: guideMemory.autoOpenOff(),
            onChange: (e) => {
              guideMemory.setAutoOpenOff(e.target.checked)
              touch()
            },
          }),
          '不再自动打开',
        ),
        h(
          Button,
          {
            onClick: () => {
              guideMemory.restart(role)
              setFocus({})
              touch()
            },
          },
          '从头开始',
        ),
      ),
    ),
    h(Spotlight),
  )
}
