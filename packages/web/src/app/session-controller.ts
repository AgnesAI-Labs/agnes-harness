import { type PageSessionMeta, readSessionTitle, type UITurn, type WorkspaceEntry } from '@agnes/protocol'
import type { LedgerEvent, PermissionOutcome, Session } from '@agnes/sdk/browser'
import { createLiveProjection } from '@agnes/web-conversation/live-projection'
import type { KnownSessionModel } from '@agnes/web-conversation/presentation'
import { preserveRouteParams, reportSuccess } from '@agnes/web-ui'
import type { AppSessionContext } from '../app.js'
import { forkTitle } from '../session-actions.js'
import { bindWebSession, loadWebSession } from '../session-binding.js'
import { sessionPermissionLevel } from '../session-permission.js'
import { receiptFromTurns, recordRunEvent, webView } from '../view.js'
import { broadcast } from './global-events.js'
import type { SessionBindingOwner } from './session-owner.js'

export function createSessionController(
  context: Pick<
    AppSessionContext,
    | 'submissions'
    | 'SESSION_WATCH_STOP_TIMEOUT_MS'
    | 'approvalRuntime'
    | 'approvalSearch'
    | 'clearSessionRecovery'
    | 'client'
    | 'clientModules'
    | 'composerRuntime'
    | 'connected'
    | 'current'
    | 'draftingNew'
    | 'initialModelPending'
    | 'initialPermissionPending'
    | 'invalidateSessionRuntime'
    | 'knownSessionModel'
    | 'list'
    | 'live'
    | 'liveApproval'
    | 'modelChangePending'
    | 'modelSelectionSeq'
    | 'moduleSessionId'
    | 'notice'
    | 'permissionChangePending'
    | 'permissionMode'
    | 'permissionRefreshPending'
    | 'permissionSelectionSeq'
    | 'projection'
    | 'receipts'
    | 'references'
    | 'refreshSessionControls'
    | 'render'
    | 'renderControls'
    | 'renderer'
    | 'runtimeCatalog'
    | 'selectedWorkspace'
    | 'selectComposerDraft'
    | 'sessionBinding'
    | 'sessionControls'
    | 'sessionIsolation'
    | 'sessionPending'
    | 'sessionRows'
    | 'sessionTitles'
    | 'sessionYoloEnabled'
    | 'showError'
    | 'showSessionRecovery'
    | 'stopping'
    | 'streamFrame'
    | 't'
    | 'titleRefresh'
    | 'topbarRuntime'
    | 'transcriptMeta'
    | 'readOnlyController'
    | 'readSessionControls'
    | 'windowAtStart'
    | 'workspaceRows'
  >,
  bindingOwner: SessionBindingOwner,
) {
  async function open(
    id: string,
    options: {
      created?: Session
      preserveSending?: boolean
      /** An attachment opened this session before sending; keep the typed draft in it. */
      carryDraft?: boolean
      workspace?: WorkspaceEntry
      initialModel?: KnownSessionModel
    } = {},
  ): Promise<void> {
    const preserved = options.preserveSending ? context.submissions.currentComposer : undefined
    context.selectComposerDraft(id, {
      ...(options.preserveSending ? { preserve: true } : {}),
      ...(options.carryDraft ? { carry: true } : {}),
    })
    const { binding: epoch, previous } = bindingOwner.begin(id)
    context.approvalRuntime.render(undefined)
    // The old projection may stay visible, but its preview/refusal no longer describes this selection.
    context.readOnlyController.clear()
    preserved?.adopt(epoch)
    if (!options.created) context.references.clear()
    let selectionReady = false
    context.topbarRuntime.setStatus('', 'idle')
    context.sessionPending = true
    context.draftingNew = false
    context.renderControls()
    // Retain projection and transcript until the new projection is ready: keep the old view during loading (translucent
    // body.session-switching and Preparing session status), avoiding clear → blank → fill flicker and preventing
    // `body:has(#transcript:empty)` from switching the layout to empty-state mode.
    // If switching remounts the conversation region, show the new session preview/loading state instead of replaying old text (boot.tsx).
    context.moduleSessionId = undefined
    context.clientModules.session.setSession(undefined)
    if (!options.created) context.permissionMode = 'workspace'
    context.sessionYoloEnabled = options.created ? false : undefined
    context.permissionRefreshPending = false
    context.initialPermissionPending = options.created ? context.permissionMode : undefined
    context.permissionSelectionSeq = 0
    context.permissionChangePending = false
    context.stopping = false
    context.knownSessionModel = undefined
    context.initialModelPending = options.initialModel
    context.modelSelectionSeq = 0
    context.selectedWorkspace = undefined
    context.modelChangePending = false
    context.renderControls()
    context.liveApproval?.finish({ unanswered: 'detached' })
    context.liveApproval = undefined
    try {
      const stopped = await stopWithTimeout(previous.stop)
      if (!stopped && context.sessionBinding.isCurrent(epoch)) {
        context.notice.setText(context.t('app.notice.oldSessionClosing'))
        context.notice.setKind('warning')
      }
      await previous.session?.detach()
      if (!context.sessionBinding.isCurrent(epoch)) return
      const permission: Parameters<Session['onPermissionRequest']>[0] = (request, permissionContext) =>
        new Promise<PermissionOutcome>((resolve) => {
          const pending = {
            request,
            afterSeq: Math.max(context.projection?.upto ?? 0, context.receipts.get(id)?.endSeq ?? 0),
            finish: (answer: PermissionOutcome) => {
              permissionContext.signal.removeEventListener('abort', reject)
              if (context.liveApproval === pending) context.liveApproval = undefined
              if (context.sessionBinding.isCurrent(epoch)) context.render()
              resolve(permissionContext.signal.aborted ? { unanswered: 'detached' } : answer)
            },
          }
          const reject = () => pending.finish({ unanswered: 'detached' })
          if (
            permissionContext.signal.aborted ||
            !context.sessionBinding.isCurrent(epoch) ||
            context.permissionMode === 'view'
          ) {
            resolve({ unanswered: 'detached' })
            return
          }
          context.liveApproval = pending
          permissionContext.signal.addEventListener('abort', reject, { once: true })
          context.render()
        })
      context.clientModules.session.setReadiness('connecting', id)
      if (!options.created) void context.readOnlyController.preview(id, epoch).catch(() => undefined)
      const workspaceHint = context.sessionRows.find((row) => row.sessionId === id)?.cwd
      const binding = options.created
        ? bindWebSession(options.created, permission)
        : await loadWebSession(
            (sessionId, options) =>
              context.client.session.open(sessionId, {
                ...options,
                ...(workspaceHint ? { cwd: workspaceHint } : {}),
              }),
            id,
            permission,
            {
              signal: bindingOwner.loadingSignal(epoch),
              onProgress: (value) => context.readOnlyController.progress(value, epoch),
              onPermissionRequestRegistered: (off) => bindingOwner.loadingPermission(epoch, off),
            },
          )
      if (!bindingOwner.attach(epoch, binding)) return
      const loaded = binding.session
      // Admission establishes execution identity, but the unverified preview remains on screen
      // until the first authoritative opening commits. A late preview must not downgrade this.
      context.clientModules.session.setSession(loaded.id, 'connecting')
      // Controls need only the admitted session: read them alongside the opening, apply them after it.
      const controls = context.readSessionControls(loaded)
      controls.catch(() => undefined)
      context.sessionIsolation = undefined
      void Promise.resolve()
        .then(() => context.client.session.runtime(loaded.id))
        .then((runtime) => {
          if (!context.sessionBinding.isCurrent(epoch, loaded)) return
          const sandbox = runtime.policy?.sandbox
          if (sandbox?.provider === 'local' && sandbox.enforcement) {
            context.sessionIsolation = {
              sessionId: loaded.id,
              disabled:
                sandbox.enforcement.level !== 'full' && !sandbox.enforcement.scope.includes('process'),
            }
            context.renderControls()
          }
        })
        .catch(() => undefined)
      context.sessionControls = undefined
      context.moduleSessionId = loaded.id
      await context.clientModules.reconciler.reconcileNow()
      if (!context.sessionBinding.isCurrent(epoch)) {
        binding.offPermission?.()
        return
      }
      if (!options.created && !context.sessionRows.some((row) => row.sessionId === id)) {
        const page = await context.client.session.list({ q: { prefix: id }, limit: 100 })
        if (!context.sessionBinding.isCurrent(epoch)) return
        const row = page.items.find((item) => item.sessionId === id)
        if (row) context.sessionRows = [...context.sessionRows.filter((item) => item.sessionId !== id), row]
      }
      if (!options.created) {
        // The session's own level, before the yolo switch is known.
        const level = sessionPermissionLevel(
          context.sessionRows.find((row) => row.sessionId === id),
          context.runtimeCatalog,
        )
        context.permissionMode =
          level === 'read-only' ? 'view' : level === 'full-access' ? 'full' : 'workspace'
      }
      const metadata = context.sessionRows.find((row) => row.sessionId === id) as
        | (PageSessionMeta['items'][number] & { cwd?: string })
        | undefined
      const workspacePath = metadata?.cwd ?? options.workspace?.path
      if (workspacePath) loaded.rememberWorkspace(workspacePath)
      if (workspacePath)
        context.selectedWorkspace =
          context.workspaceRows.find((entry) => entry.path === workspacePath) ??
          (options.workspace?.path === workspacePath ? options.workspace : undefined)
      const url = new URL(location.href)
      // Launch parameters describe a draft; replaying them would replace this session on refresh.
      for (const key of ['new', 'bundle', 'preset', 'loop', 'prompt']) url.searchParams.delete(key)
      url.searchParams.set('session', id)
      const settingsHash =
        url.searchParams.has('settings') && url.hash.startsWith('#settings-subsection-') ? url.hash : ''
      url.hash = settingsHash
      history.replaceState(null, '', preserveRouteParams(url))
      let opened = false
      const selected = () => context.sessionBinding.isCurrent(epoch, loaded)
      const liveProjection = createLiveProjection(loaded, context.client, {
        timeline(value, window) {
          if (!selected()) return
          // The SDK discards projections from older connections; history cannot confirm current permissions.
          if (
            context.connected &&
            window.reason !== 'history' &&
            value.upto >= context.permissionSelectionSeq
          )
            context.permissionRefreshPending = false
          if (
            window.reason === 'opening' &&
            value.yolo === undefined &&
            context.initialPermissionPending === undefined &&
            !context.permissionChangePending &&
            value.upto >= context.permissionSelectionSeq
          )
            context.sessionYoloEnabled = undefined
          context.windowAtStart = window.startIndex === 0
          // A reopened window may reach further back; look for a parked approval again.
          if (window.reason === 'opening' && context.approvalSearch !== 'searching')
            context.approvalSearch = 'idle'
          if (!opened) {
            opened = true
            // Retire pending preview reads before installing the live projection in this same turn.
            context.readOnlyController.clearPreview()
            context.readOnlyController.verify(id, epoch)
            // Swap only after the first projection is ready: clear transcript, fill new contents, sync approvals and controls
            // in one synchronous sequence, with no blank frame between the old and new views.
            context.renderer.reset()
            context.approvalSearch = 'idle'
            // Nothing replays the history any more, so the last loaded turn stands for it.
            const seeded = receiptFromTurns(value.turns)
            if (seeded) {
              context.receipts.set(loaded.id, seeded)
              if (seeded.reason === 'completed' && !context.sessionTitles.has(loaded.id))
                context.titleRefresh.start(loaded.id)
            }
          }
          context.projection = value
          context.render()
        },
        stream(value) {
          if (!selected()) return
          context.projection = value
          // Streamed text only changes the transcript; everything else waits for the next patch.
          if (context.streamFrame !== undefined) return
          context.streamFrame = requestAnimationFrame(() => {
            context.streamFrame = undefined
            if (context.projection && selected())
              context.renderer.render(
                webView(context.projection, undefined, context.t).nodes,
                context.projection.turns,
                context.transcriptMeta(),
              )
          })
        },
        event(event) {
          if (selected())
            void followEvent(loaded, event).catch((error) => {
              if (selected()) context.showError(error)
            })
        },
        error(error) {
          if (selected()) context.showError(error)
        },
      })
      bindingOwner.watch(epoch, liveProjection)
      await liveProjection.start()
      // A read lost while the opening was out (a dropped connection) is made again, as before.
      const applyControls = await controls.catch(() => context.readSessionControls(loaded))
      // The readiness render below paints the applied controls in the same task.
      await applyControls({ render: false })
      if (!context.sessionBinding.isCurrent(epoch)) return
      selectionReady = true
      context.sessionPending = false
      context.clientModules.session.setReadiness('ready', loaded.id)
      context.clearSessionRecovery()
      context.render()
      void context
        .list(
          options.created
            ? { sessionId: loaded.id, ...(workspacePath ? { cwd: workspacePath } : {}), created: true }
            : undefined,
        )
        .catch((error: unknown) => {
          if (context.sessionBinding.isCurrent(epoch)) context.showError(error)
        })
    } catch (error) {
      if (context.sessionBinding.isCurrent(epoch)) context.clientModules.session.setReadiness('failed', id)
      if (!context.sessionBinding.isCurrent(epoch)) return
      if (!selectionReady) {
        context.readOnlyController.clear()
        const failed = bindingOwner.release(epoch)
        context.moduleSessionId = undefined
        context.clientModules.session.setSession(undefined)
        context.projection = undefined
        context.knownSessionModel = undefined
        context.modelChangePending = false
        try {
          await stopWithTimeout(failed.stop)
        } catch {
          // The original loading failure is the useful error for this selection.
        }
        try {
          await failed.session?.detach()
        } catch {
          // The failed binding is already unavailable to the composer.
        }
        if (!context.sessionBinding.isCurrent(epoch)) return
        // Loading failed with no view to retain: clear transcript to the empty state and report the error through #notice.
        context.renderer.reset()
        if (options.preserveSending) {
          context.draftingNew = true
          context.selectedWorkspace = options.workspace
          context.knownSessionModel = options.initialModel
          context.initialModelPending = undefined
        }
        context.sessionPending = false
        // A session that cannot continue here stays readable from its record.
        if (
          !options.created &&
          !options.preserveSending &&
          (await context.readOnlyController.show(id, error, epoch))
        )
          return
        if (!context.sessionBinding.isCurrent(epoch)) return
        context.render()
        if (!options.created && !options.preserveSending) {
          context.showSessionRecovery(error, id)
          return
        }
      }
      throw error
    }
  }

  async function stopWithTimeout(stop: (() => Promise<void>) | undefined): Promise<boolean> {
    if (!stop) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        stop(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(context.t('app.watch.stopTimeout'))),
            context.SESSION_WATCH_STOP_TIMEOUT_MS,
          )
        }),
      ])
      return true
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** What watching the event stream used to do per event: titles, the list, the run receipt. */
  async function followEvent(session: Session, event: LedgerEvent): Promise<void> {
    // Durable automation state is observed before this event reaches the client.
    // Reread the inbox even when this reply parks again and still needs approval.
    if (event.type === 'turn/end') broadcast('agnes:automation-invalidated')
    if (['x/core/permission-projection-invalidated', 'x/core/yolo-switch'].includes(event.type))
      context.invalidateSessionRuntime(session.id)
    const epoch = context.sessionBinding.capture()
    const showError = (error: unknown) => {
      if (context.sessionBinding.isCurrent(epoch, session)) context.showError(error)
    }
    if (['inbox', 'x/core/control', 'x/core/pause-state', 'turn/start', 'turn/end'].includes(event.type))
      void context.refreshSessionControls(session).catch(showError)
    const title = readSessionTitle(event)
    if (title?.status === 'generated') {
      // The list owns user overrides; a late automatic event cannot overwrite one.
      await context.list().catch(showError)
      context.titleRefresh.stop(session.id)
    } else if (title?.status === 'failed') context.titleRefresh.stop(session.id)
    // A new message makes this the most recently chatted session; the daemon now lists it first.
    if (
      event.type === 'user/message' ||
      event.type === 'assistant/message' ||
      (event.type === 'assistant/output' && (event.data as { state?: string }).state === 'interrupted')
    ) {
      const cwd = context.sessionRows.find((row) => row.sessionId === session.id)?.cwd
      void context.list({ sessionId: session.id, ...(cwd ? { cwd } : {}) }).catch(showError)
    }
    if (
      event.type === 'turn/end' &&
      (event.data as { reason?: string }).reason === 'completed' &&
      !context.sessionTitles.has(session.id)
    )
      context.titleRefresh.start(session.id)
    context.receipts.set(session.id, recordRunEvent(context.receipts.get(session.id), event))
  }

  async function forkTurn(turn: UITurn): Promise<void> {
    const epoch = context.sessionBinding.capture()
    const parent = context.current
    if (!parent || !turn.forkable || turn.endSeq === undefined || context.projection?.opState !== null)
      throw new Error(context.t('app.fork.notIdle'))
    const cwd =
      context.sessionRows.find((row) => row.sessionId === parent.id)?.cwd ?? context.selectedWorkspace?.path
    const forked = await context.client.session.fork(parent.id, turn.endSeq, cwd ? { cwd } : {})
    if (!context.sessionBinding.isCurrent(epoch, parent)) return
    const opening = open(forked.id, { created: forked })
    const forkBinding = context.sessionBinding.capture()
    await opening
    if (!context.sessionBinding.isCurrent(forkBinding, forked)) return
    reportSuccess('session-fork', context.t('app.fork.created'))
    context.notice.setKind('')
    context.composerRuntime.focus()
  }

  async function forkSidebar(id: string, title: string): Promise<void> {
    const epoch = context.sessionBinding.capture()
    const row = context.sessionRows.find((item) => item.sessionId === id)
    const source = await context.client.session.open(id, row?.cwd ? { cwd: row.cwd } : {})
    const timeline = await source.projectUI(undefined, { surface: 'web' })
    if (timeline.opState !== null) throw new Error(context.t('app.fork.waitIdle'))
    const turn = timeline.turns.findLast((item) => item.forkable && item.endSeq !== undefined)
    if (turn?.endSeq === undefined) throw new Error(context.t('app.fork.noForkableTurn'))
    const child = await context.client.session.fork(id, turn.endSeq, row?.cwd ? { cwd: row.cwd } : {})
    let namingError: unknown
    try {
      await context.client.session.rename(child.id, forkTitle(title))
    } catch (error) {
      namingError = error
    }
    let refreshError: unknown
    try {
      await context.list()
    } catch (error) {
      refreshError = error
    }
    try {
      if (context.sessionBinding.isCurrent(epoch)) await open(child.id, { created: child })
    } catch (error) {
      refreshError = error
    }
    if (refreshError) throw new Error(context.t('app.fork.refreshFailed', { id: child.id }))
    if (namingError) throw new Error(context.t('app.fork.renameFailed'))
  }

  return { open, stopWithTimeout, followEvent, forkTurn, forkSidebar }
}
