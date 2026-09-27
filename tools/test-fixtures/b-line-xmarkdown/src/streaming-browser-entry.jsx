import { Context } from '@agnes/cordis'
import { SlotRegistry } from '@agnes/web-client'
import { createLiveProjection } from '../../../../packages/web/src/live-projection.ts'
import { createMarkdownRenderer } from '../../../../packages/web/src/markdown.ts'
import { mountComposerRegion, mountTranscriptRegion } from '../../../../packages/web/src/region-slots.ts'
import { createTimelineRenderer } from '../../../../packages/web/src/timeline.ts'

// Only transport/server data are synthetic. Projection, adapters, stores, region and vendors are real.
const ctx = new Context()
await ctx.plugin(SlotRegistry)
const registry = ctx.slots
registry.setSession('stream-probe')
const transcript = document.getElementById('transcript')
const mounted = mountTranscriptRegion(registry, transcript, {
  nodeHost: 'react',
  markdownRenderer: 'xmarkdown',
})
const usage = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  calls: [],
}
const user = (id, seq) => ({ kind: 'user', id, seq, content: [{ type: 'text', text: `request ${id}` }] })
const assistant = (id, seq, effectId, text = '', thinking = '', streaming = true) => ({
  kind: 'assistant',
  id,
  seq,
  effectId,
  text,
  thinking,
  streaming,
})
const turn = (id, index, status = 'running', final = false) => ({
  id,
  turn: index,
  startSeq: index === 1 ? 1 : 4,
  startedAt: '2026-09-26T00:00:00Z',
  status,
  nodeIds: [`u${index}`, `a${index}`],
  ...(final ? { finalAssistantId: `a${index}` } : {}),
  usage,
  inherited: false,
  forkable: false,
})
const state = {
  sessionId: 'stream-probe',
  generation: 1,
  upto: 2,
  opState: null,
  nodes: [user('u1', 1), assistant('a1', 2, 'e1')],
  turns: [turn('t1', 1)],
}
const counters = { openings: 0, patches: 0, events: 0 }
const previewListeners = new Set()
const handlers = new Map()
let finishIterator
const connection = {
  connectionState: 'connected',
  on(event, handler) {
    const set = handlers.get(event) ?? new Set()
    set.add(handler)
    handlers.set(event, set)
    return () => set.delete(handler)
  },
  emit(event) {
    for (const handler of handlers.get(event) ?? []) handler()
  },
}
const session = {
  async projectUIOpening() {
    counters.openings++
    return {
      timeline: structuredClone(state),
      history: { hasEarlier: false, startIndex: 0, totalNodes: state.nodes.length },
    }
  },
  async projectUIPatch(from) {
    counters.patches++
    return {
      kind: 'patch',
      patch: {
        sessionId: state.sessionId,
        generation: 1,
        from,
        upto: state.upto,
        totalNodes: state.nodes.length,
        opState: null,
        changes: state.nodes.map((node, index) => ({ op: 'upsert', index, node: structuredClone(node) })),
        turnChanges: state.turns.map((value, index) => ({
          op: 'upsert',
          index,
          turn: structuredClone(value),
        })),
      },
    }
  },
  events() {
    counters.events++
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve) => {
            finishIterator = resolve
          }),
        return: async () => {
          finishIterator?.({ done: true })
          finishIterator = undefined
          return { done: true }
        },
      }),
    }
  },
  onPreview(listener) {
    previewListeners.add(listener)
    return () => previewListeners.delete(listener)
  },
}
const errors = []
const violations = []
document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective))
const live = createLiveProjection(session, connection, {
  timeline(value) {
    mounted.render(value.nodes, value.turns)
  },
  stream(value) {
    mounted.render(value.nodes, value.turns)
  },
  event() {},
  error(error) {
    errors.push(String(error))
  },
})
await live.start()
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const legacyHost = document.createElement('section')
legacyHost.id = 'legacy-transcript'
const staticHost = document.createElement('section')
staticHost.id = 'static-preview'
document.body.append(legacyHost, staticHost)
const legacy = createTimelineRenderer({
  transcript: legacyHost,
  newContentButton: document.createElement('button'),
})
const preview = createMarkdownRenderer(staticHost, 'static preview')
const composerHost = document.createElement('section')
composerHost.id = 'composer-probe'
Object.assign(composerHost.style, {
  position: 'fixed',
  bottom: '16px',
  right: '16px',
  width: '700px',
  zIndex: '30',
})
document.body.append(composerHost)
const composer = mountComposerRegion(registry, composerHost, {
  onCancel() {},
  onDraftChange() {},
  onError(error) {
    errors.push(String(error))
  },
  onModelSelect: async () => false,
  onPermissionSelect: async () => false,
  onSubmit() {},
  onWorkspace() {},
})
const composerView = {
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'shortcut', text: 'Enter 发送' },
  input: { disabled: false, placeholder: 'task' },
  loading: false,
  model: { accessibleName: 'model', disabled: true, label: 'model', options: [], pending: false },
  permission: { disabled: true, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: true, label: '发送', mode: 'idle', title: '发送' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: true, label: 'workspace', title: 'workspace' },
}
const api = {
  async usage(value, connected = true) {
    composer.render({ ...composerView, usage: value, connected })
    await settle()
  },
  async clearUsageSession() {
    composer.render({ ...composerView })
    registry.setSession('usage-other')
    await settle()
  },
  async retireComposer() {
    composer.dispose()
    composerHost.remove()
    await settle()
  },
  async cost(node, prepend = false) {
    const nodes = [...(prepend ? [user('cost-user', 1)] : []), node]
    mounted.render(nodes)
    legacy.render(nodes)
    await settle()
  },
  legacyRender(text, streaming = true) {
    legacy.render([assistant('legacy-a', 1, 'legacy-effect', text, '', streaming)])
  },
  staticRender(text) {
    preview.update(text)
  },
  async render(text, thinking = '', streaming = true, status = 'running', final = false) {
    mounted.render(
      [user('u1', 1), assistant('a1', 2, 'e1', text, thinking, streaming)],
      [turn('t1', 1, status, final)],
    )
    await settle()
    // Manual cases may reuse a completed turn; open its process just as a reader would.
    const process = transcript.querySelector('.turn-process')
    if ((status === 'running' || status === 'waiting') && process && !process.hidden && !process.open) {
      process.querySelector('summary').click()
      await settle()
    }
  },
  async reset() {
    mounted.reset()
    await live.refresh()
    await settle()
  },
  async preview(delta, offset = 0, effectId = 'e1', stream = 'text') {
    for (const listener of previewListeners)
      listener({ sessionId: state.sessionId, lane: 'main', effectId, stream, offset, delta })
    await settle()
  },
  async reconnect() {
    connection.connectionState = 'reconnecting'
    connection.emit('reconnecting')
    connection.connectionState = 'connected'
    connection.emit('reconnected')
    await settle()
  },
  async complete(text = 'final answer', index = 1, status = 'completed') {
    state.upto++
    const position = state.nodes.findIndex((node) => node.id === `a${index}`)
    state.nodes[position] = assistant(`a${index}`, index === 1 ? 2 : 5, `e${index}`, text, '', false)
    state.turns[index - 1] = turn(`t${index}`, index, status, true)
    await live.refresh()
    await settle()
  },
  async next() {
    state.upto = 5
    state.nodes.push(user('u2', 4), assistant('a2', 5, 'e2'))
    state.turns.push(turn('t2', 2))
    await live.refresh()
    await settle()
  },
  async replay() {
    await live.refresh()
    await settle()
  },
  async switchSession() {
    await live.stop()
    registry.setSession('other')
    mounted.reset()
    mounted.render([assistant('a1', 1, 'other', 'new session', '', false)])
    await settle()
  },
  async dispose() {
    await live.stop()
    composer.dispose()
    mounted.dispose()
    await ctx.fiber.dispose()
    legacy.dispose()
    preview.dispose()
    await settle()
  },
  snapshot() {
    return {
      text: transcript.textContent,
      ids: [...transcript.querySelectorAll('[data-node-id]')].map((node) => node.dataset.nodeId),
      selected: document.getSelection()?.toString(),
      errors,
      violations,
      counters,
      previewListeners: previewListeners.size,
      connectionListeners: [...handlers.values()].reduce((n, set) => n + set.size, 0),
    }
  },
}
window.__aghStreamingProbe = api
function report() {
  document.getElementById('report').textContent = JSON.stringify(api.snapshot(), null, 2)
}
document.getElementById('delta').onclick = async () => {
  await api.preview('partial **open')
  report()
}
document.getElementById('reconnect').onclick = async () => {
  await api.reconnect()
  report()
}
document.getElementById('complete').onclick = async () => {
  await api.complete()
  report()
}
document.getElementById('next').onclick = async () => {
  await api.next()
  await api.preview('next partial', 0, 'e2')
  report()
}
document.getElementById('release').onclick = () => {
  document.getSelection()?.removeAllRanges()
  document.dispatchEvent(new Event('selectionchange'))
  setTimeout(report, 0)
}
report()
