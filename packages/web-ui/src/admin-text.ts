import type {
  PackageBlocker,
  PackageInstalledDescriptor,
  PackageOperation,
  PackagePreview,
} from '@agnes/protocol'

/**
 * 浏览器 UI 运行状态的展示视图。结构与 web 包的 PluginRuntimeState 保持结构化等价
 * （phase/packageId/revision/error.message），组件层不 import web 包。
 */
export type RuntimeStateView = Readonly<{
  packageId: string
  revision: string | undefined
  phase: 'idle' | 'loading' | 'active' | 'stopping' | 'failed'
  error?: Readonly<{ message: string }>
}>

export function hasPermission(permissions: readonly string[], permission: string): boolean {
  return permissions.includes(permission)
}

export function sourceLabel(source: { type: string; ref: string }): string {
  return `${source.type} · ${source.ref}`
}

export function contributionText(item: { contributions: readonly { kind: string; id: string }[] }): string {
  if (!item.contributions.length) return '未报告贡献'
  const labels = item.contributions
    .slice(0, 3)
    .map((contribution) => `${contribution.kind} · ${contribution.id}`)
  return `${labels.join('，')}${item.contributions.length > labels.length ? `，另有 ${item.contributions.length - labels.length} 项` : ''}`
}

export function integrityLabel(integrity: string): string {
  return integrity.length > 27 ? `${integrity.slice(0, 14)}…${integrity.slice(-12)}` : integrity
}

export function installedState(
  item: PackageInstalledDescriptor,
  effectiveActual: PackageInstalledDescriptor['actual'] = item.actual,
): string {
  const trust = item.trusted ? '已信任' : '未信任'
  const desired = item.desired === 'enabled' ? '期望启用' : '期望停用'
  const actual: Record<PackageInstalledDescriptor['actual'], string> = {
    'not-running': '未运行',
    starting: '正在启动',
    running: '运行中',
    failed: '运行失败',
    'restart-required': '需要重启',
    unavailable: '不可用',
  }
  const cleanup = item.cleanupPending ? ' · 旧资源待清理' : ''
  return `${trust} · ${desired} · ${actual[effectiveActual]}${cleanup}`
}

export function actualIdentity(item: PackageInstalledDescriptor): string {
  if (item.actualVersion && item.actualIntegrity)
    return `${item.actualVersion} · ${integrityLabel(item.actualIntegrity)}`
  if (item.actual === 'not-running') return '未运行'
  return '后台未确认实际版本或摘要'
}

export function runtimeStateLabel(state: RuntimeStateView | undefined): string {
  if (!state) return '未确认'
  return {
    idle: '未加载',
    loading: '正在加载',
    active: '已加载',
    stopping: '正在停用',
    failed: '加载失败，可重试',
  }[state.phase]
}

export function runtimeStateMessage(state: RuntimeStateView | undefined): string {
  if (!state) return '浏览器 UI 状态将在工作台打开后确认。'
  if (state.phase === 'failed') return 'Agnes 原界面保持可用，可重试。'
  return runtimeStateLabel(state)
}

export function operationLabel(operation: PackageOperation): string {
  const state: Record<PackageOperation['state'], string> = {
    received: '请求已记录',
    inspecting: '正在检查内容',
    installing: '正在安装',
    staging: '正在准备切换',
    quiescing: '正在等待安全边界',
    switching: '正在切换',
    draining: '正在排干旧版本',
    completed: '已完成',
    failed: '未完成',
    cancelled: '已取消',
    'rolled-back': '已回滚',
  }
  return `${operationName(operation.operation)}：${state[operation.state]}`
}

export function operationName(operation: PackageOperation['operation']): string {
  return {
    inspect: '预览',
    install: '安装',
    trust: '信任',
    untrust: '撤销信任',
    enable: '启用',
    disable: '停用',
    update: '更新',
    rollback: '回滚',
    remove: '卸载',
  }[operation]
}

export function terminal(operation: PackageOperation): boolean {
  return ['completed', 'failed', 'cancelled', 'rolled-back'].includes(operation.state)
}

export function blockerText(blocker: PackageBlocker): string {
  const name: Record<PackageBlocker['code'], string> = {
    dependency: '依赖关系',
    profile: 'Profile 配置',
    generation: '运行代际',
    deployment: '部署引用',
    policy: '安全策略',
    incompatible: '兼容性',
    'unknown-contribution': '未知贡献',
  }
  const references = blocker.references.length ? `：${blocker.references.join('、')}` : ''
  return `${name[blocker.code]}阻止此操作${references}`
}

export function capabilitySummary(preview: PackagePreview): string {
  const diff = preview.capabilityDiff
  const changes = [
    ...diff.added.map((item) => `新增 ${item}`),
    ...diff.removed.map((item) => `移除 ${item}`),
    ...diff.runtimeSupportRemoved.map((item) => `不再支持 ${item}`),
    ...diff.dependenciesAdded.map((item) => `新增依赖 ${item}`),
    ...diff.serviceGrantsAdded.map((item) => `新增服务授权 ${item.extension} · ${item.name} · ${item.range}`),
  ]
  return changes.length
    ? changes.join('；')
    : '后台未报告相对于当前基线的能力差异；这不表示这个包不包含能力。'
}
