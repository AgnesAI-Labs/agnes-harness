/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type { EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { createJevTranslate } from '../src/jev-locale.js'
import { createJevDirectStats, jevDirectCount } from '../src/jev-stats.js'
import { bindJevWorkspace } from '../src/jev-workspace.js'
import { createRuntimeRecordTrace } from '../src/runtime-record-trace.js'

const t = createJevTranslate('zh-CN')

afterEach(() => {
  document.body.replaceChildren()
  localStorage.clear()
})

it('keeps one conversation/composer beside the graph and remembers accessible split changes', () => {
  document.body.innerHTML = `<section id="session-workspace" data-workbench-surface="workspace">
    <aside id="runtime-records" data-workbench-surface="aside"></aside>
    <div id="jev-workspace-split" data-workbench-surface="divider"></div>
    <div class="session-chat" data-workbench-surface="conversation">
      <nav data-workbench-surface="toolbar"></nav>
      <div id="conversation-shell"></div><div id="trace-panel"></div><div id="approval"></div>
      <footer data-workbench-surface="footer"></footer><div id="composer-mount"></div>
    </div></section>`
  const root = document.getElementById('session-workspace')!
  const separator = document.getElementById('jev-workspace-split')!
  const graph = document.getElementById('runtime-records')!
  expect(graph.parentElement).toBe(root)
  for (const id of ['conversation-shell', 'trace-panel', 'approval', 'composer-mount']) {
    expect(document.querySelectorAll(`#${id}`)).toHaveLength(1)
    expect(document.getElementById(id)?.closest('.session-chat')?.parentElement).toBe(root)
  }
  const workspace = bindJevWorkspace(
    {
      root,
      divider: separator,
      aside: graph,
      chat: root.querySelector('[data-workbench-surface="conversation"]')!,
      toolbar: root.querySelector('[data-workbench-surface="toolbar"]')!,
      footer: root.querySelector('[data-workbench-surface="footer"]')!,
    },
    { call: vi.fn() } as unknown as Pick<Client, 'call'>,
    t,
  )
  workspace.directStats.update({
    runtime: { id: 'jevloop', version: '1' },
    events: withDirectRoutes(),
    complete: true,
  })
  const dock = root.querySelector('.jev-stats-dock')
  expect(separator.tabIndex).toBe(0)
  expect(separator.getAttribute('role')).toBe('separator')
  expect(separator.getAttribute('aria-orientation')).toBe('vertical')
  expect(separator.getAttribute('aria-label')).toBe('调整决策图与对话宽度')
  expect(dock?.parentElement?.dataset.workbenchSurface).toBe('footer')
  expect(dock?.closest('[hidden]')).toBeNull()
  expect(dock?.querySelector<HTMLElement>('[data-jev-direct-count]')?.hidden).toBe(false)
  expect(dock?.textContent).toContain('Jev 直通 2 次')
  separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
  expect(separator.getAttribute('aria-valuenow')).toBe('53')
  expect(localStorage.getItem('agnes.jev-workspace.graph-percent')).toBe('53')
  for (let i = 0; i < 25; i++) separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  expect(separator.getAttribute('aria-valuenow')).toBe('65')
  separator.dispatchEvent(new MouseEvent('dblclick'))
  expect(separator.getAttribute('aria-valuenow')).toBe('55')
  const graphTab = root.querySelector<HTMLButtonElement>('[data-workspace-view="graph"]')!
  const chatTab = root.querySelector<HTMLButtonElement>('[data-workspace-view="chat"]')!
  graphTab.click()
  expect(root.dataset.view).toBe('graph')
  expect(graphTab.getAttribute('aria-pressed')).toBe('true')
  expect(chatTab.getAttribute('aria-pressed')).toBe('false')
  chatTab.click()
  expect(root.dataset.view).toBe('chat')
  root.getBoundingClientRect = () => ({ width: 800, left: 0 }) as DOMRect
  for (let i = 0; i < 25; i++) separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
  expect(separator.getAttribute('aria-valuenow')).toBe('40')
  expect(separator.getAttribute('aria-valuemin')).toBe('40')
  separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  expect(separator.getAttribute('aria-valuenow')).toBe('42')
  workspace.dispose()
  expect(root.querySelector('.jev-stats-dock')).toBeNull()
  expect(root.querySelector('.jev-workspace-views')).toBeNull()
  expect(root.style.getPropertyValue('--jev-graph-width')).toBe('')
  for (const attribute of ['role', 'tabindex', 'aria-orientation', 'aria-label'])
    expect(separator.hasAttribute(attribute)).toBe(false)
  separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
  expect(separator.hasAttribute('aria-valuenow')).toBe(false)
  workspace.updateView('trace')
  expect(root.style.getPropertyValue('--jev-graph-width')).toBe('')
})

function capturedEvents(): EventEnvelope[] {
  return (
    JSON.parse(readFileSync('packages/core/test/fixtures/jev-real-trace.json', 'utf8')) as {
      events: EventEnvelope[]
    }
  ).events
}

function withDirectRoutes(): EventEnvelope[] {
  // The real run used parameter generation for all three tools. These explicit synthetic
  // variants exercise no-argument/candidate routing without claiming a captured direct run.
  return capturedEvents().map((event) => {
    if (event.seq !== 20 && event.seq !== 43) return event
    const data = event.data as { record: { resource: Record<string, unknown> } }
    return {
      ...event,
      data: {
        ...data,
        record: {
          ...data.record,
          resource: {
            ...data.record.resource,
            route: 'direct',
            parameterMode: event.seq === 20 ? 'no_arguments' : 'parameterized',
            candidateId: event.seq === 20 ? null : 'complete-candidate',
          },
        },
      },
    } as EventEnvelope
  })
}

it('counts dispatch-linked direct decisions, not successful tools, proposals, preflight denials or arbitration', () => {
  const real = capturedEvents()
  expect(real.filter((event) => event.type === 'tool/result')).toHaveLength(3)
  expect(jevDirectCount(real)).toBe(0)
  const direct = withDirectRoutes()
  expect(jevDirectCount(direct.filter((event) => event.seq < 29))).toBe(0)
  expect(jevDirectCount(direct.filter((event) => event.seq <= 29))).toBe(1)
  expect(jevDirectCount(direct.filter((event) => event.seq < 54))).toBe(1)
  expect(jevDirectCount(direct)).toBe(2)
  expect(jevDirectCount([...direct, ...direct])).toBe(2)
  expect(jevDirectCount(direct.map((event) => ({ ...event, trust: 'untrusted' })))).toBe(0)
  expect(jevDirectCount(direct.map((event) => ({ ...event, origin: 'llm' })))).toBe(0)
  expect(jevDirectCount(direct.filter((event) => event.seq !== 29 && event.seq !== 54))).toBe(0)
  expect(
    jevDirectCount(
      direct.map((event) => {
        if (event.seq !== 18 && event.seq !== 41) return event
        const data = event.data as { record: Record<string, unknown> }
        return {
          ...event,
          data: { ...data, record: { ...data.record, source: 'llm_arbitration' } },
        } as EventEnvelope
      }),
    ),
  ).toBe(0)
  // Dispatch failures still count; host tool/result and runtime settlement content are irrelevant.
  expect(
    jevDirectCount(
      direct.map((event) => {
        const data = event.data as { record?: Record<string, unknown> }
        if (data.record?.kind !== 'action.settled') return event
        return {
          ...event,
          data: {
            ...data,
            record: { ...data.record, effect: 'unknown', outcome: { kind: 'error', content: [] } },
          },
        } as EventEnvelope
      }),
    ),
  ).toBe(2)
  // The legacy route link through requested is equivalent to the explicit accepted decision id.
  expect(
    jevDirectCount(
      direct.map((event) => {
        if (event.seq !== 20 && event.seq !== 43) return event
        const data = event.data as { record: { resource: Record<string, unknown> } }
        return {
          ...event,
          data: {
            ...data,
            record: {
              ...data.record,
              resource: {
                ...data.record.resource,
                decisionRecordId: null,
              },
            },
          },
        } as EventEnvelope
      }),
    ),
  ).toBe(2)
  expect(jevDirectCount(direct.filter((event) => event.seq !== 18 && event.seq !== 41))).toBe(0)
})

it.each(['session', 'comparison'] as const)(
  'shows complete %s counts and clears native or unknown owners',
  (scope) => {
    const host = document.createElement('div')
    const stats = createJevDirectStats(host, scope, t)
    const reading = host.querySelector<HTMLElement>('[data-jev-direct-count]')!
    const evidence = { runtime: { id: 'jevloop', version: '1' }, events: withDirectRoutes(), complete: true }
    stats.update({ ...evidence, complete: false })
    expect(reading.hidden).toBe(scope === 'session')
    expect(reading.textContent).toBe(scope === 'session' ? '' : 'Jev 直通：待同步')
    stats.update(evidence)
    expect(reading.hidden).toBe(false)
    expect(reading.textContent).toBe('Jev 直通 2 次')
    // Rebuilding after reopening retains the cumulative count.
    stats.update({ ...evidence, events: [...evidence.events] })
    expect(reading.textContent).toBe('Jev 直通 2 次')
    for (const runtime of [undefined, { id: 'native', version: '1' }, { id: 'jevloop', version: '2' }]) {
      stats.update({ ...evidence, runtime })
      expect(reading.hidden).toBe(true)
      expect(reading.textContent).toBe('')
    }
    stats.update({ ...evidence, events: capturedEvents() })
    expect(reading.textContent).toBe('Jev 直通 0 次')
  },
)

it('feeds statistics from the existing complete ledger read and ignores late reads after session clearing', async () => {
  const host = document.createElement('div')
  const dock = document.createElement('div')
  const stats = createJevDirectStats(dock, 'session', t)
  const reading = dock.querySelector<HTMLElement>('[data-jev-direct-count]')!
  const events = withDirectRoutes()
  let finish!: (value: unknown) => void
  const call = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const trace = createRuntimeRecordTrace(host, { call } as unknown as Pick<Client, 'call'>, stats.update, {
    t,
  })
  const owner = { id: 'jevloop', version: '1' }
  trace.select('captured-session', 0, owner)
  expect(reading.hidden).toBe(true)
  finish({ events: events.slice(0, 30), lastSeq: events.at(-1)?.seq, nextAfterSeq: 30 })
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(reading.hidden).toBe(true) // One direct dispatch in a partial page is not a whole-session count.
  finish({ events: events.slice(30), lastSeq: events.at(-1)?.seq, nextAfterSeq: null })
  await vi.waitFor(() => expect(reading.textContent).toBe('Jev 直通 2 次'))
  // Graph playback has no influence on the whole-session reading.
  const cursor = host.querySelector<HTMLInputElement>('[aria-label="Jev 账本回放位置"]')
  if (!cursor) throw new Error('Missing graph replay control')
  cursor.value = '0'
  cursor.dispatchEvent(new Event('input'))
  expect(reading.textContent).toBe('Jev 直通 2 次')
  const dispatch = events.find((event) => event.seq === 29)
  if (!dispatch) throw new Error('Missing captured dispatch')
  trace.observe({ ...dispatch, seq: 1000, id: 'new-live-dispatch' })
  expect(reading.hidden).toBe(true)
  trace.select('next-session', 0, owner)
  expect(reading.hidden).toBe(true)
  trace.select()
  finish({ events, lastSeq: events.at(-1)?.seq, nextAfterSeq: null })
  await Promise.resolve()
  expect(reading.hidden).toBe(true)
  expect(reading.textContent).toBe('')
  trace.dispose()
})
