import type {
  ComputerUseDoctorResult,
  ComputerUseOperationResult,
  ComputerUsePermissionsStatusResult,
  ComputerUseStatusResult,
} from '@agnes/protocol'
import {
  type ComputerUsePhrase,
  computerUseLocale,
  computerUsePhrase,
  computerUseText,
} from '@agnes/web-foundation/locales/computer-use'

export type ComputerUseStatusClient = Readonly<{
  call<T>(method: string, params: unknown): Promise<T>
}>

export type ComputerUseStatusController = Readonly<{
  dispose(): void
  refresh(): Promise<void>
  grantPermissions(): Promise<void>
  doctor(): Promise<void>
  install(): Promise<void>
  update(): Promise<void>
  restart(): Promise<void>
  refreshOperation(): Promise<void>
  cancelOperation(): Promise<void>
}>

export type ComputerUseOperationPolling = Readonly<{
  intervalMs?: number
  maxAttempts?: number
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}>

type FoundOperation = Extract<ComputerUseOperationResult, { status: 'found' }>
type ViewSection = Readonly<{ label: string; summary: string }>
export type ComputerUseSnapshot = Readonly<{
  status: ViewSection & Readonly<{ runtime: string; blockers: readonly string[] }>
  permissions: ViewSection & Readonly<{ grantHidden: boolean }>
  doctor: ViewSection
  operation: ViewSection &
    Readonly<{
      record: Readonly<Pick<FoundOperation, 'operationId' | 'kind' | 'state' | 'phase'>> | undefined
    }>
  controls: Readonly<{
    refreshDisabled: boolean
    grantDisabled: boolean
    doctorDisabled: boolean
    installDisabled: boolean
    updateDisabled: boolean
    restartDisabled: boolean
    operationRefreshDisabled: boolean
    cancelDisabled: boolean
    cancelHidden: boolean
  }>
}>
export type ComputerUseState = ComputerUseStatusController &
  Readonly<{
    getSnapshot(): ComputerUseSnapshot
    subscribe(listener: () => void): () => void
  }>

type BlockedStatus = Extract<ComputerUseStatusResult, { status: 'blocked' }>
const BLOCKER_KEYS: Readonly<Record<BlockedStatus['blockers'][number], ComputerUsePhrase['key']>> = {
  'release-provenance-incomplete': 'computerUse.blocker.releaseProvenance',
  'compatibility-evidence-incomplete': 'computerUse.blocker.compatibility',
  'platform-acceptance-incomplete': 'computerUse.blocker.platformAcceptance',
  'feature-disabled': 'computerUse.blocker.featureDisabled',
  'platform-unsupported': 'computerUse.blocker.platformUnsupported',
  'driver-not-prepared': 'computerUse.blocker.driverNotPrepared',
  'driver-preparing': 'computerUse.blocker.driverPreparing',
  'driver-prepare-failed': 'computerUse.blocker.driverPrepareFailed',
}
const phrase = (key: ComputerUsePhrase['key'], vars?: ComputerUsePhrase['vars']): ComputerUsePhrase =>
  vars === undefined ? { key } : { key, vars }

/** One Web-owned RPC coordinator per pane. Retirement only stops local work. */
export function createComputerUseState(
  client: ComputerUseStatusClient,
  polling: ComputerUseOperationPolling = {},
): ComputerUseState {
  let disposed = false
  const listeners = new Set<() => void>()
  const view = {
    statusLabel: phrase('computerUse.status.pending'),
    statusSummary: phrase('computerUse.status.pendingSummary'),
    runtime: undefined as ComputerUsePhrase | undefined,
    blockers: [] as ComputerUsePhrase[],
    permissionLabel: phrase('computerUse.permissions.pending'),
    permissionSummary: phrase('computerUse.permissions.pendingSummary'),
    grantHidden: true,
    doctorLabel: phrase('computerUse.doctor.pending'),
    doctorSummary: phrase('computerUse.doctor.pendingSummary'),
    operationLabel: phrase('computerUse.operation.none'),
    operationSummary: phrase('computerUse.operation.noneSummary'),
    permissionMissing: [] as ComputerUsePhrase['key'][],
  }
  let snapshot: ComputerUseSnapshot
  let operationRecord: ComputerUseSnapshot['operation']['record']
  let doctorPending = false
  let operationMutationPending = false
  let operationReadPending = false
  let generation = 0
  let permissionGeneration = 0
  let doctorGeneration = 0
  let grantGeneration = 0
  let operationGeneration = 0
  let statusPending = false
  let grantPending = false
  let operationPending = false
  let driverReady = false
  let driverPreparing = false
  let canPrepare = false
  let activeOperationId: string | undefined

  let cancelWait: (() => void) | undefined
  const operationWait = (delayMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: unknown): void => {
        if (timer !== undefined) globalThis.clearTimeout(timer)
        if (cancelWait === cancel) cancelWait = undefined
        if (error === undefined) resolve()
        else reject(error)
      }
      const cancel = (): void => {
        abort.abort()
        finish()
      }
      cancelWait = cancel
      if (polling.wait) {
        try {
          polling.wait(delayMs, abort.signal).then(() => finish(), finish)
        } catch (error) {
          finish(error)
        }
      } else timer = globalThis.setTimeout(() => finish(), delayMs)
    })
  const operationIntervalMs = Math.max(0, polling.intervalMs ?? 500)
  const operationMaxAttempts = Math.max(1, polling.maxAttempts ?? 240)

  const publish = (): void => {
    if (disposed) return
    snapshot = Object.freeze({
      status: Object.freeze({
        label: computerUsePhrase(view.statusLabel),
        summary: computerUsePhrase(view.statusSummary),
        runtime: view.runtime === undefined ? '' : computerUsePhrase(view.runtime),
        blockers: Object.freeze(view.blockers.map((item) => computerUsePhrase(item))),
      }),
      permissions: Object.freeze({
        label: computerUsePhrase(view.permissionLabel),
        summary: computerUsePhrase(
          view.permissionSummary.key === 'computerUse.permissions.requiredSummary'
            ? phrase('computerUse.permissions.requiredSummary', {
                missing: view.permissionMissing
                  .map((key) => computerUseText(key))
                  .join(computerUseLocale() === 'zh-CN' ? '、' : ', '),
              })
            : view.permissionSummary,
        ),
        grantHidden: view.grantHidden,
      }),
      doctor: Object.freeze({
        label: computerUsePhrase(view.doctorLabel),
        summary: computerUsePhrase(view.doctorSummary),
      }),
      operation: Object.freeze({
        label: computerUsePhrase(view.operationLabel),
        summary: computerUsePhrase(view.operationSummary),
        record: operationRecord,
      }),
      controls: Object.freeze({
        refreshDisabled: statusPending || grantPending || operationPending,
        grantDisabled: grantPending,
        installDisabled:
          operationPending || statusPending || operationReadPending || (!driverReady && !canPrepare),
        updateDisabled: operationPending || statusPending || operationReadPending || !driverReady,
        restartDisabled: operationPending || statusPending || operationReadPending || !driverReady,
        doctorDisabled: doctorPending || !driverReady,
        operationRefreshDisabled: operationReadPending || operationMutationPending,
        cancelDisabled: !operationPending || !activeOperationId || operationMutationPending,
        cancelHidden: !operationPending,
      }),
    })
    for (const listener of listeners) listener()
  }

  const applyOperation = (report: ComputerUseOperationResult): boolean => {
    operationRecord =
      report.status === 'found'
        ? Object.freeze({
            operationId: report.operationId,
            kind: report.kind,
            state: report.state,
            phase: report.phase,
          })
        : undefined
    if (report.status === 'not-found') {
      activeOperationId = undefined
      operationPending = false
      view.operationLabel = phrase('computerUse.operation.none')
      view.operationSummary = phrase('computerUse.operation.emptySummary')
      publish()
      return true
    }
    const terminal = report.state === 'succeeded' || report.state === 'failed' || report.state === 'cancelled'
    activeOperationId = terminal ? undefined : report.operationId
    operationPending = !terminal
    if (report.state === 'queued') {
      view.operationLabel = phrase('computerUse.operation.queued')
      view.operationSummary = phrase('computerUse.operation.queuedSummary')
    } else if (report.state === 'running') {
      view.operationLabel = phrase(
        report.phase === 'restarting'
          ? 'computerUse.operation.restarting'
          : 'computerUse.operation.installing',
      )
      view.operationSummary = phrase('computerUse.operation.runningSummary')
    } else if (report.state === 'cancelling') {
      view.operationLabel = phrase('computerUse.operation.cancelling')
      view.operationSummary = phrase('computerUse.operation.cancellingSummary')
    } else if (report.state === 'succeeded') {
      view.operationLabel = phrase('computerUse.operation.done')
      const outcomes = {
        installed: 'computerUse.operation.installed',
        'already-current': 'computerUse.operation.alreadyCurrent',
        repaired: 'computerUse.operation.repaired',
        restarted: 'computerUse.operation.restarted',
        'lkg-restored': 'computerUse.operation.lkgRestored',
      } as const
      view.operationSummary = phrase(
        report.outcome ? outcomes[report.outcome] : 'computerUse.operation.doneSummary',
      )
    } else if (report.state === 'cancelled') {
      view.operationLabel = phrase('computerUse.operation.cancelled')
      view.operationSummary = phrase('computerUse.operation.cancelledSummary')
    } else {
      view.operationLabel = phrase('computerUse.operation.failed')
      view.operationSummary = phrase('computerUse.operation.failedSummary')
    }
    publish()
    return terminal
  }

  const monitorOperation = async (operationId: string | undefined, current: number): Promise<void> => {
    for (let attempt = 0; attempt < operationMaxAttempts; attempt += 1) {
      if (current !== operationGeneration) return
      try {
        await operationWait(operationIntervalMs)
        if (current !== operationGeneration) return
        const report = await client.call<ComputerUseOperationResult>(
          '_agnes/v1/computerUse.operation.status',
          operationId ? { operationId } : {},
        )
        if (current !== operationGeneration) return
        if (applyOperation(report)) {
          if (current !== operationGeneration) return
          // Status may already describe a newer preparation. Rediscover it within this bounded
          // loop, never by recursively starting a fresh monitor from load().
          await load(false)
          if (current !== operationGeneration || !driverPreparing) return
          operationId = undefined
        } else if (report.status === 'found') {
          operationId = report.operationId
        }
      } catch {
        if (current !== operationGeneration) return
        view.operationLabel = phrase('computerUse.operation.progressUnreadable')
        view.operationSummary = phrase('computerUse.operation.progressUnreadableSummary')
        publish()
        return
      }
    }
    if (current !== operationGeneration) return
    view.operationLabel = phrase('computerUse.operation.stillRunning')
    view.operationSummary = phrase('computerUse.operation.stillRunningSummary')
    publish()
  }

  const startOperation = async (kind: 'install' | 'update' | 'restart'): Promise<void> => {
    if (
      disposed ||
      operationPending ||
      statusPending ||
      operationReadPending ||
      (!driverReady && !(kind === 'install' && canPrepare))
    )
      return
    cancelWait?.()
    const current = ++operationGeneration
    operationMutationPending = true
    operationReadPending = false
    operationPending = true
    activeOperationId = undefined
    operationRecord = undefined
    view.operationLabel = phrase('computerUse.operation.submitting')
    view.operationSummary = phrase('computerUse.operation.submittingSummary')
    publish()
    if (current !== operationGeneration) return
    try {
      const report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.start', {
        kind,
      })
      if (current !== operationGeneration) return
      operationMutationPending = false
      if (applyOperation(report)) {
        if (current !== operationGeneration) return
        await load(false)
        if (current === operationGeneration && driverPreparing) await monitorOperation(undefined, current)
      } else if (report.status === 'found') await monitorOperation(report.operationId, current)
    } catch {
      if (current !== operationGeneration) return
      operationMutationPending = false
      view.operationLabel = phrase('computerUse.operation.startUnknown')
      view.operationSummary = phrase('computerUse.operation.startUnknownSummary')
      publish()
    }
  }

  const refreshOperation = async (): Promise<void> => {
    if (disposed || operationMutationPending || operationReadPending) return
    cancelWait?.()
    const current = ++operationGeneration
    operationReadPending = true
    view.operationLabel = phrase('computerUse.operation.reading')
    view.operationSummary = phrase('computerUse.operation.readingSummary')
    publish()
    if (current !== operationGeneration) return
    try {
      const report = await client.call<ComputerUseOperationResult>(
        '_agnes/v1/computerUse.operation.status',
        activeOperationId ? { operationId: activeOperationId } : {},
      )
      if (current !== operationGeneration) return
      operationReadPending = false
      const terminal = applyOperation(report)
      if (current !== operationGeneration) return
      if (!terminal && report.status === 'found') await monitorOperation(report.operationId, current)
      else {
        if (current !== operationGeneration) return
        await load(false)
        if (current === operationGeneration && driverPreparing) await monitorOperation(undefined, current)
      }
    } catch {
      if (current !== operationGeneration) return
      view.operationLabel = phrase('computerUse.operation.readFailed')
      view.operationSummary = phrase(
        operationPending
          ? 'computerUse.operation.readFailedPendingSummary'
          : 'computerUse.operation.readFailedSummary',
      )
      publish()
    } finally {
      if (current === operationGeneration) {
        operationReadPending = false
        publish()
      }
    }
  }

  const cancelOperation = async (): Promise<void> => {
    if (disposed || operationMutationPending || !operationPending || !activeOperationId) return
    cancelWait?.()
    const operationId = activeOperationId
    const current = ++operationGeneration
    operationReadPending = false
    view.operationLabel = phrase('computerUse.operation.cancelling')
    view.operationSummary = phrase('computerUse.operation.cancelRequestSummary')
    operationMutationPending = true
    publish()
    if (current !== operationGeneration) return
    try {
      const report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.cancel', {
        operationId,
      })
      if (current !== operationGeneration) return
      operationMutationPending = false
      if (!applyOperation(report) && report.status === 'found')
        await monitorOperation(report.operationId, current)
      else {
        if (current !== operationGeneration) return
        await load(false)
        if (current === operationGeneration && driverPreparing) await monitorOperation(undefined, current)
      }
    } catch {
      if (current !== operationGeneration) return
      operationMutationPending = false
      view.operationLabel = phrase('computerUse.operation.cancelFailed')
      view.operationSummary = phrase('computerUse.operation.cancelFailedSummary')
      publish()
    }
  }

  const applyPermissions = (report: ComputerUsePermissionsStatusResult): void => {
    view.grantHidden = true
    view.permissionMissing = []
    if (report.status === 'not-required') {
      view.permissionLabel = phrase('computerUse.permissions.notRequired')
      view.permissionSummary = phrase(
        report.admission.reason === 'linux-verified-driver'
          ? 'computerUse.permissions.linuxSummary'
          : 'computerUse.permissions.windowsSummary',
      )
      return
    }
    if (report.status === 'granted') {
      view.permissionLabel = phrase('computerUse.permissions.granted')
      view.permissionSummary = phrase('computerUse.permissions.grantedSummary')
      return
    }
    if (report.status === 'required') {
      view.permissionLabel = phrase('computerUse.permissions.required')
      view.permissionMissing = [
        report.probe.accessibility ? undefined : 'computerUse.permissions.accessibility',
        report.probe.screenRecording ? undefined : 'computerUse.permissions.screenRecording',
      ].filter((value): value is ComputerUsePhrase['key'] => value !== undefined)
      view.permissionSummary = phrase('computerUse.permissions.requiredSummary')
      view.grantHidden = false
      return
    }
    if (report.status === 'unknown') {
      view.permissionLabel = phrase('computerUse.permissions.unknown')
      view.permissionSummary = phrase('computerUse.permissions.unknownSummary')
      return
    }
    view.permissionLabel = phrase('computerUse.permissions.unavailable')
    view.permissionSummary = phrase('computerUse.permissions.unavailableSummary')
  }

  const unavailablePermissions = (): void => {
    view.permissionLabel = phrase('computerUse.permissions.unreadable')
    view.permissionSummary = phrase('computerUse.permissions.unreadableSummary')
    view.grantHidden = true
    publish()
  }

  const load = async (discoverOperation = true): Promise<void> => {
    if (disposed) return
    const current = ++generation
    const permissionCurrent = grantPending ? undefined : ++permissionGeneration
    statusPending = true
    view.statusLabel = phrase('computerUse.status.checking')
    view.statusSummary = phrase('computerUse.status.checkingSummary')
    view.runtime = undefined
    view.blockers = []
    publish()
    if (current !== generation) return
    try {
      const report = await client.call<ComputerUseStatusResult>('_agnes/v1/computerUse.status', {})
      if (current !== generation) return
      driverPreparing = report.status === 'blocked' && report.blockers.includes('driver-preparing')
      if (report.status === 'ready') {
        driverReady = true
        view.statusLabel = phrase(
          report.runtime.state === 'running' ? 'computerUse.status.running' : 'computerUse.status.available',
        )
        const platform =
          report.driver.platform === 'darwin'
            ? 'macOS'
            : report.driver.platform === 'linux'
              ? 'Linux'
              : 'Windows'
        view.statusSummary = phrase('computerUse.status.readySummary', {
          platform,
          version: report.driver.version,
        })
        view.runtime =
          report.runtime.state === 'running'
            ? phrase('computerUse.runtime.active', { count: report.runtime.activeSessions })
            : phrase(report.runtime.startAttempted ? 'computerUse.runtime.idle' : 'computerUse.runtime.ready')
        view.blockers = []
        publish()
        if (current !== generation || permissionCurrent === undefined) return
        try {
          const permissions = await client.call<ComputerUsePermissionsStatusResult>(
            '_agnes/v1/computerUse.permissions.status',
            {},
          )
          if (current !== generation || permissionCurrent !== permissionGeneration) return
          applyPermissions(permissions)
        } catch {
          if (current !== generation || permissionCurrent !== permissionGeneration) return
          unavailablePermissions()
        }
        return
      }
      driverReady = false
      canPrepare =
        report.blockers.includes('driver-not-prepared') || report.blockers.includes('driver-prepare-failed')
      if (report.admission.reason === 'runtime-unavailable') {
        const reason = report.blockers[0]
        view.statusLabel = phrase(
          reason === 'feature-disabled'
            ? 'computerUse.status.closed'
            : reason === 'platform-unsupported'
              ? 'computerUse.status.unsupported'
              : reason === 'driver-preparing'
                ? 'computerUse.status.preparing'
                : reason === 'driver-prepare-failed'
                  ? 'computerUse.status.prepareFailed'
                  : 'computerUse.status.firstPrepare',
        )
        view.statusSummary = phrase(reason ? BLOCKER_KEYS[reason] : 'computerUse.status.refreshRetry')
        view.runtime = phrase('computerUse.runtime.imageModel')
        if (permissionCurrent === permissionGeneration) {
          view.permissionLabel = phrase('computerUse.permissions.waitingDriver')
          view.permissionSummary = phrase('computerUse.permissions.pendingSummary')
          view.grantHidden = true
        }
        if (driverPreparing && discoverOperation && !operationPending) void refreshOperation()
        return
      }
      view.statusLabel = phrase('computerUse.status.blocked')
      view.statusSummary = phrase('computerUse.status.blockedSummary')
      view.runtime = phrase('computerUse.runtime.notStarted')
      view.blockers = report.blockers.map((blocker) => phrase(BLOCKER_KEYS[blocker]))
      if (permissionCurrent === permissionGeneration)
        applyPermissions({
          schemaVersion: 1,
          status: 'unavailable',
          admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
          probe: { state: 'not-run', reason: 'production-driver-admission-disabled' },
        })
    } catch {
      if (current !== generation) return
      driverReady = false
      driverPreparing = false
      canPrepare = false
      view.statusLabel = phrase('computerUse.status.unreadable')
      view.statusSummary = phrase('computerUse.status.unreadableSummary')
      view.runtime = undefined
      view.blockers = []
      if (permissionCurrent === permissionGeneration) unavailablePermissions()
    } finally {
      if (current === generation) {
        statusPending = false
        publish()
      }
    }
  }

  const grantPermissions = async (): Promise<void> => {
    if (disposed || grantPending) return
    const current = ++permissionGeneration
    const grantCurrent = ++grantGeneration
    grantPending = true
    view.permissionLabel = phrase('computerUse.permissions.granting')
    view.permissionSummary = phrase('computerUse.permissions.grantingSummary')
    publish()
    if (current !== permissionGeneration) return
    try {
      const report = await client.call<ComputerUsePermissionsStatusResult>(
        '_agnes/v1/computerUse.permissions.grant',
        {},
      )
      if (current !== permissionGeneration) return
      applyPermissions(report)
    } catch {
      if (current !== permissionGeneration) return
      view.permissionLabel = phrase('computerUse.permissions.grantFailed')
      view.permissionSummary = phrase('computerUse.permissions.grantFailedSummary')
      view.grantHidden = false
    } finally {
      if (grantCurrent === grantGeneration) {
        grantPending = false
        publish()
      }
    }
  }

  const doctor = async (): Promise<void> => {
    if (disposed || doctorPending) return
    const current = ++doctorGeneration
    doctorPending = true
    view.doctorLabel = phrase('computerUse.doctor.checking')
    view.doctorSummary = phrase('computerUse.doctor.checkingSummary')
    publish()
    if (current !== doctorGeneration) return
    try {
      const report = await client.call<ComputerUseDoctorResult>('_agnes/v1/computerUse.doctor', {})
      if (current !== doctorGeneration) return
      if (report.status === 'ready') {
        view.doctorLabel = phrase('computerUse.doctor.passed')
        view.doctorSummary = phrase(
          report.admission.reason === 'macos-verified-driver'
            ? 'computerUse.doctor.macosSummary'
            : report.admission.reason === 'linux-verified-driver'
              ? 'computerUse.doctor.linuxSummary'
              : 'computerUse.doctor.windowsSummary',
        )
        return
      }
      if (report.status === 'failed') {
        view.doctorLabel = phrase('computerUse.doctor.failed')
        view.doctorSummary = phrase('computerUse.doctor.failedSummary')
        return
      }
      if (report.status === 'unreachable') {
        view.doctorLabel = phrase('computerUse.doctor.unreachable')
        view.doctorSummary = phrase('computerUse.doctor.unreachableSummary')
        return
      }
      view.doctorLabel = phrase('computerUse.doctor.skipped')
      view.doctorSummary = phrase('computerUse.doctor.skippedSummary')
    } catch {
      if (current !== doctorGeneration) return
      view.doctorLabel = phrase('computerUse.doctor.failedTemporary')
      view.doctorSummary = phrase('computerUse.doctor.failedTemporarySummary')
    } finally {
      if (current === doctorGeneration) {
        doctorPending = false
        publish()
      }
    }
  }

  const onLocale = (): void => publish()
  if (typeof window !== 'undefined') window.addEventListener('agnes:locale-changed', onLocale)
  publish()
  return {
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      if (typeof window !== 'undefined') window.removeEventListener('agnes:locale-changed', onLocale)
      cancelWait?.()
      generation += 1
      permissionGeneration += 1
      doctorGeneration += 1
      grantGeneration += 1
      operationGeneration += 1
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: load,
    grantPermissions,
    doctor,
    install: () => startOperation('install'),
    update: () => startOperation('update'),
    restart: () => startOperation('restart'),
    refreshOperation,
    cancelOperation,
  }
}
