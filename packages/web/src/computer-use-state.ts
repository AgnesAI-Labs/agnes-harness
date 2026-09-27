import type {
  ComputerUseDoctorResult,
  ComputerUseOperationResult,
  ComputerUsePermissionsStatusResult,
  ComputerUseStatusResult,
} from '@agnes/protocol'

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
const BLOCKER_LABELS: Readonly<Record<BlockedStatus['blockers'][number], string>> = {
  'release-provenance-incomplete': '驱动发布来源与完整性证据尚未锁定',
  'compatibility-evidence-incomplete': '固定版本兼容性证据尚未完成',
  'platform-acceptance-incomplete': '平台实机验收尚未完成',
  'feature-disabled': '当前配置已关闭电脑操作，请检查本地配置中的 computerUse.enabled。',
  'platform-unsupported': '当前系统或处理器暂不支持电脑操作。',
  'driver-not-prepared': '首次使用时会自动准备驱动，也可以点击“准备驱动”。',
  'driver-preparing': '正在准备驱动，请稍候。',
  'driver-prepare-failed': '驱动准备未完成。请检查网络或安装环境，然后点击“准备驱动”重试。',
}

/** One Web-owned RPC coordinator per pane. Retirement only stops local work. */
export function createComputerUseState(
  client: ComputerUseStatusClient,
  polling: ComputerUseOperationPolling = {},
): ComputerUseState {
  let disposed = false
  const listeners = new Set<() => void>()
  const view = {
    statusLabel: '等待检查',
    statusSummary: '打开面板后读取本机状态。',
    runtime: '',
    blockers: [] as string[],
    permissionLabel: '等待检查',
    permissionSummary: '驱动就绪后显示当前系统所需的权限。',
    grantHidden: true,
    doctorLabel: '等待检查',
    doctorSummary: '检查本机驱动是否正常。',
    operationLabel: '没有记录',
    operationSummary: '首次使用会自动准备驱动；已有安装会先验证并复用。',
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
        label: view.statusLabel,
        summary: view.statusSummary,
        runtime: view.runtime,
        blockers: Object.freeze([...view.blockers]),
      }),
      permissions: Object.freeze({
        label: view.permissionLabel,
        summary: view.permissionSummary,
        grantHidden: view.grantHidden,
      }),
      doctor: Object.freeze({ label: view.doctorLabel, summary: view.doctorSummary }),
      operation: Object.freeze({
        label: view.operationLabel,
        summary: view.operationSummary,
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
      view.operationLabel = '没有记录'
      view.operationSummary = '本机没有可显示的驱动操作。'
      publish()
      return true
    }
    const terminal = report.state === 'succeeded' || report.state === 'failed' || report.state === 'cancelled'
    activeOperationId = terminal ? undefined : report.operationId
    operationPending = !terminal
    if (report.state === 'queued') {
      view.operationLabel = '等待执行'
      view.operationSummary = '驱动操作已进入本机队列。'
    } else if (report.state === 'running') {
      view.operationLabel = report.phase === 'restarting' ? '正在重启' : '正在安装'
      view.operationSummary = '正在检查已有驱动；缺失时会下载并验证。网络较慢时需要等待，可取消后重试。'
    } else if (report.state === 'cancelling') {
      view.operationLabel = '正在取消'
      view.operationSummary = '已请求取消；正在等待当前安全步骤结束。'
    } else if (report.state === 'succeeded') {
      view.operationLabel = '操作完成'
      const labels = {
        installed: '驱动已经安装并通过验证。',
        'already-current': '当前驱动已经是锁定版本。',
        repaired: '驱动已经修复并通过验证。',
        restarted: '驱动已经安全重启。',
        'lkg-restored': '新驱动未通过验证，已恢复上一可用版本。',
      } as const
      view.operationSummary = report.outcome ? labels[report.outcome] : '驱动操作已经完成。'
    } else if (report.state === 'cancelled') {
      view.operationLabel = '已取消'
      view.operationSummary = '驱动操作已取消，未继续执行后续步骤。'
    } else {
      view.operationLabel = '操作失败'
      view.operationSummary = '驱动准备或维护未完成。请检查网络或安装环境后重试。'
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
        view.operationLabel = '无法读取进度'
        view.operationSummary = '驱动操作可能仍在后台执行，请稍后刷新进度。'
        publish()
        return
      }
    }
    if (current !== operationGeneration) return
    view.operationLabel = '仍在执行'
    view.operationSummary = '等待时间较长，驱动操作仍可能在后台执行，请稍后刷新进度。'
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
    view.operationLabel = '正在提交'
    view.operationSummary = '正在向本机 Host 提交驱动操作。'
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
      view.operationLabel = '无法确认是否开始'
      view.operationSummary = '无法确认提交结果；操作可能已在后台开始，请刷新进度后再试。'
      publish()
    }
  }

  const refreshOperation = async (): Promise<void> => {
    if (disposed || operationMutationPending || operationReadPending) return
    cancelWait?.()
    const current = ++operationGeneration
    operationReadPending = true
    view.operationLabel = '正在读取'
    view.operationSummary = '正在读取最近一次驱动操作。'
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
      view.operationLabel = '无法读取'
      view.operationSummary = operationPending
        ? '暂时无法读取进度；操作可能仍在后台执行。'
        : '暂时无法读取驱动操作进度。'
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
    view.operationLabel = '正在取消'
    view.operationSummary = '正在请求本机 Host 停止驱动操作。'
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
      view.operationLabel = '取消失败'
      view.operationSummary = '无法确认取消结果，请刷新进度后再试。'
      publish()
    }
  }

  const applyPermissions = (report: ComputerUsePermissionsStatusResult): void => {
    view.grantHidden = true
    if (report.status === 'not-required') {
      view.permissionLabel = '无需系统授权'
      view.permissionSummary =
        report.admission.reason === 'linux-verified-driver'
          ? 'Linux 不使用 macOS 的辅助功能和录屏授权；桌面会话能力由驱动健康检查验证。'
          : 'Windows 无需额外的录屏或辅助功能授权。'
      return
    }
    if (report.status === 'granted') {
      view.permissionLabel = '已授权'
      view.permissionSummary = '辅助功能和屏幕录制均已授权。'
      return
    }
    if (report.status === 'required') {
      view.permissionLabel = '需要授权'
      const missing = [
        report.probe.accessibility ? undefined : '辅助功能',
        report.probe.screenRecording ? undefined : '屏幕录制',
      ].filter((value): value is string => value !== undefined)
      view.permissionSummary = `macOS 仍需授权：${missing.join('、')}。点击后由系统设置窗口完成。`
      view.grantHidden = false
      return
    }
    if (report.status === 'unknown') {
      view.permissionLabel = '无法确认'
      view.permissionSummary = '无法从已验签驱动读取 macOS 权限，请刷新后重试。'
      return
    }
    view.permissionLabel = '不可用'
    view.permissionSummary = '生产驱动尚未通过准入，未检查系统权限。'
  }

  const unavailablePermissions = (): void => {
    view.permissionLabel = '无法读取'
    view.permissionSummary = '暂时无法读取系统权限；没有发起授权。'
    view.grantHidden = true
    publish()
  }

  const load = async (discoverOperation = true): Promise<void> => {
    if (disposed) return
    const current = ++generation
    const permissionCurrent = grantPending ? undefined : ++permissionGeneration
    statusPending = true
    view.statusLabel = '正在检查'
    view.statusSummary = '正在读取本机 Computer Use 安全门状态。'
    view.runtime = ''
    view.blockers = []
    publish()
    if (current !== generation) return
    try {
      const report = await client.call<ComputerUseStatusResult>('_agnes/v1/computerUse.status', {})
      if (current !== generation) return
      driverPreparing = report.status === 'blocked' && report.blockers.includes('driver-preparing')
      if (report.status === 'ready') {
        driverReady = true
        view.statusLabel = report.runtime.state === 'running' ? '运行中' : '可用'
        const platform =
          report.driver.platform === 'darwin'
            ? 'macOS'
            : report.driver.platform === 'linux'
              ? 'Linux'
              : 'Windows'
        view.statusSummary = `${platform} 驱动 ${report.driver.version} 已就绪。请在对话中使用支持图片的模型操作电脑。`
        view.runtime =
          report.runtime.state === 'running'
            ? `运行时：${report.runtime.activeSessions} 个活动会话`
            : report.runtime.startAttempted
              ? '运行时：当前空闲，之前已启动过'
              : '运行时：已就绪，尚未启动会话'
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
        view.statusLabel =
          reason === 'feature-disabled'
            ? '已关闭'
            : reason === 'platform-unsupported'
              ? '暂不支持'
              : reason === 'driver-preparing'
                ? '准备中'
                : reason === 'driver-prepare-failed'
                  ? '准备失败'
                  : '首次使用自动准备'
        view.statusSummary = reason ? BLOCKER_LABELS[reason] : '请刷新状态后重试。'
        view.runtime = '电脑操作需要支持图片的模型；普通聊天不受影响。'
        if (permissionCurrent === permissionGeneration) {
          view.permissionLabel = '等待驱动就绪'
          view.permissionSummary = '驱动就绪后显示当前系统所需的权限。'
          view.grantHidden = true
        }
        if (driverPreparing && discoverOperation && !operationPending) void refreshOperation()
        return
      }
      view.statusLabel = '已阻止'
      view.statusSummary = '当前平台的生产驱动准入保持关闭。'
      view.runtime = '运行时：未启动，且未尝试启动'
      view.blockers = report.blockers.map((blocker) => BLOCKER_LABELS[blocker])
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
      view.statusLabel = '无法读取'
      view.statusSummary = '暂时无法读取 Computer Use 状态；未执行任何驱动操作。'
      view.runtime = ''
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
    view.permissionLabel = '等待系统授权'
    view.permissionSummary = '请在 macOS 系统界面完成辅助功能和屏幕录制授权。'
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
      view.permissionLabel = '授权未完成'
      view.permissionSummary = '系统授权未完成或无法验证，请检查系统设置后刷新。'
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
    view.doctorLabel = '正在检查'
    view.doctorSummary = '正在验证驱动健康状态和签名身份。'
    publish()
    if (current !== doctorGeneration) return
    try {
      const report = await client.call<ComputerUseDoctorResult>('_agnes/v1/computerUse.doctor', {})
      if (current !== doctorGeneration) return
      if (report.status === 'ready') {
        view.doctorLabel = '检查通过'
        view.doctorSummary =
          report.admission.reason === 'macos-verified-driver'
            ? 'macOS 驱动健康状态和签名身份均已验证。'
            : report.admission.reason === 'linux-verified-driver'
              ? 'Linux 驱动健康状态、来源身份和桌面会话均已验证。'
              : 'Windows 驱动健康状态和签名身份均已验证。'
        return
      }
      if (report.status === 'failed') {
        view.doctorLabel = '检查失败'
        view.doctorSummary = '驱动健康状态或签名身份已经变化，请修复或重新安装后再试。'
        return
      }
      if (report.status === 'unreachable') {
        view.doctorLabel = '无法连接'
        view.doctorSummary = '实时驱动诊断入口不可用，请重新启动或修复驱动。'
        return
      }
      view.doctorLabel = '未执行'
      view.doctorSummary = '生产驱动尚未通过准入，无法执行健康检查。'
    } catch {
      if (current !== doctorGeneration) return
      view.doctorLabel = '检查失败'
      view.doctorSummary = '暂时无法完成健康检查；没有启动或修复驱动。'
    } finally {
      if (current === doctorGeneration) {
        doctorPending = false
        publish()
      }
    }
  }

  publish()
  return {
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
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
