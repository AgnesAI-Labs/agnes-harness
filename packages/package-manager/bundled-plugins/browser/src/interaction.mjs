import { failure } from './policy.mjs'
import { selectView } from './streams.mjs'

// The native broker owns actor/session admission, revocation, rate limits and lease expiry.
// This plugin channel routes gestures; opening it never takes a page away from the agent.
export function interact(runtime, _input, context) {
  if (context.scope.kind !== 'session' || context.scope.laneId !== 'main' || !context.control)
    throw failure('DENIED', 'Native session control admission required.')
  const session = { key: context.scope.sessionId, lane: 'main' }
  const actor = JSON.stringify([context.actor.id, context.actor.org ?? ''])
  const owned = new Map()
  let stopped = false,
    last = 0
  const attach = (item) => {
    const previous = item.inputStream
    const handle = {
      close(reason) {
        owned.delete(item.id)
        if (item.inputStream === handle) {
          item.inputStream = undefined
          item.mode = 'agent'
          item.control = undefined
          runtime.clearRefs(item)
          for (const key of ['Shift', 'Control', 'Alt', 'Meta'])
            void item.page.keyboard.up(key).catch(() => {})
          void item.page.mouse.up().catch(() => {})
        }
        if (reason !== 'renewed') context.stream.send({ type: 'controlLost', pageId: item.id })
      },
    }
    owned.set(item.id, handle)
    item.inputStream = handle
    item.control.expiresAt = context.control.expiresAt
    previous?.close('renewed')
  }
  // A renewed native lease adopts only this actor's existing grant. It does not reacquire control.
  for (const page of runtime.list(session)) {
    const item = runtime.get(session, page.pageId)
    if (
      item.mode === 'human' &&
      item.control?.nativeId === context.control.grantId &&
      item.control.actor === actor
    )
      attach(item)
  }
  const close = () => {
    if (stopped) return
    stopped = true
    for (const handle of [...owned.values()]) handle.close()
    context.signal.removeEventListener('abort', close)
  }
  context.signal.addEventListener('abort', close, { once: true })
  context.stream.onDisconnect(close)
  if (context.signal.aborted) close()
  context.stream.onFrame((frame) => {
    if (
      stopped ||
      context.signal.aborted ||
      !frame ||
      frame instanceof Uint8Array ||
      typeof frame !== 'object'
    )
      return
    if (!Number.isSafeInteger(frame.id) || frame.id <= last) return
    last = frame.id
    const work = async () => {
      if (context.control.expiresAt <= Date.now()) throw failure('DENIED', 'Control lease expired.')
      if (frame.type === 'view') {
        if (typeof frame.viewId !== 'string' || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1)
          throw failure('INVALID_INPUT', 'Invalid view selection.')
        return selectView(runtime, frame, { session, actor: context.actor })
      }
      const item = runtime.get(session, frame.pageId)
      if (frame.type === 'pause') {
        if (owned.get(item.id) === item.inputStream && item.controlEpoch === frame.controlEpoch)
          await runtime.control(
            session,
            { pageId: item.id, mode: 'agent' },
            context.actor,
            undefined,
            context.signal,
          )
        return { status: 'ok' }
      }
      if (frame.type === 'control') {
        if (!['human', 'agent'].includes(frame.mode) || frame.pageEpoch !== item.epoch)
          throw failure('STALE_INPUT', 'Page changed before handover.')
        const result = await runtime.control(session, frame, context.actor, context.control, context.signal)
        if (frame.mode === 'human') attach(item)
        return result
      }
      if (frame.type !== 'input' || owned.get(item.id) !== item.inputStream || !item.inputStream)
        throw failure('DENIED', 'Page control required.')
      return runtime.humanInput(
        session,
        {
          ...frame.input,
          pageId: frame.pageId,
          controlId: item.control?.id,
        },
        context.actor,
        context.signal,
      )
    }
    void work().then(
      (result) => context.stream.send({ id: frame.id, status: 'ok', result }),
      (error) => context.stream.send({ id: frame.id, status: 'error', code: error.code ?? 'UNCERTAIN' }),
    )
  })
}
