import type { ContentBlock } from '@agnes/protocol'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import type { Session } from '@agnes/sdk/browser'
import type { AppSessionContext } from '../app.js'
import { showCommandFeedback } from './command-feedback.js'

export function createCommandController(
  context: Pick<
    AppSessionContext,
    | 'composerDraftKey'
    | 'client'
    | 'composerRuntime'
    | 'configured'
    | 'connected'
    | 'controlPending'
    | 'controlsHistory'
    | 'controlsRefresh'
    | 'current'
    | 'live'
    | 'notice'
    | 'permissionChangePending'
    | 'permissionRefreshPending'
    | 'projection'
    | 'queueAction'
    | 'recoveredReturns'
    | 'render'
    | 'renderControls'
    | 'run'
    | 'selectedModelAvailable'
    | 'selection'
    | 'sessionControls'
    | 'sessionPending'
    | 'sessionYoloEnabled'
    | 'showError'
    | 'stopAfterSeq'
    | 'stopping'
    | 't'
  >,
) {
  let stopRequest = 0
  function handleComposerCancel(): void {
    requestStop(false)
  }

  function requestStop(force: boolean): void {
    context.run(async () => {
      const session = context.current
      if (!session || context.sessionPending || context.stopping) return
      const epoch = context.selection
      const request = ++stopRequest
      const current = () =>
        context.current === session && context.selection === epoch && request === stopRequest
      context.stopping = true
      context.stopAfterSeq = context.projection?.upto ?? 0
      context.render()
      let timer: ReturnType<typeof setTimeout> | undefined
      let poll: ReturnType<typeof setTimeout> | undefined
      let wake: (() => void) | undefined
      let finished = false
      const directStop = async () => {
        await context.client.notify('session/cancel', { sessionId: session.id })
        let afterSeq = context.stopAfterSeq
        while (!finished) {
          const state = await context.client.call<SessionControlStateResult>(
            '_agnes/v1/session.controls',
            { sessionId: session.id, afterSeq },
            { timeoutMs: 1000 },
          )
          if (state.facts?.some((fact) => fact.action === 'cancel' && fact.outcome === 'applied')) return
          afterSeq = state.factsThrough ?? afterSeq
          if (!finished && !state.factsMore)
            await new Promise<void>((resolve) => {
              wake = resolve
              poll = setTimeout(resolve, 100)
            })
        }
      }
      try {
        await Promise.race([
          // The direct, owner-checked control bypasses an unresolved durable command receipt.
          force ? directStop() : session.cancel(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('stop confirmation timeout')), 10_000)
          }),
        ])
        if (current()) {
          context.notice.setText('')
          context.live?.refresh()
          void refreshSessionControls(session).catch(context.showError)
        }
      } catch {
        if (!current() || context.sessionPending) return
        context.notice.setText(context.t('app.stop.unconfirmed'))
        context.notice.setKind('warning')
        context.notice.offerMany([
          { label: context.t('app.stop.retry'), run: () => current() && requestStop(false) },
          { label: context.t('app.stop.force'), run: () => current() && requestStop(true) },
        ])
      } finally {
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        if (poll !== undefined) clearTimeout(poll)
        wake?.()
        // A successful cancel also covers an already parked/ended turn. No newer turn/end is owed.
        if (current()) {
          context.stopping = false
          context.render()
        }
      }
    })
  }

  function handleQueuedAction(itemId: string, kind: 'sendNow' | 'removeQueued' | 'promote'): void {
    const session = context.current
    if (
      !session ||
      !context.connected ||
      (kind === 'sendNow' && (!context.configured || !context.selectedModelAvailable())) ||
      context.sessionPending ||
      context.stopping ||
      (kind === 'sendNow' &&
        (context.permissionChangePending ||
          context.permissionRefreshPending ||
          context.sessionYoloEnabled === undefined)) ||
      (context.queueAction?.pending &&
        context.queueAction.sessionId === session.id &&
        context.queueAction.selection === context.selection) ||
      context.projection?.sessionId !== session.id ||
      !context.projection.pendingInputs?.some((item) => item.itemId === itemId)
    )
      return
    const action = {
      sessionId: session.id,
      selection: context.selection,
      itemId,
      kind,
      pending: true,
    } as NonNullable<typeof context.queueAction>
    context.queueAction = action
    context.renderControls()
    const work = async () => {
      const held = await session.pendingCommands()
      if (
        held.some(
          (command) => (command.params as { payload?: { itemId?: string } }).payload?.itemId === itemId,
        )
      ) {
        await showCommandFeedback(context, session)
        return
      }
      return kind === 'sendNow'
        ? session.interrupt(itemId)
        : kind === 'promote'
          ? session.promoteQueued(itemId)
          : session.removeQueued(itemId)
    }
    void work()
      .then(() => {
        if (context.current === session && context.selection === action.selection) {
          context.live?.refresh()
          void refreshSessionControls(session).catch(context.showError)
        }
      })
      .catch((error: unknown) => {
        const failure = error as { data?: { code?: unknown } }
        action.error =
          failure?.data?.code === 'QUEUED_INPUT_GONE'
            ? context.t('composer.queue.gone')
            : error instanceof Error
              ? error.message
              : String(error)
        if (context.current === session && context.selection === action.selection) {
          context.live?.refresh()
          void refreshSessionControls(session).catch(context.showError)
        }
      })
      .finally(() => {
        action.pending = false
        if (context.current === session && context.selection === action.selection) context.renderControls()
      })
  }

  async function refreshSessionControls(session: Session): Promise<void> {
    const epoch = context.selection
    const request = ++context.controlsRefresh
    const history = context.controlsHistory.get(session.id) ?? { through: 0, facts: [] }
    let through = history.through
    const facts = [...history.facts]
    let value: SessionControlStateResult
    do {
      value = await session.controls({ afterSeq: through })
      if (context.current !== session || context.selection !== epoch || request !== context.controlsRefresh)
        return
      facts.push(...(value.facts ?? []))
      through = value.factsThrough ?? through
    } while (value.factsMore)
    value = { ...value, facts }
    context.controlsHistory.set(session.id, { through, facts })
    if (context.current !== session || context.selection !== epoch || request !== context.controlsRefresh)
      return
    context.sessionControls = { sessionId: session.id, value }
    for (const fact of value.facts ?? []) {
      if (fact.action !== 'cancel' || fact.outcome !== 'requested') continue
      const key = `agnes-return:${session.id}:${fact.seq}`
      if (context.recoveredReturns.has(key) || sessionStorage.getItem(key) === 'sent') continue
      const returned = (fact.details as { returned?: Array<{ content: ContentBlock[] }> })?.returned ?? []
      const blocks = returned.flatMap((item) => item.content)
      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      if (!sessionStorage.getItem(key) && text) {
        const draft = [context.composerRuntime.getDraft(), text].filter(Boolean).join('\n')
        context.composerRuntime.setDraft(draft)
        sessionStorage.setItem(context.composerDraftKey, draft)
      }
      const attachments = blocks.filter((block) => block.type === 'image' || block.type === 'file')
      if (attachments.length)
        context.composerRuntime.restoreAttachmentBlocks([
          ...context.composerRuntime.getAttachmentBlocks(),
          ...attachments,
        ])
      context.recoveredReturns.add(key)
      sessionStorage.setItem(key, 'pending')
    }
    context.render()
    await showCommandFeedback(context, session)
  }

  async function handleChildControl(id: string, action: 'stop' | 'continue', text?: string): Promise<void> {
    const session = context.current
    if (!session || context.sessionPending || !context.connected) return
    if (action === 'stop') await session.stopChild(id)
    else await session.continueChild(id, text ?? '')
    await refreshSessionControls(session)
    context.live?.refresh()
  }

  function handlePauseResume(): void {
    context.run(async () => {
      const session = context.current
      if (
        !session ||
        context.sessionPending ||
        context.controlPending ||
        context.sessionControls?.sessionId !== session.id
      )
        return
      const epoch = context.selection
      context.controlPending = true
      context.renderControls()
      try {
        await session.control(context.sessionControls.value.paused ? 'resume' : 'pause')
        await refreshSessionControls(session)
        context.live?.refresh()
      } finally {
        if (context.current === session && context.selection === epoch) {
          context.controlPending = false
          context.renderControls()
        }
      }
    })
  }

  async function handleEditQueued(itemId: string, text: string): Promise<void> {
    const session = context.current
    if (!session || context.sessionPending || !context.connected) return
    // Preserve attachments and edit the complete text, including content beyond the preview limit.
    const state = await session.controls()
    const item = state.pending.find((candidate) => candidate.itemId === itemId)
    if (!item) throw new Error(context.t('composer.queue.gone'))
    await session.editQueued(itemId, [
      { type: 'text', text },
      ...item.content.filter((block) => block.type !== 'text'),
    ])
    await refreshSessionControls(session)
    context.live?.refresh()
  }

  return {
    handleComposerCancel,
    handleQueuedAction,
    refreshSessionControls,
    handleChildControl,
    handlePauseResume,
    handleEditQueued,
  }
}
