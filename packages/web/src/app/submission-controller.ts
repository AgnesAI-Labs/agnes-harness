import {
  type ContentBlock,
  decodeSafeImages,
  MAX_FRAME_BYTES,
  modelImageInputError,
  type ReferenceCandidate,
  type ReferenceSelection,
  toAcpPrompt,
  type UINode,
  type UITurn,
  USER_MESSAGE_IMAGE_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol'
import { type Session, unresolvedSubmission } from '@agnes/sdk/browser'
import { yoloEnabled } from '@agnes/web-admin/permission-picker'
import { applicationWorkDraft, composerCommands, encodeApplicationWork } from '@agnes/web-client'
import { PlanModeRequestError, submitPlanCommand } from '@agnes/web-conversation/plan-mode'
import { canSubmitComposer } from '@agnes/web-conversation/presentation'
import type { AppSessionContext } from '../app.js'
import { showCommandFeedback } from './command-feedback.js'

export function createSubmissionController(
  context: Pick<
    AppSessionContext,
    | 'submissions'
    | 'client'
    | 'clientModules'
    | 'composerDraftKey'
    | 'composerRuntime'
    | 'configured'
    | 'connected'
    | 'current'
    | 'draftBundles'
    | 'draftLoop'
    | 'draftLoopAvailable'
    | 'draftSessionRequest'
    | 'draftingNew'
    | 'initialModelPending'
    | 'initialPermissionPending'
    | 'intentionalClose'
    | 'knownSessionModel'
    | 'live'
    | 'loopCatalogPending'
    | 'modelSelectionSeq'
    | 'notice'
    | 'open'
    | 'pendingSessionKey'
    | 'permissionChangePending'
    | 'permissionConnectionEpoch'
    | 'permissionMode'
    | 'permissionRefreshPending'
    | 'permissionSelectionSeq'
    | 'projection'
    | 'recoveredReturns'
    | 'references'
    | 'render'
    | 'renderControls'
    | 'renderer'
    | 'runtimeCatalog'
    | 'runtimeModels'
    | 'selectedModelAvailable'
    | 'selectedWorkspace'
    | 'sessionBinding'
    | 'sessionControls'
    | 'sessionPending'
    | 'sessionTitles'
    | 'sessionYoloEnabled'
    | 'settingsText'
    | 'showError'
    | 'stopping'
    | 't'
    | 'titleRefresh'
  >,
) {
  let referenceSessionPending: Promise<Session> | undefined
  let attachmentSessionOpening: Promise<string> | undefined

  function imageSubmissionFrameBytes(
    sessionId: string,
    content: readonly ContentBlock[],
    steer: boolean,
    references: readonly ReferenceSelection[] = [],
  ): number {
    const params = steer
      ? {
          clientId: 'c'.repeat(128),
          commandId: 'c'.repeat(128),
          kind: 'steer',
          payload: { sessionId, content, ...(references.length ? { references } : {}) },
        }
      : {
          sessionId,
          prompt: toAcpPrompt(content),
          ...(references.length ? { _meta: { 'ai.agnes.harness': { references } } } : {}),
        }
    return new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER,
        method: steer ? '_agnes/v1/submit' : 'session/prompt',
        params,
      }),
    ).byteLength
  }

  function isPlanCommand(input: string): boolean {
    return /^\/plan(?:\s|$)/.test(input)
  }

  /** The draft's preset and permission level, as `session.new` takes them. */
  function draftRequest() {
    const request = context.draftSessionRequest()
    if (!request) throw new Error(context.settingsText('notAllowed'))
    return request
  }

  async function prepareComposerSession(): Promise<Session> {
    if (context.current) return context.current
    if (referenceSessionPending) return referenceSessionPending
    if (!context.draftingNew || !context.selectedWorkspace?.available || context.sessionPending)
      throw new Error(context.t('app.session.createFailed'))
    const epoch = context.sessionBinding.capture()
    context.sessionPending = true
    context.renderControls()
    referenceSessionPending = (async () => {
      const key = context.pendingSessionKey ?? crypto.randomUUID()
      const draftModel = context.knownSessionModel
      const workspace = context.selectedWorkspace
      context.pendingSessionKey = key
      if (!context.draftLoopAvailable() || context.loopCatalogPending)
        throw new Error(context.t('composer.loop.unavailable'))
      if (
        context.draftBundles.some(
          (id) => !context.runtimeCatalog?.bundles?.some((bundle) => bundle.id === id),
        )
      )
        throw new Error(context.settingsText('bundleUnavailable'))
      const created = await context.client.session.new({
        cwd: workspace?.path ?? '',
        sessionKey: key,
        ...(context.draftLoop ? { loop: context.draftLoop } : {}),
        ...draftRequest(),
        ...(context.draftBundles.length ? { bundles: context.draftBundles } : {}),
      })
      if (!context.sessionBinding.isCurrent(epoch)) throw new Error(context.t('app.session.selectionChanged'))
      const opening = context.open(created.id, {
        created,
        preserveSending: true,
        ...(workspace ? { workspace } : {}),
        ...(draftModel ? { initialModel: draftModel } : {}),
      })
      const openedBinding = context.sessionBinding.capture()
      await opening
      if (!context.sessionBinding.isCurrent(openedBinding, created))
        throw new Error(context.t('app.session.selectionChanged'))
      if (!context.current) throw new Error(context.t('app.session.createFailed'))
      return context.current
    })()
    try {
      return await referenceSessionPending
    } finally {
      referenceSessionPending = undefined
      if (context.sessionBinding.isCurrent(epoch)) {
        context.sessionPending = false
        context.renderControls()
      }
    }
  }

  /**
   * While the agent runs, a message queues as a follow-up: it is sent as the next message once the
   * turn ends. `steer` (⌘/Ctrl+Enter) sends it as guidance instead, joining when the current step ends.
   */
  function submitComposer(options: { steer?: boolean } = {}): void {
    if (context.sessionPending || !context.connected) return
    const originalDraft = context.composerRuntime.getDraft()
    const selectedReferences = context.references.getSnapshot()
    const referenceSelections = selectedReferences.map(({ source, id }) => ({ source, id }))
    const input = originalDraft.trim()
    if (!selectedReferences.length && context.composerRuntime.getAttachmentBlocks().length === 0) {
      for (const command of composerCommands.entries()) {
        const route = command.route({
          text: input,
          ...(context.current ? { sessionId: context.current.id } : {}),
          busy: !!context.projection?.opState,
        })
        if (!route) continue
        context.composerRuntime.setDraft('')
        sessionStorage.removeItem(context.composerDraftKey)
        if (route === 'steer' && context.current) void context.current.steer(input).catch(context.showError)
        return
      }
    }
    if (!selectedReferences.length && isPlanCommand(input)) {
      const cwd = context.selectedWorkspace?.path
      if (!cwd) {
        context.showError(new Error(context.t('app.plan.noWorkspace')))
        return
      }
      context.composerRuntime.setDraft('')
      sessionStorage.removeItem(context.composerDraftKey)
      void prepareComposerSession()
        .then((session) => submitPlanCommand(cwd, input, fetch, session.id))
        .then((result) => {
          context.notice.setText(result.text)
          context.notice.setKind('')
        })
        .catch((error: unknown) => {
          context.showError(
            error instanceof PlanModeRequestError ? new Error(context.t('app.plan.failed')) : error,
          )
        })
      return
    }
    const attachments = context.composerRuntime.getAttachmentBlocks()
    const images = attachments.filter((block) => block.type === 'image')
    const session = context.current
    if (
      (!input && attachments.length === 0 && selectedReferences.length === 0) ||
      context.composerRuntime.hasPendingImages() ||
      !context.configured ||
      !context.selectedModelAvailable() ||
      context.permissionChangePending ||
      context.permissionRefreshPending ||
      (session && context.sessionYoloEnabled === undefined) ||
      (!session && (!context.draftingNew || !context.selectedWorkspace?.available)) ||
      (!session && !context.draftSessionRequest()) ||
      !canSubmitComposer({
        connected: context.connected,
        hasSession: true,
        sending: context.submissions.sending,
        stopping: context.stopping,
        loading: context.sessionPending,
      })
    )
      return
    const selectedRecord = context.runtimeModels.find(
      (model) =>
        model.route === context.knownSessionModel?.route && model.id === context.knownSessionModel?.id,
    )
    try {
      validateUserAttachments(attachments)
      decodeSafeImages(images, USER_MESSAGE_IMAGE_LIMITS)
    } catch (error) {
      context.showError(error)
      return
    }
    const imageError = modelImageInputError(selectedRecord, [{ content: images }])
    if (imageError) {
      context.showError(new Error(imageError))
      return
    }
    const text = input || referenceSelections.map(({ source, id }) => `@${source} ${id}`).join('\n')
    const sentText = encodeApplicationWork(text, applicationWorkDraft.read(session?.id))
    const content: ContentBlock[] = [
      ...(sentText ? [{ type: 'text' as const, text: sentText }] : []),
      ...attachments,
    ]
    submitBlocks(content, referenceSelections, {
      ...(options.steer ? { steer: true } : {}),
      composer: { draft: originalDraft, attachments, references: selectedReferences },
    })
  }

  /**
   * The one send path. The composer and a retry of a failed turn enter here after their own
   * admission checks; everything from the content onward is shared, so a retry cannot take a
   * shortcut past the connection, permission or session guards.
   */
  function submitBlocks(
    content: ContentBlock[],
    referenceSelections: readonly ReferenceSelection[],
    options: {
      steer?: boolean
      /** Composer sends own the draft and attachments; a retry leaves them alone. */
      composer?: {
        draft: string
        attachments: ReturnType<typeof context.composerRuntime.getAttachmentBlocks>
        references: readonly ReferenceCandidate[]
      }
    } = {},
  ): Promise<void> | undefined {
    const composer = options.composer
    // Composer sends pass the attachment blocks they already validated; a retry derives them from
    // the stored content so the same frame-size guard applies to both paths.
    const attachments = composer?.attachments ?? content.filter((block) => block.type !== 'text')
    const busy = context.projection?.opState !== null && context.projection?.opState !== undefined
    let session = context.current
    if (
      attachments.length > 0 &&
      imageSubmissionFrameBytes(session?.id ?? 's'.repeat(512), content, busy, referenceSelections) >
        MAX_FRAME_BYTES
    ) {
      context.showError(new Error(context.t('app.error.messageTooLarge')))
      return
    }
    const steer = busy && options.steer === true
    if (
      busy &&
      (context.sessionControls?.sessionId !== session?.id ||
        (steer && !context.sessionControls?.value.controls.steer))
    )
      return
    context.notice.setText('')
    context.notice.setKind('')
    const submittedReturns = [...context.recoveredReturns].filter((key) =>
      key.startsWith(`agnes-return:${session?.id}:`),
    )
    const submission = context.submissions.beginComposer(!busy)
    if (!submission) return
    const connectionEpoch = context.permissionConnectionEpoch
    if (composer) {
      context.composerRuntime.setDraft('')
      context.composerRuntime.clearImageBlocks()
      context.references.clear()
      sessionStorage.removeItem(context.composerDraftKey)
    }
    context.renderer.pinToBottom()
    context.renderControls()
    // A prompt can remain pending for the entire run. Controls follow daemon state, not this promise.
    const work = submission.run(async () => {
      if (!session) {
        session = await prepareComposerSession()
      }
      if (!session) throw new Error(context.t('app.session.createFailed'))
      if (context.initialModelPending) {
        const selectedModel = context.initialModelPending
        const applied = await session.setModel({
          slot: 'primary',
          route: selectedModel.route,
          model: selectedModel.id,
          thinking: selectedModel.settings?.thinking ?? null,
          contextWindow: selectedModel.settings?.contextWindow ?? null,
        })
        if (!context.submissions.isCurrent(submission, session))
          throw new Error(context.t('app.error.sessionChanged'))
        context.modelSelectionSeq = applied.effectiveFromSeq
        context.knownSessionModel = selectedModel
        context.initialModelPending = undefined
        context.renderControls()
      }
      if (
        !context.connected ||
        connectionEpoch !== context.permissionConnectionEpoch ||
        context.permissionRefreshPending
      )
        throw new Error(context.t('app.error.connectionChanged'))
      if (context.initialPermissionPending !== undefined) {
        const selectedPermission = context.initialPermissionPending
        const enabled = yoloEnabled(selectedPermission)
        const applied = await session.setYolo(enabled)
        if (!context.submissions.isCurrent(submission, session))
          throw new Error(context.t('app.error.sessionChanged'))
        if (connectionEpoch !== context.permissionConnectionEpoch)
          throw new Error(context.t('app.error.connectionChanged'))
        context.permissionSelectionSeq = applied.effectiveFromSeq
        context.sessionYoloEnabled = enabled
        context.permissionMode = selectedPermission
        context.initialPermissionPending = undefined
      }
      if (
        !context.connected ||
        connectionEpoch !== context.permissionConnectionEpoch ||
        context.permissionRefreshPending
      )
        throw new Error(context.t('app.error.connectionChanged'))
      if (!context.submissions.isCurrent(submission, session))
        throw new Error(context.t('app.error.sessionChanged'))
      if (context.sessionYoloEnabled === undefined) throw new Error(context.t('app.error.permissionRequired'))
      if ((await session.pendingCommands()).length) {
        throw new Error(context.t('app.command.unconfirmed'))
      }
      if (!context.submissions.isCurrent(submission, session))
        throw new Error(context.t('app.error.sessionChanged'))
      const result = await (busy
        ? steer
          ? session.steer(content, { references: referenceSelections })
          : session.followUp(content, { references: referenceSelections })
        : session.prompt(content, {
            references: referenceSelections,
            titleLocale: context.clientModules.locale.getSnapshot() === 'zh-CN' ? 'zh-CN' : 'en',
          }))
      const submittedId = session.id
      if (
        typeof result === 'object' &&
        result.reason === 'completed' &&
        !context.sessionTitles.has(submittedId)
      )
        context.titleRefresh.start(submittedId)
      for (const key of submittedReturns) sessionStorage.setItem(key, 'sent')
      context.pendingSessionKey = undefined
      if (busy && context.submissions.isCurrent(submission)) context.live?.refresh()
    })
    return work
      .catch(async (error: unknown) => {
        if (context.submissions.isCurrent(submission)) {
          if (connectionEpoch !== context.permissionConnectionEpoch) {
            context.initialPermissionPending = undefined
            context.sessionYoloEnabled = undefined
            context.render()
          }
          // Closing the connection on purpose (page unload, manual disconnect) rejects a prompt the daemon
          // already accepted. That is not a failed send, so the sent text must not come back as a draft.
          if (composer && !context.intentionalClose && !unresolvedSubmission(error)) {
            const laterDraft = context.composerRuntime.getDraft()
            if (composer.draft) {
              const restoredDraft = laterDraft ? `${composer.draft}\n${laterDraft}` : composer.draft
              context.composerRuntime.setDraft(restoredDraft)
              sessionStorage.setItem(context.composerDraftKey, restoredDraft)
            }
            if (
              !context.composerRuntime.getAttachmentBlocks().length &&
              !context.composerRuntime.hasPendingImages()
            )
              context.composerRuntime.restoreAttachmentBlocks(composer.attachments)
            context.references.restore([...composer.references, ...context.references.getSnapshot()])
          }
          if (!unresolvedSubmission(error)) context.showError(error)
          if (session) await showCommandFeedback(context, session).catch(context.showError)
        }
      })
      .finally(() => {
        if (context.submissions.isCurrent(submission)) {
          context.renderControls()
          context.live?.refresh()
        }
      })
  }

  /**
   * Send a failed turn again with the input that started it. The content is that turn's last
   * principal user node, so the retry carries the same text and attachments as the original send.
   */
  function retryTurn(turn: UITurn): Promise<void> | undefined {
    if (!context.current || context.sessionPending || !context.connected) return
    if (
      !context.configured ||
      !context.selectedModelAvailable() ||
      context.permissionChangePending ||
      context.permissionRefreshPending ||
      context.sessionYoloEnabled === undefined ||
      !canSubmitComposer({
        connected: context.connected,
        hasSession: true,
        sending: context.submissions.sending,
        stopping: context.stopping,
        loading: context.sessionPending,
      })
    )
      return
    const content = retryContent(turn)
    if (!content) return
    return submitBlocks(content, [], {})
  }

  function retryContent(turn: UITurn): ContentBlock[] | undefined {
    const nodes = context.projection?.nodes ?? []
    const principal = (node: UINode): node is Extract<UINode, { kind: 'user' }> =>
      node.kind === 'user' && node.origin !== 'system'
    const own = nodes.filter((node) => turn.nodeIds.includes(node.id)).filter(principal)
    const node =
      own.at(-1) ??
      nodes
        .filter((candidate) => (candidate.seq ?? 0) <= (turn.endSeq ?? turn.startSeq))
        .filter(principal)
        .at(-1)
    return node?.content.length ? node.content : undefined
  }

  async function prepareAttachmentSession(): Promise<string> {
    if (context.current) return context.current.id
    if (attachmentSessionOpening) return attachmentSessionOpening
    attachmentSessionOpening = (async () => {
      if (
        !context.draftingNew ||
        !context.selectedWorkspace?.available ||
        !context.draftLoopAvailable() ||
        context.loopCatalogPending
      )
        throw new Error(context.t('app.session.createFailed'))
      const workspace = context.selectedWorkspace
      const model = context.knownSessionModel
      const epoch = context.sessionBinding.capture()
      const key = context.pendingSessionKey ?? crypto.randomUUID()
      context.pendingSessionKey = key
      if (
        context.draftBundles.some(
          (id) => !context.runtimeCatalog?.bundles?.some((bundle) => bundle.id === id),
        )
      )
        throw new Error(context.settingsText('bundleUnavailable'))
      const created = await context.client.session.new({
        cwd: workspace.path,
        sessionKey: key,
        ...(context.draftLoop ? { loop: context.draftLoop } : {}),
        ...draftRequest(),
        ...(context.draftBundles.length ? { bundles: context.draftBundles } : {}),
      })
      if (!context.sessionBinding.isCurrent(epoch) || !context.draftingNew)
        throw new Error(context.t('app.session.selectionChanged'))
      const opening = context.open(created.id, {
        created,
        preserveSending: true,
        workspace,
        // Opening a session for an upload clears the composer; carry the text the user already
        // typed into the new draft session instead of dropping it.
        carryDraft: true,
        ...(model ? { initialModel: model } : {}),
      })
      const openedBinding = context.sessionBinding.capture()
      await opening
      if (!context.sessionBinding.isCurrent(openedBinding, created))
        throw new Error(context.t('app.session.selectionChanged'))
      return created.id
    })().finally(() => {
      attachmentSessionOpening = undefined
    })
    return attachmentSessionOpening
  }

  return {
    imageSubmissionFrameBytes,
    isPlanCommand,
    prepareComposerSession,
    retryTurn,
    submitComposer,
    prepareAttachmentSession,
  }
}
