import { defaultLoop, userImagePolicy, type WorkspaceEntry } from '@agnes/protocol'
import { sessionLoopSelection } from '@agnes/web-admin/admin/plugins/session-loop'
import { choiceName } from '@agnes/web-admin/settings/choices'
import { effectiveApplication } from '@agnes/web-client'
import type { ComposerView } from '@agnes/web-conversation/composer'
import {
  composerActionPresentation,
  composerHintPresentation,
  modelSelectAccessibleName,
  modelSelectLabel,
  shouldShowEmptyState,
} from '@agnes/web-conversation/presentation'
import { renderSessionActions } from '@agnes/web-conversation/session-actions'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { shortcutLabel, shortenHome, trackPageRequest } from '@agnes/web-ui'
import type { AppSessionContext } from '../app.js'
import { loopIdentity, updateLoopPicker } from '../loop-picker.js'
import { defaultPermissionLevel, defaultRecipe, permissionModeOf } from '../session-permission.js'
import { webView } from '../view.js'
import { renderWorkbench, unmountWorkbench } from '../workbench/dock.js'

/** Ends the progress of the session being opened, while one is. */
let endSessionRead: (() => void) | undefined

/** The draft's workspace chip. The managed chats workspace reads as no choice: 「选择工作区」. */
export function composerWorkspaceView(input: {
  selected: WorkspaceEntry | undefined
  rows: readonly WorkspaceEntry[]
  current: boolean
  drafting: boolean
  disabled: boolean
  t: AppSessionContext['t']
}): ComposerView['workspace'] {
  const { selected, t } = input
  const choices = input.rows.filter((row) => row.kind !== 'chats')
  if (selected?.kind === 'chats')
    return {
      root: selected.path,
      visible: input.drafting,
      disabled: input.disabled,
      label: t('composer.workspace.select'),
      title: t('composer.workspace.select'),
      chats: true,
      choices,
    }
  const fallback = input.current ? 'composer.workspace.current' : 'composer.workspace.select'
  return {
    ...(selected?.path ? { root: selected.path, path: shortenHome(selected.path) } : {}),
    visible: input.drafting,
    disabled: input.disabled,
    label: selected?.name ?? t(fallback),
    title: selected?.path ?? t(input.current ? 'composer.workspace.currentTitle' : fallback),
    choices,
    clearable:
      input.drafting && !!selected && input.rows.some((row) => row.kind === 'chats' && row.available),
  }
}

export function createComposerController(
  context: Pick<
    AppSessionContext,
    | 'submissions'
    | 'beginNewDraft'
    | 'clientModules'
    | 'composerDraftKey'
    | 'composerRuntime'
    | 'configured'
    | 'connected'
    | 'conversationRuntime'
    | 'current'
    | 'dockControlsHost'
    | 'draftBundles'
    | 'draftLoop'
    | 'draftLoopAvailable'
    | 'draftLoopEdited'
    | 'draftPreset'
    | 'draftSessionRequest'
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
    | 'recoveryDisabled'
    | 'references'
    | 'renderNewSessionControls'
    | 'run'
    | 'runtimeCatalog'
    | 'runtimeModels'
    | 'selectedModelAvailable'
    | 'selectedWorkspace'
    | 'sessionControls'
    | 'sessionIsolation'
    | 'sessionPending'
    | 'sessionBinding'
    | 'sessionYoloEnabled'
    | 'settingsText'
    | 'stopping'
    | 'submitComposer'
    | 'syncDraftPermission'
    | 't'
    | 'topbarRuntime'
    | 'tracePanel'
    | 'updateSidebar'
    | 'workspaceRows'
  >,
) {
  function renderControls(): void {
    const workbench: WorkbenchContext = {
      session: context.draftingNew || context.sessionPending ? undefined : context.current,
      timeline: context.draftingNew || context.sessionPending ? undefined : context.projection,
      disabled:
        !context.connected || context.sessionPending || context.submissions.sending || context.stopping,
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
    renderSessionActions(
      context.goalHost,
      context.draftingNew ? undefined : context.projection,
      !context.connected || context.sessionPending || context.submissions.sending || context.stopping,
      (command) => {
        context.composerRuntime.setDraft(command)
        context.submitComposer()
      },
      context.t,
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
    // Dim only the previous selection, not the new readable preview awaiting execution admission.
    const displayedSession = context.current?.id ?? context.readOnly?.id
    document.body.classList.toggle(
      'session-switching',
      context.sessionPending && (!displayedSession || context.projection?.sessionId !== displayedSession),
    )
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
    const lastTurn = context.projection?.turns.at(-1)
    const busy = context.projection ? webView(context.projection, undefined, context.t).busy : false
    const images = context.composerRuntime.getAttachmentBlocks()
    const hasInput =
      context.composerRuntime.getDraft().trim().length > 0 ||
      images.length > 0 ||
      context.references.getSnapshot().length > 0
    const initialSubmissionPending = context.submissions.sending && context.pendingSessionKey !== undefined
    const action = composerActionPresentation(
      { busy, loading: context.sessionPending, sending: context.submissions.sending },
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
    const queueAction = context.submissions.queueAction
    const composerView: ComposerView = {
      imagePolicy: userImagePolicy(selectedRecord),
      cancel: {
        disabled:
          !context.connected ||
          !busy ||
          context.stopping ||
          context.sessionPending ||
          (queueAction?.kind === 'sendNow' && queueAction.pending),
        hidden: !busy && !context.stopping,
        label: context.stopping ? context.t('composer.cancel.stopping') : context.t('composer.cancel.stop'),
      },
      children:
        !effectiveApplication()?.workbench && context.sessionControls?.sessionId === context.current?.id
          ? (context.sessionControls?.value.children ?? [])
          : [],
      childrenDisabled: !context.connected || context.sessionPending || context.stopping,
      controls: {
        paused:
          context.sessionControls?.sessionId === context.current?.id &&
          context.sessionControls?.value.paused === true,
        pending: context.submissions.controlPending,
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
      readOnly: !!context.readOnly,
      hasSession: context.current !== undefined || context.draftingNew || context.readOnly !== undefined,
      hint: context.sessionPending
        ? { kind: 'state', text: context.t('composer.action.preparing') }
        : context.readOnly
          ? {
              kind: 'state',
              text: context.t('composer.hint.readOnly'),
            }
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
        ...(!context.draftingNew &&
        !context.readOnly &&
        !context.sessionPending &&
        context.current &&
        lastTurn
          ? {
              hintScope: {
                sessionId: context.current.id,
                turn: lastTurn.turn,
                completed: !busy && lastTurn.reason === 'completed',
              },
            }
          : {}),
        exampleHint: context.draftingNew && !context.readOnly,
        disabled:
          !available ||
          (!context.current &&
            !context.draftingNew &&
            !(context.sessionPending && context.sessionBinding.targetId)) ||
          context.stopping ||
          (!!context.readOnly && !context.sessionPending) ||
          initialSubmissionPending,
        // The slash hint is a promise that typing "/" offers something: only with a command registered.
        placeholder: context.readOnly
          ? context.t('composer.hint.readOnly')
          : busy
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
        // A running reply is the one temporary lock worth explaining on the trigger.
        ...(available && busy ? { disabledReason: context.t('settings.modelPicker.busy') } : {}),
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
        (context.runtimeCatalog?.security?.platform.os === 'win32' ||
          (!context.draftingNew &&
            context.sessionIsolation?.sessionId === context.current?.id &&
            context.sessionIsolation?.disabled))
          ? {
              isolationNote: context.t(
                context.runtimeCatalog?.security?.platform.os === 'win32'
                  ? 'session.runtime.platformNoCommandIsolation'
                  : 'session.runtime.noOsIsolation',
              ),
            }
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
        // Only a Host that lists permission levels says which one is the default.
        ...(context.runtimeCatalog?.permissions
          ? {
              defaultMode: permissionModeOf(
                defaultPermissionLevel(context.newSessionCatalog?.defaults, context.runtimeCatalog),
              ),
            }
          : {}),
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
          queueAction?.pending === true,
        disabled:
          !available ||
          !context.configured ||
          !context.selectedModelAvailable() ||
          !context.current ||
          context.sessionPending ||
          context.stopping ||
          context.permissionChangePending ||
          permissionUnknown ||
          queueAction?.pending === true,
        ...(queueAction
          ? {
              ...(queueAction.pending
                ? queueAction.kind === 'sendNow'
                  ? { sending: queueAction.itemId }
                  : queueAction.kind === 'promote'
                    ? { promoting: queueAction.itemId }
                    : { removing: queueAction.itemId }
                : {}),
              ...(queueAction.error ? { error: queueAction.error } : {}),
            }
          : {}),
      },
      sending: context.submissions.sending,
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
          context.submissions.sending ||
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
      workspace: composerWorkspaceView({
        selected: context.selectedWorkspace,
        rows: context.workspaceRows,
        current: Boolean(context.current),
        drafting: !context.readOnly && (!context.current || context.draftingNew),
        disabled: !available || context.submissions.sending || context.sessionPending,
        t: context.t,
      }),
    }
    if (context.draftingNew && !context.draftLoopAvailable()) composerView.send.disabled = true
    // A level the deployment refuses, or one an older Host cannot apply to the recipe, is not sent.
    if (context.draftingNew && !context.draftSessionRequest()) composerView.send.disabled = true
    if (context.draftingNew && context.loopCatalogPending) composerView.send.disabled = true
    if (
      context.draftingNew &&
      context.draftBundles.some((id) => !context.runtimeCatalog?.bundles?.some((bundle) => bundle.id === id))
    )
      composerView.send.disabled = true
    const adminLoop = context.newSessionCatalog && defaultLoop(context.newSessionCatalog.defaults)
    updateLoopPicker({
      visible: context.draftingNew,
      disabled:
        !context.connected ||
        context.submissions.sending ||
        context.sessionPending ||
        context.loopCatalogPending,
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
        if (!context.draftingNew || context.submissions.sending || context.sessionPending) return
        context.draftLoop = loop
        context.draftLoopEdited = true
        renderControls()
      },
      ...(context.runtimeCatalog ? { presets: context.runtimeCatalog.presets } : {}),
      bundles: context.runtimeCatalog?.bundles ?? [],
      selectedBundles: context.draftBundles,
      bundlesLabel: context.settingsText('sessionBundles'),
      onBundles(bundles) {
        if (!context.draftingNew || context.submissions.sending || context.sessionPending) return
        context.draftBundles = bundles
        renderControls()
      },
      preset: context.draftPreset,
      inheritedPreset: defaultRecipe(context.newSessionCatalog?.defaults, context.runtimeCatalog),
      presetLabel: context.settingsText('presets'),
      onPreset(preset) {
        // The recipe never changes the chosen permission level.
        context.draftPreset = preset
        context.syncDraftPermission()
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
    try {
      sessionStorage.setItem(context.composerDraftKey, value)
    } catch {
      // The current draft stays in the composer and is retained in memory on a switch.
    }
    renderControls()
  }

  return { renderControls, handleComposerWorkspace, handleComposerDraftChange }
}
