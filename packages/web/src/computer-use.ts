import {
  type ComputerUseOperationPolling,
  type ComputerUseSnapshot,
  type ComputerUseStatusClient,
  type ComputerUseStatusController,
  createComputerUseState,
} from './computer-use-state.js'

export type {
  ComputerUseOperationPolling,
  ComputerUseStatusClient,
  ComputerUseStatusController,
} from './computer-use-state.js'

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
      if (disposed) return
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
  const model = createComputerUseState(client, polling)
  const renderControls = (view: ComputerUseSnapshot): void => {
    refresh.disabled = view.controls.refreshDisabled
    permissionGrant.disabled = view.controls.grantDisabled
    permissionGrant.hidden = view.permissions.grantHidden
    doctorRun.disabled = view.controls.doctorDisabled
    operationInstall.disabled = view.controls.installDisabled
    operationUpdate.disabled = view.controls.updateDisabled
    operationRestart.disabled = view.controls.restartDisabled
    operationRefresh.disabled = view.controls.operationRefreshDisabled
    operationCancel.disabled = view.controls.cancelDisabled
    operationCancel.hidden = view.controls.cancelHidden
  }
  const paint = (): void => {
    const view = model.getSnapshot()
    state.textContent = view.status.label
    summary.textContent = view.status.summary
    runtime.textContent = view.status.runtime
    if (
      JSON.stringify([...blockers.children].map((item) => item.textContent)) !==
      JSON.stringify(view.status.blockers)
    ) {
      blockers.replaceChildren(
        ...view.status.blockers.map((text) => {
          const item = document.createElement('li')
          item.textContent = text
          return item
        }),
      )
    }
    permissionState.textContent = view.permissions.label
    permissionSummary.textContent = view.permissions.summary
    doctorState.textContent = view.doctor.label
    doctorSummary.textContent = view.doctor.summary
    operationState.textContent = view.operation.label
    operationSummary.textContent = view.operation.summary
    renderControls(view)
  }
  paint()
  const unsubscribe = model.subscribe(paint)
  return {
    ...model,
    dispose() {
      unsubscribe()
      model.dispose()
    },
  }
}
