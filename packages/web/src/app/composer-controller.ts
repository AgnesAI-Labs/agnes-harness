import { userImagePolicy } from '@agnes/protocol'
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
import type { AppSessionContext } from '../app.js'
import { rememberWebComposer } from '../composer-memory.js'
import { updateLoopPicker } from '../loop-picker.js'
import { webView } from '../view.js'
import { renderWorkbench, unmountWorkbench } from '../workbench/dock.js'

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
      mention: (path) => {
        const reference = JSON.stringify(path)
        const draft = context.composerRuntime.getDraft()
        context.composerRuntime.setDraft(`${draft}${draft ? '\n' : ''}${reference}`)
        context.composerRuntime.focus()
      },
      command: (command) => {
        context.composerRuntime.setDraft(command)
        context.submitComposer()
      },
    }
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
    // 切换会话加载期间的视觉态：旧画面降不透明度提示「正在准备」，新投影就绪后
    // 由 sessionPending = false 的那次 renderControls 平滑恢复。
    document.body.classList.toggle('session-switching', context.sessionPending)
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
    for (const control of context.notice.querySelectorAll<HTMLButtonElement>('[data-recovery-action]'))
      control.disabled = context.recoveryDisabled()
    const canStartDraft = context.draftingNew && context.selectedWorkspace?.available === true
    const permissionUnknown =
      context.current !== undefined &&
      (context.permissionRefreshPending || context.sessionYoloEnabled === undefined)
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
      hasSession: context.current !== undefined || context.draftingNew,
      hint:
        busy && context.sessionControls?.value.controls.steer !== true
          ? {
              kind: 'state',
              text: context.t(
                context.sessionControls?.sessionId === context.current?.id
                  ? 'composer.control.unsupported'
                  : 'composer.control.syncing',
              ),
            }
          : busy && !permissionUnknown
            ? { kind: 'state', text: context.t('composer.control.steerHint') }
            : permissionUnknown
              ? {
                  kind: 'state',
                  text: context.permissionRefreshPending
                    ? context.t('composer.hint.permissionSyncing')
                    : context.t('composer.hint.permissionRequired'),
                }
              : context.knownSessionModel && !context.selectedModelAvailable()
                ? { kind: 'state', text: context.t('composer.hint.modelUnavailable') }
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
        disabled:
          !available ||
          (!context.current && !context.draftingNew) ||
          context.stopping ||
          context.sessionPending ||
          initialSubmissionPending,
        placeholder: busy ? context.t('composer.placeholder.busy') : context.t('composer.placeholder.idle'),
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
            ? (context.projection.pendingInputs ?? []).map((item) => ({
                ...item,
                editText:
                  context.sessionControls?.value.pending
                    .find((pending) => pending.itemId === item.itemId)
                    ?.content.filter((block) => block.type === 'text')
                    .map((block) => block.text)
                    .join('\n') ?? item.preview,
              }))
            : [],
        interruptSupported:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.controls.interrupt === true,
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
          (busy &&
            (context.sessionControls?.sessionId !== context.current?.id ||
              context.sessionControls?.value.controls.steer !== true)) ||
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
    updateLoopPicker({
      visible: context.draftingNew,
      disabled: !context.connected || context.sending || context.sessionPending || context.loopCatalogPending,
      loops: context.newSessionCatalog?.loops ?? [],
      resolvedLoop: context.newSessionCatalog?.defaults.loop ?? context.newSessionCatalog?.composition?.loop,
      loopSource: context.newSessionCatalog?.defaults.loop
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
    context.composerRuntime.resize()
    renderControls()
  }

  return { renderControls, handleComposerWorkspace, handleComposerDraftChange }
}
