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
  wait?: (delayMs: number) => Promise<void>
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

function required<K extends keyof HTMLElementTagNameMap>(
  scope: ParentNode,
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const value = scope.querySelector(`#${id}`)
  if (!value || value.tagName.toLowerCase() !== tag) throw new Error(`missing ${tag}#${id}`)
  return value as HTMLElementTagNameMap[K]
}

/**
 * Computer Use status, explicit macOS TCC setup, and authenticated local driver lifecycle controls.
 */
export function createComputerUseStatusController(
  client: ComputerUseStatusClient,
  scope: ParentNode = document,
  polling: ComputerUseOperationPolling = {},
): ComputerUseStatusController {
  let disposed = false
  let node: Element | null = null
  let controller: ComputerUseStatusController | undefined
  const current = (): ComputerUseStatusController | undefined => {
    if (disposed) return undefined
    const next = scope.querySelector('#computer-use-state')
    if (next !== node) {
      controller?.dispose()
      controller = undefined
      node = next
      if (next) controller = createPaneController(client, scope, polling)
    }
    return controller
  }
  const invoke = (method: Exclude<keyof ComputerUseStatusController, 'dispose'>): Promise<void> =>
    current()?.[method]() ?? Promise.resolve()
  const actions = new Map<string, Exclude<keyof ComputerUseStatusController, 'dispose'>>([
    ['computer-use-refresh', 'refresh'],
    ['computer-use-permission-grant', 'grantPermissions'],
    ['computer-use-doctor-run', 'doctor'],
    ['computer-use-install', 'install'],
    ['computer-use-update', 'update'],
    ['computer-use-restart', 'restart'],
    ['computer-use-operation-refresh', 'refreshOperation'],
    ['computer-use-operation-cancel', 'cancelOperation'],
  ])
  const click = (event: Event): void => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest('button')
    if (!button || button.disabled) return
    const method = actions.get(button.id)
    if (method) void invoke(method)
  }
  scope.addEventListener('click', click)
  current()
  // Settings rows are independently replaced by the client-module reconciler. Retire pending
  // replies with their old pane and populate the replacement, including while it is already open.
  const observer = new MutationObserver(() => {
    if (scope.querySelector('#computer-use-state') === node) return
    const replacement = current()
    if (replacement) void replacement.refresh()
  })
  observer.observe(scope.querySelector('#config') ?? scope, { childList: true, subtree: true })
  return {
    dispose() {
      disposed = true
      observer.disconnect()
      scope.removeEventListener('click', click)
      controller?.dispose()
      controller = undefined
    },
    refresh: () => invoke('refresh'),
    grantPermissions: () => invoke('grantPermissions'),
    doctor: () => invoke('doctor'),
    install: () => invoke('install'),
    update: () => invoke('update'),
    restart: () => invoke('restart'),
    refreshOperation: () => invoke('refreshOperation'),
    cancelOperation: () => invoke('cancelOperation'),
  }
}

function createPaneController(
  client: ComputerUseStatusClient,
  scope: ParentNode,
  polling: ComputerUseOperationPolling,
): ComputerUseStatusController {
  const state = required(scope, 'computer-use-state', 'strong')
  const summary = required(scope, 'computer-use-summary', 'p')
  const runtime = required(scope, 'computer-use-runtime', 'p')
  const blockers = required(scope, 'computer-use-blockers', 'ul')
  const refresh = required(scope, 'computer-use-refresh', 'button')
  const permissionState = required(scope, 'computer-use-permission-state', 'strong')
  const permissionSummary = required(scope, 'computer-use-permission-summary', 'p')
  const permissionGrant = required(scope, 'computer-use-permission-grant', 'button')
  const doctorState = required(scope, 'computer-use-doctor-state', 'strong')
  const doctorSummary = required(scope, 'computer-use-doctor-summary', 'p')
  const doctorRun = required(scope, 'computer-use-doctor-run', 'button')
  const operationState = required(scope, 'computer-use-operation-state', 'strong')
  const operationSummary = required(scope, 'computer-use-operation-summary', 'p')
  const operationInstall = required(scope, 'computer-use-install', 'button')
  const operationUpdate = required(scope, 'computer-use-update', 'button')
  const operationRestart = required(scope, 'computer-use-restart', 'button')
  const operationRefresh = required(scope, 'computer-use-operation-refresh', 'button')
  const operationCancel = required(scope, 'computer-use-operation-cancel', 'button')
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

  const operationWait =
    polling.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)))
  const operationIntervalMs = Math.max(0, polling.intervalMs ?? 500)
  const operationMaxAttempts = Math.max(1, polling.maxAttempts ?? 240)

  const syncBusyControls = (): void => {
    refresh.disabled = statusPending || grantPending || operationPending
    permissionGrant.disabled = grantPending
    operationInstall.disabled = operationPending || statusPending || (!driverReady && !canPrepare)
    operationUpdate.disabled = operationPending || !driverReady
    operationRestart.disabled = operationPending || !driverReady
    doctorRun.disabled = !driverReady
    operationCancel.disabled = !operationPending
    operationCancel.hidden = !operationPending
  }

  const renderOperation = (report: ComputerUseOperationResult): boolean => {
    if (report.status === 'not-found') {
      activeOperationId = undefined
      operationPending = false
      operationState.textContent = '没有记录'
      operationSummary.textContent = '本机没有可显示的驱动操作。'
      syncBusyControls()
      return true
    }
    const terminal = report.state === 'succeeded' || report.state === 'failed' || report.state === 'cancelled'
    activeOperationId = terminal ? undefined : report.operationId
    operationPending = !terminal
    if (report.state === 'queued') {
      operationState.textContent = '等待执行'
      operationSummary.textContent = '驱动操作已进入本机队列。'
    } else if (report.state === 'running') {
      operationState.textContent = report.phase === 'restarting' ? '正在重启' : '正在安装'
      operationSummary.textContent =
        '正在检查已有驱动；缺失时会下载并验证。网络较慢时需要等待，可取消后重试。'
    } else if (report.state === 'cancelling') {
      operationState.textContent = '正在取消'
      operationSummary.textContent = '已请求取消；正在等待当前安全步骤结束。'
    } else if (report.state === 'succeeded') {
      operationState.textContent = '操作完成'
      const labels = {
        installed: '驱动已经安装并通过验证。',
        'already-current': '当前驱动已经是锁定版本。',
        repaired: '驱动已经修复并通过验证。',
        restarted: '驱动已经安全重启。',
        'lkg-restored': '新驱动未通过验证，已恢复上一可用版本。',
      } as const
      operationSummary.textContent = report.outcome ? labels[report.outcome] : '驱动操作已经完成。'
    } else if (report.state === 'cancelled') {
      operationState.textContent = '已取消'
      operationSummary.textContent = '驱动操作已取消，未继续执行后续步骤。'
    } else {
      operationState.textContent = '操作失败'
      operationSummary.textContent = '驱动准备或维护未完成。请检查网络或安装环境后重试。'
    }
    syncBusyControls()
    return terminal
  }

  const monitorOperation = async (operationId: string | undefined, current: number): Promise<void> => {
    for (let attempt = 0; attempt < operationMaxAttempts; attempt += 1) {
      await operationWait(operationIntervalMs)
      if (current !== operationGeneration) return
      try {
        const report = await client.call<ComputerUseOperationResult>(
          '_agnes/v1/computerUse.operation.status',
          operationId ? { operationId } : {},
        )
        if (current !== operationGeneration) return
        if (renderOperation(report)) {
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
        operationState.textContent = '无法读取进度'
        operationSummary.textContent = '驱动操作可能仍在后台执行，请稍后刷新进度。'
        syncBusyControls()
        return
      }
    }
    if (current !== operationGeneration) return
    operationState.textContent = '仍在执行'
    operationSummary.textContent = '等待时间较长，驱动操作仍可能在后台执行，请稍后刷新进度。'
    syncBusyControls()
  }

  const startOperation = async (kind: 'install' | 'update' | 'restart'): Promise<void> => {
    if (operationPending || (!driverReady && !(kind === 'install' && canPrepare))) return
    const current = ++operationGeneration
    operationPending = true
    activeOperationId = undefined
    operationState.textContent = '正在提交'
    operationSummary.textContent = '正在向本机 Host 提交驱动操作。'
    syncBusyControls()
    try {
      const report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.start', {
        kind,
      })
      if (current !== operationGeneration) return
      if (renderOperation(report) || report.status === 'not-found') return
      await monitorOperation(report.operationId, current)
    } catch {
      if (current !== operationGeneration) return
      operationPending = false
      operationState.textContent = '无法开始'
      operationSummary.textContent = '驱动操作没有开始，请确认本机 Host 正常运行。'
      syncBusyControls()
    }
  }

  const refreshOperation = async (): Promise<void> => {
    const current = ++operationGeneration
    operationRefresh.disabled = true
    operationState.textContent = '正在读取'
    operationSummary.textContent = '正在读取最近一次驱动操作。'
    try {
      const report = await client.call<ComputerUseOperationResult>(
        '_agnes/v1/computerUse.operation.status',
        activeOperationId ? { operationId: activeOperationId } : {},
      )
      if (current !== operationGeneration) return
      const terminal = renderOperation(report)
      if (!terminal && report.status === 'found') await monitorOperation(report.operationId, current)
      else {
        await load(false)
        if (current === operationGeneration && driverPreparing) await monitorOperation(undefined, current)
      }
    } catch {
      if (current !== operationGeneration) return
      operationState.textContent = '无法读取'
      operationSummary.textContent = operationPending
        ? '暂时无法读取进度；操作可能仍在后台执行。'
        : '暂时无法读取驱动操作进度。'
      syncBusyControls()
    } finally {
      if (current === operationGeneration) operationRefresh.disabled = false
    }
  }

  const cancelOperation = async (): Promise<void> => {
    if (!operationPending || !activeOperationId) return
    const operationId = activeOperationId
    const current = ++operationGeneration
    operationState.textContent = '正在取消'
    operationSummary.textContent = '正在请求本机 Host 停止驱动操作。'
    operationCancel.disabled = true
    try {
      const report = await client.call<ComputerUseOperationResult>('_agnes/v1/computerUse.operation.cancel', {
        operationId,
      })
      if (current !== operationGeneration) return
      if (!renderOperation(report) && report.status === 'found')
        await monitorOperation(report.operationId, current)
      else {
        await load(false)
        if (current === operationGeneration && driverPreparing) await monitorOperation(undefined, current)
      }
    } catch {
      if (current !== operationGeneration) return
      operationState.textContent = '取消失败'
      operationSummary.textContent = '无法确认取消结果，请刷新进度后再试。'
      syncBusyControls()
    }
  }

  const renderPermissions = (report: ComputerUsePermissionsStatusResult): void => {
    permissionGrant.hidden = true
    syncBusyControls()
    if (report.status === 'not-required') {
      permissionState.textContent = '无需系统授权'
      permissionSummary.textContent =
        report.admission.reason === 'linux-verified-driver'
          ? 'Linux 不使用 macOS 的辅助功能和录屏授权；桌面会话能力由驱动健康检查验证。'
          : 'Windows 无需额外的录屏或辅助功能授权。'
      return
    }
    if (report.status === 'granted') {
      permissionState.textContent = '已授权'
      permissionSummary.textContent = '辅助功能和屏幕录制均已授权。'
      return
    }
    if (report.status === 'required') {
      permissionState.textContent = '需要授权'
      const missing = [
        report.probe.accessibility ? undefined : '辅助功能',
        report.probe.screenRecording ? undefined : '屏幕录制',
      ].filter((value): value is string => value !== undefined)
      permissionSummary.textContent = `macOS 仍需授权：${missing.join('、')}。点击后由系统设置窗口完成。`
      permissionGrant.hidden = false
      return
    }
    if (report.status === 'unknown') {
      permissionState.textContent = '无法确认'
      permissionSummary.textContent = '无法从已验签驱动读取 macOS 权限，请刷新后重试。'
      return
    }
    permissionState.textContent = '不可用'
    permissionSummary.textContent = '生产驱动尚未通过准入，未检查系统权限。'
  }

  const unavailablePermissions = (): void => {
    permissionState.textContent = '无法读取'
    permissionSummary.textContent = '暂时无法读取系统权限；没有发起授权。'
    permissionGrant.hidden = true
    syncBusyControls()
  }

  const load = async (discoverOperation = true): Promise<void> => {
    const current = ++generation
    const permissionCurrent = ++permissionGeneration
    statusPending = true
    syncBusyControls()
    state.textContent = '正在检查'
    summary.textContent = '正在读取本机 Computer Use 安全门状态。'
    runtime.textContent = ''
    blockers.replaceChildren()
    try {
      const report = await client.call<ComputerUseStatusResult>('_agnes/v1/computerUse.status', {})
      if (current !== generation) return
      driverPreparing = report.status === 'blocked' && report.blockers.includes('driver-preparing')
      if (report.status === 'ready') {
        driverReady = true
        state.textContent = report.runtime.state === 'running' ? '运行中' : '可用'
        const platform =
          report.driver.platform === 'darwin'
            ? 'macOS'
            : report.driver.platform === 'linux'
              ? 'Linux'
              : 'Windows'
        summary.textContent = `${platform} 驱动 ${report.driver.version} 已就绪。请在对话中使用支持图片的模型操作电脑。`
        runtime.textContent =
          report.runtime.state === 'running'
            ? `运行时：${report.runtime.activeSessions} 个活动会话`
            : report.runtime.startAttempted
              ? '运行时：当前空闲，之前已启动过'
              : '运行时：已就绪，尚未启动会话'
        blockers.replaceChildren()
        try {
          const permissions = await client.call<ComputerUsePermissionsStatusResult>(
            '_agnes/v1/computerUse.permissions.status',
            {},
          )
          if (current !== generation || permissionCurrent !== permissionGeneration) return
          renderPermissions(permissions)
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
        state.textContent =
          reason === 'feature-disabled'
            ? '已关闭'
            : reason === 'platform-unsupported'
              ? '暂不支持'
              : reason === 'driver-preparing'
                ? '准备中'
                : reason === 'driver-prepare-failed'
                  ? '准备失败'
                  : '首次使用自动准备'
        summary.textContent = reason ? BLOCKER_LABELS[reason] : '请刷新状态后重试。'
        runtime.textContent = '电脑操作需要支持图片的模型；普通聊天不受影响。'
        permissionState.textContent = '等待驱动就绪'
        permissionSummary.textContent = '驱动就绪后显示当前系统所需的权限。'
        permissionGrant.hidden = true
        if (driverPreparing && discoverOperation && !operationPending) void refreshOperation()
        return
      }
      state.textContent = '已阻止'
      summary.textContent = '当前平台的生产驱动准入保持关闭。'
      runtime.textContent = '运行时：未启动，且未尝试启动'
      blockers.replaceChildren(
        ...report.blockers.map((blocker) => {
          const item = document.createElement('li')
          item.textContent = BLOCKER_LABELS[blocker]
          return item
        }),
      )
      if (permissionCurrent === permissionGeneration)
        renderPermissions({
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
      state.textContent = '无法读取'
      summary.textContent = '暂时无法读取 Computer Use 状态；未执行任何驱动操作。'
      runtime.textContent = ''
      blockers.replaceChildren()
      if (permissionCurrent === permissionGeneration) unavailablePermissions()
    } finally {
      if (current === generation) {
        statusPending = false
        syncBusyControls()
      }
    }
  }

  const grantPermissions = async (): Promise<void> => {
    const current = ++permissionGeneration
    const grantCurrent = ++grantGeneration
    grantPending = true
    syncBusyControls()
    permissionState.textContent = '等待系统授权'
    permissionSummary.textContent = '请在 macOS 系统界面完成辅助功能和屏幕录制授权。'
    try {
      const report = await client.call<ComputerUsePermissionsStatusResult>(
        '_agnes/v1/computerUse.permissions.grant',
        {},
      )
      if (current !== permissionGeneration) return
      renderPermissions(report)
    } catch {
      if (current !== permissionGeneration) return
      permissionState.textContent = '授权未完成'
      permissionSummary.textContent = '系统授权未完成或无法验证，请检查系统设置后刷新。'
      permissionGrant.hidden = false
    } finally {
      if (grantCurrent === grantGeneration) {
        grantPending = false
        syncBusyControls()
      }
    }
  }

  const doctor = async (): Promise<void> => {
    const current = ++doctorGeneration
    doctorRun.disabled = true
    doctorState.textContent = '正在检查'
    doctorSummary.textContent = '正在验证驱动健康状态和签名身份。'
    try {
      const report = await client.call<ComputerUseDoctorResult>('_agnes/v1/computerUse.doctor', {})
      if (current !== doctorGeneration) return
      if (report.status === 'ready') {
        doctorState.textContent = '检查通过'
        doctorSummary.textContent =
          report.admission.reason === 'macos-verified-driver'
            ? 'macOS 驱动健康状态和签名身份均已验证。'
            : report.admission.reason === 'linux-verified-driver'
              ? 'Linux 驱动健康状态、来源身份和桌面会话均已验证。'
              : 'Windows 驱动健康状态和签名身份均已验证。'
        return
      }
      if (report.status === 'failed') {
        doctorState.textContent = '检查失败'
        doctorSummary.textContent = '驱动健康状态或签名身份已经变化，请修复或重新安装后再试。'
        return
      }
      if (report.status === 'unreachable') {
        doctorState.textContent = '无法连接'
        doctorSummary.textContent = '实时驱动诊断入口不可用，请重新启动或修复驱动。'
        return
      }
      doctorState.textContent = '未执行'
      doctorSummary.textContent = '生产驱动尚未通过准入，无法执行健康检查。'
    } catch {
      if (current !== doctorGeneration) return
      doctorState.textContent = '检查失败'
      doctorSummary.textContent = '暂时无法完成健康检查；没有启动或修复驱动。'
    } finally {
      if (current === doctorGeneration) doctorRun.disabled = false
    }
  }

  syncBusyControls()
  return {
    dispose() {
      generation += 1
      permissionGeneration += 1
      doctorGeneration += 1
      grantGeneration += 1
      operationGeneration += 1
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
