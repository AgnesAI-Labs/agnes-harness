import type { PackageInstalledDescriptor, PluginGenerationStatus } from '@agnes/protocol'

type Status = NonNullable<PackageInstalledDescriptor['primaryStatus']>
type Generation = PluginGenerationStatus['plugins'][number]
const status = (
  state: Status['state'],
  reasonCode: Status['reasonCode'],
  nextAction: Status['nextAction'],
  en: string,
  zh: string,
): Status => ({ state, reasonCode, nextAction, reason: { en, 'zh-CN': zh } })

/** Backend read projection only: no lifecycle, authorization or pin decisions change here. */
export function projectPluginPrimaryStatus(
  item: PackageInstalledDescriptor,
  generation?: Generation,
): Status {
  // Trust revocation wins even while a previously loaded generation is retained.
  if (!item.trusted)
    return status(
      'untrusted',
      'trust-required',
      'trust',
      'Review and trust this plugin before use.',
      '使用前请审阅并信任此插件。',
    )
  if (item.actual === 'restart-required' || generation?.state === 'restart-required')
    return status(
      'restart-required',
      'restart-required',
      'restart',
      'Restart the service to apply the requested change.',
      '重启服务后，请求的变更才会生效。',
    )
  if (item.desired !== 'enabled') {
    if (item.draining || (generation?.drainingSessions ?? 0) > 0 || generation?.state === 'historical')
      return status(
        'historical-only',
        'historical-only',
        'enable',
        'Disabled for new sessions; only existing session versions are retained.',
        '已对新会话停用，仅保留已有会话使用的版本。',
      )
    return status('disabled', 'disabled', 'enable', 'Disabled for new sessions.', '已对新会话停用。')
  }
  if (
    item.blockers.some((blocker) => blocker.code === 'dependency') ||
    item.actualReason === 'A required plugin service is missing.'
  )
    return status(
      'blocked',
      'dependency-missing',
      'install-dependency',
      'Install and enable the required provider plugin.',
      '请安装并启用所需的依赖插件。',
    )
  if (item.blockers.length)
    return status(
      'blocked',
      'policy-blocked',
      'none',
      'Review the blockers in plugin details.',
      '请在插件详情中检查阻碍原因。',
    )
  if (item.actual === 'failed' || generation?.state === 'failed')
    return status(
      'blocked',
      'activation-failed',
      'none',
      'Activation failed. Review the failure details.',
      '启用失败，请检查失败详情。',
    )
  if (
    item.actual !== 'running' &&
    item.actual !== 'unavailable' &&
    (item.draining || (generation?.drainingSessions ?? 0) > 0 || generation?.state === 'historical')
  )
    return status(
      'historical-only',
      'historical-only',
      'none',
      'Only existing session versions are available; new sessions are not ready.',
      '仅已有会话的版本可用，新会话尚未就绪。',
    )
  if (
    item.actual === 'running' &&
    ((item.actualVersion !== undefined && item.actualVersion !== item.version) ||
      (item.actualIntegrity !== undefined && item.actualIntegrity !== item.integrity))
  )
    return status(
      'blocked',
      'not-running',
      'none',
      'The installed version is not yet active for new sessions.',
      '已安装版本尚未对新会话生效。',
    )
  if (item.actual === 'running')
    return item.draining
      ? status(
          'ready',
          'ready-with-history',
          'none',
          'Ready for new sessions; existing sessions retain their versions.',
          '新会话可用，已有会话继续保留各自版本。',
        )
      : status('ready', 'ready', 'none', 'Available for new sessions.', '新会话可用。')
  if (item.actual === 'starting')
    return status('blocked', 'starting', 'none', 'Activation is still in progress.', '正在启用，尚未就绪。')
  if (item.actual === 'unavailable')
    return status(
      'blocked',
      'observation-unavailable',
      'none',
      'Runtime status has not been confirmed.',
      '运行状态尚未确认。',
    )
  return status(
    'blocked',
    'not-running',
    'none',
    'Enabled in configuration, but not running. Start a session when needed.',
    '配置中已启用，当前未运行，需要时请启动会话。',
  )
}

/** Preserve the generation owner's existing dimension projection before deriving the primary state. */
export function projectPluginReadStatus(
  item: PackageInstalledDescriptor,
  generation?: Generation,
): PackageInstalledDescriptor {
  const projected: PackageInstalledDescriptor = {
    ...item,
    ...(generation
      ? {
          boundSessions: generation.boundSessions,
          drainingSessions: generation.drainingSessions,
          draining: generation.drainingSessions > 0,
          ...(generation.state === 'restart-required' ? { actual: 'restart-required' as const } : {}),
        }
      : {}),
  }
  return { ...projected, primaryStatus: projectPluginPrimaryStatus(projected, generation) }
}
