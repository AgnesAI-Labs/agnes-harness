import type { ContentBlock } from '@agnes/protocol'
import type { SessionControlStateResult } from '@agnes/protocol/gen/agnes-v1'
import type { Session } from '@agnes/sdk/browser'
import type { AppSessionContext } from '../app.js'
import { showCommandFeedback } from './command-feedback.js'

export type ApplySessionControls = (options?: { render?: boolean }) => Promise<void>

export function createCommandController(
  context: Pick<
    AppSessionContext,
    | 'submissions'
    | 'composerDraftKey'
    | 'client'
    | 'composerRuntime'
    | 'configured'
    | 'connected'
    | 'controlsHistory'
    | 'current'
    | 'live'
    | 'notice'
    | 'permissionChangePending'
    | 'permissionRefreshPending'
    | 'projection'
    | 'recoveredReturns'
    | 'render'
    | 'renderControls'
    | 'run'
    | 'selectedModelAvailable'
    | 'sessionBinding'
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
  let controlsRefresh = 0
  function handleComposerCancel(): void {
    requestStop(false)
  }

  function requestStop(force: boolean): void {
    context.run(async () => {
      const session = context.current
      if (!session || context.sessionPending || context.stopping) return
      const epoch = context.sessionBinding.capture()
      const request = ++stopRequest
      const current = () => context.sessionBinding.isCurrent(epoch, session) && request === stopRequest
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
      context.submissions.queueAction?.pending ||
      context.projection?.sessionId !== session.id ||
      !context.projection.pendingInputs?.some((item) => item.itemId === itemId)
    )
      return
    const action = context.submissions.beginQueue({ itemId, kind })
    if (!action) return
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
    void action
      .run(async () => {
        await work()
      })
      .then(() => {
        if (context.submissions.isCurrent(action)) {
          context.live?.refresh()
          void refreshSessionControls(session).catch(context.showError)
        }
      })
      .catch((error: unknown) => {
        const failure = error as { data?: { code?: unknown } }
        action.presentError(
          failure?.data?.code === 'QUEUED_INPUT_GONE'
            ? context.t('composer.queue.gone')
            : error instanceof Error
              ? error.message
              : String(error),
        )
        if (context.submissions.isCurrent(action)) {
          context.live?.refresh()
          void refreshSessionControls(session).catch(context.showError)
        }
      })
      .finally(() => {
        if (context.submissions.isCurrent(action)) context.renderControls()
      })
  }

  async function refreshSessionControls(session: Session): Promise<void> {
    await (await readSessionControls(session))()
  }

  /**
   * Reads the controls now; the returned step applies them unless superseded in the meantime. A caller
   * that renders right after applying can leave the render to itself.
   */
  async function readSessionControls(session: Session): Promise<ApplySessionControls> {
    const epoch = context.sessionBinding.capture()
    const request = ++controlsRefresh
    const current = () => context.sessionBinding.isCurrent(epoch, session) && request === controlsRefresh
    const history = context.controlsHistory.get(session.id) ?? { through: 0, facts: [] }
    let through = history.through
    const facts = [...history.facts]
    let value: SessionControlStateResult
    do {
      value = await session.controls({ afterSeq: through })
      if (!current()) return async () => {}
      facts.push(...(value.facts ?? []))
      through = value.factsThrough ?? through
    } while (value.factsMore)
    const state = { ...value, facts }
    context.controlsHistory.set(session.id, { through, facts })
    return (options) => applySessionControls(session, state, current, options?.render ?? true)
  }

  async function applySessionControls(
    session: Session,
    value: SessionControlStateResult,
    current: () => boolean,
    render: boolean,
  ): Promise<void> {
    if (!current()) return
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
    if (render) context.render()
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
        context.submissions.controlPending ||
        context.sessionControls?.sessionId !== session.id
      )
        return
      const action = context.submissions.beginControl()
      if (!action) return
      context.renderControls()
      try {
        const kind = context.sessionControls.value.paused ? 'resume' : 'pause'
        await action.run(async () => {
          await session.control(kind)
          await refreshSessionControls(session)
          if (context.submissions.isCurrent(action)) context.live?.refresh()
        })
      } finally {
        if (context.submissions.isCurrent(action)) context.renderControls()
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
    readSessionControls,
    handleChildControl,
    handlePauseResume,
    handleEditQueued,
  }
}
