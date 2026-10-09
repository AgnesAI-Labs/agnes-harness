import {
  type ContentBlock,
  decodeSafeImages,
  MAX_FRAME_BYTES,
  modelImageInputError,
  type ReferenceSelection,
  toAcpPrompt,
  USER_MESSAGE_IMAGE_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol'
import type { Session } from '@agnes/sdk/browser'
import { yoloEnabled } from '@agnes/web-admin/permission-picker'
import { permissionForSessionPreset } from '@agnes/web-admin/settings/session-choice'
import { PlanModeRequestError, submitPlanCommand } from '@agnes/web-conversation/plan-mode'
import { canSubmitComposer } from '@agnes/web-conversation/presentation'
import type { AppSessionContext } from '../app.js'

export function createSubmissionController(
  context: Pick<
    AppSessionContext,
    | 'attachmentSessionOpening'
    | 'awaitingPromptStart'
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
    | 'draftPreset'
    | 'draftingNew'
    | 'goalHost'
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
    | 'referenceSessionPending'
    | 'references'
    | 'render'
    | 'renderControls'
    | 'renderer'
    | 'runtimeCatalog'
    | 'runtimeModels'
    | 'selectedDraftPreset'
    | 'selectedModelAvailable'
    | 'selectedWorkspace'
    | 'selection'
    | 'sending'
    | 'sessionControls'
    | 'sessionPending'
    | 'sessionTitles'
    | 'sessionYoloEnabled'
    | 'settingsText'
    | 'showError'
    | 'stopping'
    | 'submissionGeneration'
    | 't'
    | 'titleRefresh'
  >,
) {
  function imageSubmissionFrameBytes(
    sessionId: string,
    content: ContentBlock[],
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

  async function prepareComposerSession(): Promise<Session> {
    if (context.current) return context.current
    if (context.referenceSessionPending) return context.referenceSessionPending
    if (!context.draftingNew || !context.selectedWorkspace?.available || context.sessionPending)
      throw new Error(context.t('app.session.createFailed'))
    const epoch = context.selection
    context.sessionPending = true
    context.renderControls()
    context.referenceSessionPending = (async () => {
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
        ...(context.draftPreset ? { preset: context.draftPreset } : {}),
        ...(context.draftBundles.length ? { bundles: context.draftBundles } : {}),
      })
      if (context.selection !== epoch) throw new Error(context.t('app.session.selectionChanged'))
      await context.open(created.id, {
        created,
        preserveSending: true,
        ...(workspace ? { workspace } : {}),
        ...(draftModel ? { initialModel: draftModel } : {}),
      })
      if (context.current !== created) throw new Error(context.t('app.session.selectionChanged'))
      if (!context.current) throw new Error(context.t('app.session.createFailed'))
      return context.current
    })()
    try {
      return await context.referenceSessionPending
    } finally {
      context.referenceSessionPending = undefined
      if (context.selection === epoch) {
        context.sessionPending = false
        context.renderControls()
      }
    }
  }

  function submitComposer(): void {
    const originalDraft = context.composerRuntime.getDraft()
    const selectedReferences = context.references.getSnapshot()
    const referenceSelections = selectedReferences.map(({ source, id }) => ({ source, id }))
    const input = originalDraft.trim()
    if (
      !selectedReferences.length &&
      /^\/goal(?:\s+show)?$/.test(input) &&
      context.composerRuntime.getAttachmentBlocks().length === 0
    ) {
      context.composerRuntime.setDraft('')
      sessionStorage.removeItem(context.composerDraftKey)
      context.composerRuntime.resize()
      const toggle = context.goalHost.querySelector<HTMLButtonElement>('[data-testid="goal-toggle"]')
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
      toggle?.focus()
      return
    }
    if (
      !selectedReferences.length &&
      /^\/goal(?:\s|$)/.test(input) &&
      context.current &&
      context.projection?.opState
    ) {
      context.composerRuntime.setDraft('')
      sessionStorage.removeItem(context.composerDraftKey)
      void context.current.steer(input).catch(context.showError)
      return
    }
    if (!selectedReferences.length && isPlanCommand(input)) {
      const cwd = context.selectedWorkspace?.path
      if (!cwd) {
        context.showError(new Error(context.t('app.plan.noWorkspace')))
        return
      }
      context.composerRuntime.setDraft('')
      sessionStorage.removeItem(context.composerDraftKey)
      context.composerRuntime.resize()
      void submitPlanCommand(cwd, input)
        .then((result) => {
          context.notice.textContent = result.text
          context.notice.dataset.kind = ''
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
    let session = context.current
    if (
      (!input && attachments.length === 0 && selectedReferences.length === 0) ||
      context.composerRuntime.hasPendingImages() ||
      !context.configured ||
      !context.selectedModelAvailable() ||
      context.permissionChangePending ||
      context.permissionRefreshPending ||
      (session && context.sessionYoloEnabled === undefined) ||
      (!session && (!context.draftingNew || !context.selectedWorkspace?.available)) ||
      (!session &&
        context.permissionMode === 'view' &&
        permissionForSessionPreset(context.selectedDraftPreset(), context.runtimeCatalog) !== 'view') ||
      !canSubmitComposer({
        connected: context.connected,
        hasSession: true,
        sending: context.sending,
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
    const content: ContentBlock[] = [...(text ? [{ type: 'text' as const, text }] : []), ...attachments]
    const busy = context.projection?.opState !== null && context.projection?.opState !== undefined
    if (
      attachments.length > 0 &&
      imageSubmissionFrameBytes(session?.id ?? 's'.repeat(512), content, busy, referenceSelections) >
        MAX_FRAME_BYTES
    ) {
      context.showError(new Error(context.t('app.error.messageTooLarge')))
      return
    }
    if (
      busy &&
      (context.sessionControls?.sessionId !== session?.id || !context.sessionControls?.value.controls.steer)
    )
      return
    context.notice.textContent = ''
    context.notice.dataset.kind = ''
    const submittedReturns = [...context.recoveredReturns].filter((key) =>
      key.startsWith(`agnes-return:${session?.id}:`),
    )
    const submission = ++context.submissionGeneration
    const connectionEpoch = context.permissionConnectionEpoch
    let ownedSelection = context.selection
    context.sending = true
    context.awaitingPromptStart = !busy
    context.composerRuntime.setDraft('')
    context.composerRuntime.clearImageBlocks()
    context.references.clear()
    sessionStorage.removeItem(context.composerDraftKey)
    context.composerRuntime.resize()
    context.renderer.pinToBottom()
    context.renderControls()
    // A prompt can remain pending for the entire run. Controls follow daemon state, not this promise.
    const work = (async () => {
      if (!session) {
        try {
          session = await prepareComposerSession()
        } finally {
          ownedSelection = context.selection
        }
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
        if (context.current !== session || context.selection !== ownedSelection)
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
        if (context.current !== session || context.selection !== ownedSelection)
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
      if (context.current !== session || context.selection !== ownedSelection)
        throw new Error(context.t('app.error.sessionChanged'))
      if (context.sessionYoloEnabled === undefined) throw new Error(context.t('app.error.permissionRequired'))
      const result = await (busy
        ? session.steer(content, { references: referenceSelections })
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
      if (busy && context.current === session && context.selection === ownedSelection) context.live?.refresh()
    })()
    void work
      .catch((error: unknown) => {
        if (submission === context.submissionGeneration && ownedSelection === context.selection) {
          if (connectionEpoch !== context.permissionConnectionEpoch) {
            context.initialPermissionPending = undefined
            context.sessionYoloEnabled = undefined
            context.render()
          }
          // Closing the connection on purpose (page unload, manual disconnect) rejects a prompt the daemon
          // already accepted. That is not a failed send, so the sent text must not come back as a draft.
          if (!context.intentionalClose) {
            const laterDraft = context.composerRuntime.getDraft()
            if (originalDraft) {
              const restoredDraft = laterDraft ? `${originalDraft}\n${laterDraft}` : originalDraft
              context.composerRuntime.setDraft(restoredDraft)
              sessionStorage.setItem(context.composerDraftKey, restoredDraft)
            }
            if (
              !context.composerRuntime.getAttachmentBlocks().length &&
              !context.composerRuntime.hasPendingImages()
            )
              context.composerRuntime.restoreAttachmentBlocks(attachments)
            context.references.restore([...selectedReferences, ...context.references.getSnapshot()])
            context.composerRuntime.resize()
          }
          context.showError(error)
        }
      })
      .finally(() => {
        if (submission === context.submissionGeneration && ownedSelection === context.selection) {
          context.sending = false
          context.awaitingPromptStart = false
          context.renderControls()
          context.live?.refresh()
        }
      })
  }

  async function prepareAttachmentSession(): Promise<string> {
    if (context.current) return context.current.id
    if (context.attachmentSessionOpening) return context.attachmentSessionOpening
    context.attachmentSessionOpening = (async () => {
      if (
        !context.draftingNew ||
        !context.selectedWorkspace?.available ||
        !context.draftLoopAvailable() ||
        context.loopCatalogPending
      )
        throw new Error(context.t('app.session.createFailed'))
      const workspace = context.selectedWorkspace
      const model = context.knownSessionModel
      const epoch = context.selection
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
        ...(context.draftPreset ? { preset: context.draftPreset } : {}),
        ...(context.draftBundles.length ? { bundles: context.draftBundles } : {}),
      })
      if (epoch !== context.selection || !context.draftingNew)
        throw new Error(context.t('app.session.selectionChanged'))
      await context.open(created.id, { created, workspace, ...(model ? { initialModel: model } : {}) })
      if (context.current !== created) throw new Error(context.t('app.session.selectionChanged'))
      return created.id
    })().finally(() => {
      context.attachmentSessionOpening = undefined
    })
    return context.attachmentSessionOpening
  }

  return {
    imageSubmissionFrameBytes,
    isPlanCommand,
    prepareComposerSession,
    submitComposer,
    prepareAttachmentSession,
  }
}
