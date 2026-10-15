import { defaultLoop, userImagePolicy } from '@agnes/protocol'
import { sessionLoopSelection } from '@agnes/web-admin/admin/plugins/session-loop'
import { choiceName } from '@agnes/web-admin/settings/choices'
import { effectiveSessionPreset, permissionForSessionPreset } from '@agnes/web-admin/settings/session-choice'
import type { ComposerView } from '@agnes/web-conversation/composer'
import { renderGoalCard } from '@agnes/web-conversation/goal-card'
import {
  composerActionPresentation,
  composerHintPresentation,
  modelSelectAccessibleName,
  modelSelectLabel,
  shouldShowEmptyState,
} from '@agnes/web-conversation/presentation'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { shortcutLabel, trackPageRequest } from '@agnes/web-ui'
import type { AppSessionContext } from '../app.js'
import { rememberWebComposer } from '../composer-memory.js'
import { loopIdentity, updateLoopPicker } from '../loop-picker.js'
import { webView } from '../view.js'
import { renderWorkbench, unmountWorkbench } from '../workbench/dock.js'

/** Ends the progress of the session being opened, while one is. */
let endSessionRead: (() => void) | undefined

export function createComposerController(
  context: Pick<
    AppSessionContext,
    | 'beginNewDraft'
    | 'clientModules'
    | 'composerDraftKey'
    | 'composerRuntime'
    | 'configured'
    | 'connected'
    | 'controlPending'
    | 'conversationRuntime'
    | 'current'
    | 'dockControlsHost'
    | 'draftBundles'
    | 'draftLoop'
    | 'draftLoopAvailable'
    | 'draftLoopEdited'
    | 'draftPreset'
    | 'draftingNew'
    | 'goalHost'
    | 'knownSessionModel'
    | 'loopCatalogError'
    | 'loopCatalogPending'
    | 'modelChangePending'
    | 'modelDefaults'
    | 'newSessionCatalog'
    | 'notice'
    | 'openNewSessionDialog'
    | 'pendingSessionKey'
    | 'permissionChangePending'
    | 'permissionMode'
    | 'permissionRefreshPending'
    | 'projection'
    | 'readOnly'
    | 'queueAction'
    | 'recoveryDisabled'
    | 'references'
    | 'renderNewSessionControls'
    | 'run'
    | 'runtimeCatalog'
    | 'runtimeModels'
    | 'selectedDraftPreset'
    | 'selectedModelAvailable'
    | 'selectedWorkspace'
    | 'selection'
    | 'sending'
    | 'sessionControls'
    | 'sessionIsolation'
    | 'sessionPending'
    | 'sessionYoloEnabled'
    | 'settingsText'
    | 'stopping'
    | 'submitComposer'
    | 'syncDraftPermission'
    | 't'
    | 'topbarRuntime'
    | 'tracePanel'
    | 'updateSidebar'
  >,
) {
  function renderControls(): void {
    const workbench: WorkbenchContext = {
      session: context.draftingNew || context.sessionPending ? undefined : context.current,
      timeline: context.draftingNew || context.sessionPending ? undefined : context.projection,
      disabled: !context.connected || context.sessionPending || context.sending || context.stopping,
      // A workbench path becomes a file chip at the caret, sent as a link to its absolute path.
      mention: (path, directory = false) => {
        const root = context.selectedWorkspace?.path
        const absolute =
          path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || !root
            ? path
            : `${root.replace(/[\\/]+$/u, '')}/${path.replace(/^\.?\//u, '')}`
        const name = absolute.split(/[\\/]/u).filter(Boolean).at(-1) ?? absolute
        context.composerRuntime.mention({ path: absolute, name, directory })
        context.composerRuntime.focus()
      },
      command: (command) => {
        context.composerRuntime.setDraft(command)
        context.submitComposer()
      },
    }
    if (context.selectedWorkspace) workbench.workspace = context.selectedWorkspace
    const dockHost = context.dockControlsHost
    if (dockHost) {
      dockHost.hidden = !workbench.session
      if (workbench.session)
        renderWorkbench(dockHost, {
          t: context.t,
          resources: context.clientModules.resources,
          session: context.clientModules.session,
          data: workbench,
          openRecord: (sessionId, callSeq, resultSeq) => {
            if (context.current?.id !== sessionId) return false
            context.tracePanel.setOpen(true)
            const selected = context.tracePanel.selectTool?.(sessionId, callSeq, resultSeq) ?? false
            document.getElementById('view-trace')?.focus()
            return selected
          },
        })
      else unmountWorkbench(dockHost)
    }
    renderGoalCard(
      context.goalHost,
      context.draftingNew ? undefined : context.projection,
      !context.connected || context.sessionPending || context.sending || context.stopping,
      (command) => {
        context.composerRuntime.setDraft(command)
        context.submitComposer()
      },
    )
    // The top bar names the Agent bound to the selected session.
    const sessionLoop = workbench.session
      ? (sessionLoopSelection(context.projection) ?? sessionLoopSelection(workbench.session))
      : undefined
    const loopEntry =
      sessionLoop &&
      context.newSessionCatalog?.loops.find((entry) => loopIdentity(entry) === loopIdentity(sessionLoop))
    context.topbarRuntime.setAgent(
      sessionLoop ? choiceName(loopEntry ?? { id: sessionLoop.id }, context.t) : undefined,
    )
    context.topbarRuntime.setSession(workbench.session?.id)
    // 切换会话加载期间的视觉态：旧画面降不透明度提示「正在准备」，新投影就绪后
    // 由 sessionPending = false 的那次 renderControls 平滑恢复。
    document.body.classList.toggle('session-switching', context.sessionPending)
    // Opening a session is a page-level read: the top progress bar runs until it is ready.
    if (context.sessionPending && !endSessionRead)
      void trackPageRequest(
        new Promise<void>((resolve) => {
          endSessionRead = resolve
        }),
      )
    else if (!context.sessionPending && endSessionRead) {
      endSessionRead()
      endSessionRead = undefined
    }
    const available = context.connected
    const busy = context.projection ? webView(context.projection, undefined, context.t).busy : false
    const images = context.composerRuntime.getAttachmentBlocks()
    const hasInput =
      context.composerRuntime.getDraft().trim().length > 0 ||
      images.length > 0 ||
      context.references.getSnapshot().length > 0
    const initialSubmissionPending = context.sending && context.pendingSessionKey !== undefined
    const action = composerActionPresentation(
      { busy, loading: context.sessionPending, sending: context.sending },
      context.t,
    )
    context.notice.disableRecovery(context.recoveryDisabled())
    const canStartDraft = context.draftingNew && context.selectedWorkspace?.available === true
    const permissionUnknown =
      context.current !== undefined &&
      (context.permissionRefreshPending || context.sessionYoloEnabled === undefined)
    // When the session's model is gone, the first model the configured accounts offer is the way on.
    const fallbackModel = context.runtimeModels[0]
    const selectedRecord = context.runtimeModels.find(
      (m) => m.route === context.knownSessionModel?.route && m.id === context.knownSessionModel?.id,
    )
    const imageUnsupported =
      images.some((block) => block.type === 'image') && !userImagePolicy(selectedRecord).supported
    const composerView: ComposerView = {
      imagePolicy: userImagePolicy(selectedRecord),
      cancel: {
        disabled:
          !context.connected ||
          !busy ||
          context.stopping ||
          context.sessionPending ||
          (context.queueAction?.sessionId === context.current?.id &&
            context.queueAction?.selection === context.selection &&
            context.queueAction.kind === 'sendNow' &&
            context.queueAction.pending),
        hidden: !busy && !context.stopping,
        label: context.stopping ? context.t('composer.cancel.stopping') : context.t('composer.cancel.stop'),
      },
      children:
        context.sessionControls?.sessionId === context.current?.id
          ? (context.sessionControls?.value.children ?? [])
          : [],
      childrenDisabled: !context.connected || context.sessionPending || context.stopping,
      controls: {
        paused:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.paused === true,
        pending: context.controlPending,
        disabled: !context.connected || !busy || context.sessionPending || context.stopping,
        pauseSupported:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.controls.pause === true,
        interruptSupported:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.controls.interrupt === true,
        reason: context.t(
          context.sessionControls?.sessionId === context.current?.id
            ? 'composer.control.unsupported'
            : 'composer.control.syncing',
        ),
      },
      connected: context.connected,
      configured: context.configured,
      hasSession: context.current !== undefined || context.draftingNew || context.readOnly !== undefined,
      hint: context.readOnly
        ? { kind: 'state', text: context.t('composer.hint.readOnly') }
        : busy && context.sessionControls?.sessionId !== context.current?.id
          ? { kind: 'state', text: context.t('composer.control.syncing') }
          : busy && !permissionUnknown
            ? // When queued messages arrive is said by the queue tray, not by a line under the input.
              { kind: 'state', text: '' }
            : permissionUnknown
              ? {
                  kind: 'state',
                  text: context.permissionRefreshPending
                    ? context.t('composer.hint.permissionSyncing')
                    : context.t('composer.hint.permissionRequired'),
                }
              : context.knownSessionModel && !context.selectedModelAvailable()
                ? fallbackModel
                  ? {
                      kind: 'state',
                      text: context.t('composer.hint.modelGone'),
                      action: {
                        label: context.t('composer.hint.useModel', {
                          model: fallbackModel.label
                            ? `${fallbackModel.label} · ${fallbackModel.id}`
                            : fallbackModel.id,
                        }),
                        model: fallbackModel,
                      },
                    }
                  : { kind: 'state', text: context.t('composer.hint.modelUnavailable') }
                : imageUnsupported
                  ? { kind: 'state', text: context.t('composer.hint.imageUnsupported') }
                  : composerHintPresentation(
                      {
                        connected: context.connected,
                        configured: context.configured,
                        hasSession: context.current !== undefined || context.draftingNew,
                        busy,
                        stopping: context.stopping,
                        loading: context.sessionPending,
                      },
                      context.t,
                    ),
      input: {
        exampleHint: context.draftingNew && !context.readOnly,
        disabled:
          !available ||
          (!context.current && !context.draftingNew) ||
          context.stopping ||
          context.sessionPending ||
          initialSubmissionPending,
        // The slash hint is a promise that typing "/" offers something: only with a command registered.
        placeholder: busy
          ? context.sessionControls?.sessionId === context.current?.id &&
            context.sessionControls?.value.paused === true
            ? context.t('composer.placeholder.paused')
            : context.t('composer.placeholder.busy', { shortcut: shortcutLabel(['mod', 'enter']) })
          : context.t(
              !context.draftingNew && context.clientModules.commands.list().length
                ? 'composer.placeholder.idle'
                : 'composer.placeholder.idleNoCommands',
            ),
      },
      loading: context.sessionPending,
      model: {
        auxiliaryAvailable: !!context.current,
        accessibleName: modelSelectAccessibleName(context.knownSessionModel, context.t),
        disabled:
          !available ||
          (!context.current && !context.draftingNew) ||
          busy ||
          context.sessionPending ||
          initialSubmissionPending ||
          !context.runtimeModels.length,
        label: modelSelectLabel(context.knownSessionModel, context.t),
        options: context.runtimeModels,
        pending: context.modelChangePending,
        ...(context.knownSessionModel ? { selected: context.knownSessionModel } : {}),
      },
      ...(context.knownSessionModel && selectedRecord?.contextWindow
        ? {
            modelSettings: {
              settings:
                context.knownSessionModel.settings ??
                context.modelDefaults(context.knownSessionModel).settings ??
                {},
              contextWindow: selectedRecord.contextWindow,
              thinkingLevelMap: selectedRecord.thinkingLevelMap,
            },
          }
        : {}),
      permission: {
        ...(context.connected &&
        !context.draftingNew &&
        context.sessionIsolation?.sessionId === context.current?.id &&
        context.sessionIsolation?.disabled
          ? { isolationNote: context.t('session.runtime.noOsIsolation') }
          : {}),
        disabled:
          !available ||
          (!context.current && !context.draftingNew) ||
          busy ||
          context.sessionPending ||
          initialSubmissionPending ||
          context.permissionRefreshPending,
        pending: context.permissionChangePending || context.permissionRefreshPending,
        selected: permissionUnknown ? null : context.permissionMode,
      },
      queue: {
        items:
          context.current && context.projection?.sessionId === context.current.id
            ? (context.projection.pendingInputs ?? []).map((item) => {
                const pending = context.sessionControls?.value.pending.find(
                  (candidate) => candidate.itemId === item.itemId,
                )
                return {
                  ...item,
                  ...(pending?.kind ? { kind: pending.kind } : {}),
                  editText:
                    pending?.content
                      .filter((block) => block.type === 'text')
                      .map((block) => block.text)
                      .join('\n') ?? item.preview,
                }
              })
            : [],
        interruptSupported:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.controls.interrupt === true,
        promoteSupported:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.controls.steer === true,
        reason: context.t('composer.control.unsupported'),
        removeDisabled:
          !available ||
          !context.current ||
          context.sessionPending ||
          context.stopping ||
          (context.queueAction?.sessionId === context.current?.id &&
            context.queueAction.selection === context.selection &&
            context.queueAction.pending),
        disabled:
          !available ||
          !context.configured ||
          !context.selectedModelAvailable() ||
          !context.current ||
          context.sessionPending ||
          context.stopping ||
          context.permissionChangePending ||
          permissionUnknown ||
          (context.queueAction?.sessionId === context.current?.id &&
            context.queueAction.selection === context.selection &&
            context.queueAction.pending),
        ...(context.queueAction?.sessionId === context.current?.id &&
        context.queueAction?.selection === context.selection
          ? {
              ...(context.queueAction.pending
                ? context.queueAction.kind === 'sendNow'
                  ? { sending: context.queueAction.itemId }
                  : context.queueAction.kind === 'promote'
                    ? { promoting: context.queueAction.itemId }
                    : { removing: context.queueAction.itemId }
                : {}),
              ...(context.queueAction.error ? { error: context.queueAction.error } : {}),
            }
          : {}),
      },
      sending: context.sending,
      send: {
        disabled:
          !available ||
          !context.configured ||
          !context.selectedModelAvailable() ||
          (!context.current && !canStartDraft) ||
          !hasInput ||
          // While the agent runs, Enter queues a message; that needs only this session's controls.
          (busy && context.sessionControls?.sessionId !== context.current?.id) ||
          context.composerRuntime.hasPendingImages() ||
          Boolean(imageUnsupported) ||
          context.sending ||
          context.stopping ||
          context.sessionPending ||
          context.permissionChangePending ||
          permissionUnknown,
        label: action.label,
        mode: action.mode,
        title: action.title,
      },
      stopping: context.stopping,
      usage: context.projection?.usage,
      workspace: {
        ...(context.selectedWorkspace?.path ? { root: context.selectedWorkspace.path } : {}),
        visible: !context.current || context.draftingNew,
        disabled: !available || context.sending || context.sessionPending,
        label:
          context.selectedWorkspace?.name ??
          (context.current
            ? context.t('composer.workspace.current')
            : context.t('composer.workspace.select')),
        title:
          context.selectedWorkspace?.path ??
          (context.current
            ? context.t('composer.workspace.currentTitle')
            : context.t('composer.workspace.select')),
      },
    }
    if (context.draftingNew && !context.draftLoopAvailable()) composerView.send.disabled = true
    if (
      context.draftingNew &&
      context.permissionMode === 'view' &&
      permissionForSessionPreset(context.selectedDraftPreset(), context.runtimeCatalog) !== 'view'
    )
      composerView.send.disabled = true
    if (context.draftingNew && context.loopCatalogPending) composerView.send.disabled = true
    if (
      context.draftingNew &&
      context.draftBundles.some((id) => !context.runtimeCatalog?.bundles?.some((bundle) => bundle.id === id))
    )
      composerView.send.disabled = true
    const adminLoop = context.newSessionCatalog && defaultLoop(context.newSessionCatalog.defaults)
    updateLoopPicker({
      visible: context.draftingNew,
      disabled: !context.connected || context.sending || context.sessionPending || context.loopCatalogPending,
      loops: context.newSessionCatalog?.loops ?? [],
      resolvedLoop: adminLoop ?? context.newSessionCatalog?.composition?.loop,
      loopSource: adminLoop
        ? { layer: 'admin', name: 'session-defaults' }
        : context.newSessionCatalog?.composition?.source,
      ...(context.draftLoop ? { selected: context.draftLoop } : {}),
      ...(context.loopCatalogError ? { error: context.t('composer.loop.loadFailed') } : {}),
      label: context.t('composer.loop.select'),
      inherited: context.t('composer.loop.inherited'),
      unavailable: context.t('composer.loop.unavailable'),
      onSelect(loop) {
        if (!context.draftingNew || context.sending || context.sessionPending) return
        context.draftLoop = loop
        context.draftLoopEdited = true
        renderControls()
      },
      ...(context.runtimeCatalog ? { presets: context.runtimeCatalog.presets } : {}),
      bundles: context.runtimeCatalog?.bundles ?? [],
      selectedBundles: context.draftBundles,
      bundlesLabel: context.settingsText('sessionBundles'),
      onBundles(bundles) {
        if (!context.draftingNew || context.sending || context.sessionPending) return
        context.draftBundles = bundles
        renderControls()
      },
      preset: context.draftPreset,
      inheritedPreset: effectiveSessionPreset(
        undefined,
        context.newSessionCatalog?.defaults,
        context.runtimeCatalog,
      ),
      presetLabel: context.settingsText('presets'),
      onPreset(preset) {
        context.draftPreset = preset
        context.syncDraftPermission()
        rememberWebComposer({ permission: context.permissionMode })
        renderControls()
      },
    })
    context.composerRuntime.render(composerView)
    context.updateSidebar()
    if (context.sessionPending) {
      context.topbarRuntime.setStatus(context.t('topbar.preparing'), 'loading')
    }
    context.conversationRuntime.setEmptyStateVisible(shouldShowEmptyState(context.projection))
    context.renderNewSessionControls()
  }

  function handleComposerWorkspace(): void {
    context.run(async () => {
      if (!context.draftingNew) await context.beginNewDraft()
      context.openNewSessionDialog()
    })
  }

  function handleComposerDraftChange(value: string): void {
    sessionStorage.setItem(context.composerDraftKey, value)
    renderControls()
  }

  return { renderControls, handleComposerWorkspace, handleComposerDraftChange }
}
