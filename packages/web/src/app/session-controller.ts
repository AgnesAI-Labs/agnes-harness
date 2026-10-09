import type { AppSessionContext } from '../app.js'
import { type PageSessionMeta, readSessionTitle, type UITurn, type WorkspaceEntry } from '@agnes/protocol'
import { type LedgerEvent, type PermissionOutcome, type Session } from '@agnes/sdk/browser'
import { createLiveProjection } from '@agnes/web-conversation/live-projection'
import { type KnownSessionModel } from '@agnes/web-conversation/presentation'
import { forkTitle } from '../session-actions.js'
import { bindWebSession, loadWebSession } from '../session-binding.js'
import { receiptFromTurns, recordRunEvent, webView } from '../view.js'

export function createSessionController(
  context: Pick<
    AppSessionContext,
    | 'SESSION_WATCH_STOP_TIMEOUT_MS'
    | 'approvalSearch'
    | 'awaitingPromptStart'
    | 'clearSessionRecovery'
    | 'client'
    | 'clientModules'
    | 'composerRuntime'
    | 'connected'
    | 'controlPending'
    | 'current'
    | 'draftingNew'
    | 'initialModelPending'
    | 'initialPermissionPending'
    | 'knownSessionModel'
    | 'list'
    | 'live'
    | 'liveApproval'
    | 'modelChangePending'
    | 'modelSelectionSeq'
    | 'moduleSessionId'
    | 'notice'
    | 'offPermission'
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
    | 'selectedWorkspace'
    | 'selection'
    | 'sending'
    | 'sessionControls'
    | 'sessionPending'
    | 'sessionRows'
    | 'sessionTitles'
    | 'sessionYoloEnabled'
    | 'showError'
    | 'showSessionRecovery'
    | 'stopEvents'
    | 'stopping'
    | 'streamFrame'
    | 'submissionGeneration'
    | 't'
    | 'titleRefresh'
    | 'transcriptMeta'
    | 'windowAtStart'
    | 'workspaceRows'
  >,
) {
  async function open(
    id: string,
    options: {
      created?: Session
      preserveSending?: boolean
      workspace?: WorkspaceEntry
      initialModel?: KnownSessionModel
    } = {},
  ): Promise<void> {
    const epoch = ++context.selection
    if (!options.created) context.references.clear()
    if (!options.preserveSending) context.submissionGeneration++
    let selectionReady = false
    context.sessionPending = true
    context.draftingNew = false
    context.renderControls()
    const previous = context.current
    // 投影与转录区都保留到新投影就绪：加载期间旧画面继续显示（body.session-switching
    // 半透明提示，状态栏「正在准备会话」），不经历「清空 → 空白 → 填充」的闪屏，
    // 也避免 `body:has(#transcript:empty)` 把布局跳进空态模式。
    context.current = undefined
    context.moduleSessionId = undefined
    context.clientModules.session.setSession(undefined)
    context.sessionYoloEnabled = options.created ? false : undefined
    context.permissionRefreshPending = false
    context.initialPermissionPending = options.created ? context.permissionMode : undefined
    context.permissionSelectionSeq = 0
    context.permissionChangePending = false
    context.stopping = false
    if (!options.preserveSending) {
      context.sending = false
      context.awaitingPromptStart = false
    }
    context.knownSessionModel = undefined
    context.initialModelPending = options.initialModel
    context.modelSelectionSeq = 0
    context.selectedWorkspace = undefined
    context.modelChangePending = false
    context.renderControls()
    context.offPermission?.()
    context.offPermission = undefined
    context.liveApproval?.finish({ verdict: 'rejected' })
    context.liveApproval = undefined
    try {
      const stopped = await stopWithTimeout(context.stopEvents)
      context.stopEvents = undefined
      context.live = undefined
      if (!stopped) {
        context.notice.textContent = context.t('app.notice.oldSessionClosing')
        context.notice.dataset.kind = 'warning'
      }
      await previous?.detach()
      if (epoch !== context.selection) return
      const permission: Parameters<Session['onPermissionRequest']>[0] = (request, permissionContext) =>
        new Promise<PermissionOutcome>((resolve) => {
          const pending = {
            request,
            afterSeq: Math.max(context.projection?.upto ?? 0, context.receipts.get(id)?.endSeq ?? 0),
            finish: (answer: PermissionOutcome) => {
              permissionContext.signal.removeEventListener('abort', reject)
              if (context.liveApproval === pending) context.liveApproval = undefined
              context.render()
              resolve(permissionContext.signal.aborted ? { verdict: 'rejected' } : answer)
            },
          }
          const reject = () => pending.finish({ verdict: 'rejected' })
          if (
            permissionContext.signal.aborted ||
            epoch !== context.selection ||
            context.permissionMode === 'view'
          ) {
            resolve({ verdict: 'rejected' })
            return
          }
          context.liveApproval = pending
          permissionContext.signal.addEventListener('abort', reject, { once: true })
          context.render()
        })
      const binding = options.created
        ? bindWebSession(options.created, permission)
        : await loadWebSession(
            (sessionId, options) => context.client.session.load(sessionId, options),
            id,
            permission,
          )
      if (epoch !== context.selection) {
        binding.offPermission?.()
        return
      }
      const loaded = binding.session
      context.current = loaded
      context.sessionControls = undefined
      context.controlPending = false
      context.offPermission = binding.offPermission
      context.moduleSessionId = loaded.id
      await context.clientModules.reconciler.reconcileNow()
      if (epoch !== context.selection) {
        binding.offPermission?.()
        return
      }
      context.clientModules.session.setSession(loaded.id)
      if (!options.created)
        context.permissionMode =
          context.sessionRows.find((row) => row.sessionId === id)?.preset === 'read-only'
            ? 'view'
            : 'workspace'
      const metadata = context.sessionRows.find((row) => row.sessionId === id) as
        | (PageSessionMeta['items'][number] & { cwd?: string })
        | undefined
      const workspacePath = metadata?.cwd ?? options.workspace?.path
      if (workspacePath)
        context.selectedWorkspace =
          context.workspaceRows.find((entry) => entry.path === workspacePath) ??
          (options.workspace?.path === workspacePath ? options.workspace : undefined)
      const url = new URL(location.href)
      url.searchParams.set('session', id)
      history.replaceState(null, '', `${url.pathname}${url.search}`)
      context.offPermission = binding.offPermission
      let opened = false
      const selected = () => context.current === loaded && epoch === context.selection
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
            // 首投影就绪后才换代：清空转录区、写入新会话内容、同步审批卡与控件，
            // 都发生在同一次同步序列里，旧→新之间没有空白帧。
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
          if (selected()) void followEvent(loaded, event).catch(context.showError)
        },
        error(error) {
          if (selected()) context.showError(error)
        },
      })
      context.live = liveProjection
      context.stopEvents = () => liveProjection.stop()
      await liveProjection.start()
      await context.refreshSessionControls(loaded)
      if (epoch !== context.selection) return
      selectionReady = true
      context.sessionPending = false
      context.clearSessionRecovery()
      context.render()
      void context.list().catch((error: unknown) => {
        if (epoch === context.selection) context.showError(error)
      })
    } catch (error) {
      if (epoch !== context.selection) return
      if (!selectionReady) {
        const failed = context.current
        context.current = undefined
        context.moduleSessionId = undefined
        context.clientModules.session.setSession(undefined)
        context.projection = undefined
        context.knownSessionModel = undefined
        context.modelChangePending = false
        context.offPermission?.()
        context.offPermission = undefined
        try {
          await stopWithTimeout(context.stopEvents)
        } catch {
          // The original loading failure is the useful error for this selection.
        }
        context.stopEvents = undefined
        context.live = undefined
        try {
          await failed?.detach()
        } catch {
          // The failed binding is already unavailable to the composer.
        }
        // 加载失败没有可保留的画面：清空转录区回到空态，错误走 #notice。
        context.renderer.reset()
        if (options.preserveSending) {
          context.draftingNew = true
          context.selectedWorkspace = options.workspace
          context.knownSessionModel = options.initialModel
          context.initialModelPending = undefined
        }
        context.sessionPending = false
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
    if (['inbox', 'x/core/control', 'x/core/pause-state', 'turn/start', 'turn/end'].includes(event.type))
      void context.refreshSessionControls(session).catch(context.showError)
    const title = readSessionTitle(event)
    if (title?.status === 'generated') {
      // The list owns user overrides; a late automatic event cannot overwrite one.
      await context.list().catch(context.showError)
      context.titleRefresh.stop(session.id)
    } else if (title?.status === 'failed') context.titleRefresh.stop(session.id)
    // A new message makes this the most recently chatted session; the daemon now lists it first.
    if (event.type === 'user/message') void context.list().catch(context.showError)
    if (
      event.type === 'turn/end' &&
      (event.data as { reason?: string }).reason === 'completed' &&
      !context.sessionTitles.has(session.id)
    )
      context.titleRefresh.start(session.id)
    context.receipts.set(session.id, recordRunEvent(context.receipts.get(session.id), event))
  }

  async function forkTurn(turn: UITurn): Promise<void> {
    const parent = context.current
    if (!parent || !turn.forkable || turn.endSeq === undefined || context.projection?.opState !== null)
      throw new Error(context.t('app.fork.notIdle'))
    const forked = await context.client.session.fork(parent.id, turn.endSeq)
    await open(forked.id, { created: forked })
    context.notice.textContent = context.t('app.fork.created')
    context.notice.dataset.kind = ''
    context.composerRuntime.focus()
  }

  async function forkSidebar(id: string, title: string): Promise<void> {
    const epoch = context.selection
    const row = context.sessionRows.find((item) => item.sessionId === id)
    const source = await context.client.session.load(id, row?.cwd ? { cwd: row.cwd } : {})
    const timeline = await source.projectUI(undefined, { surface: 'web' })
    if (timeline.opState !== null) throw new Error(context.t('app.fork.waitIdle'))
    const turn = timeline.turns.findLast((item) => item.forkable && item.endSeq !== undefined)
    if (turn?.endSeq === undefined) throw new Error(context.t('app.fork.noForkableTurn'))
    const child = await context.client.session.fork(id, turn.endSeq)
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
      if (epoch === context.selection) await open(child.id, { created: child })
    } catch (error) {
      refreshError = error
    }
    if (refreshError) throw new Error(context.t('app.fork.refreshFailed', { id: child.id }))
    if (namingError) throw new Error(context.t('app.fork.renameFailed'))
  }

  return { open, stopWithTimeout, followEvent, forkTurn, forkSidebar }
}
