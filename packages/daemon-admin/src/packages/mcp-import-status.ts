import type { PackageListResult } from '@agnes/protocol'

type Package = NonNullable<PackageListResult['externalPackages']>[number]
type Status = NonNullable<Package['primaryStatus']>

/** Desired, trust and actual remain owned by each resource; the package only summarizes them. */
export function summarizeMcpPackage(item: Package): Pick<Package, 'desired' | 'primaryStatus'> {
  const rows = item.resources.filter((row) => row.state !== 'removed')
  const enabled = rows.filter((row) => row.desired === 'enabled').length
  const desired: NonNullable<Package['desired']> =
    enabled === 0 ? 'disabled' : enabled === rows.length ? 'enabled' : 'mixed'
  const status = (
    state: Status['state'],
    reasonCode: Status['reasonCode'],
    en: string,
    zh: string,
    nextAction: Status['nextAction'] = 'none',
  ) => ({ desired, primaryStatus: { state, reasonCode, reason: { en, 'zh-CN': zh }, nextAction } })
  if (item.result.state === 'running')
    return status('blocked', 'starting', 'Applying the package operation.', '正在处理插件操作。')
  const ready = rows.filter(
    (row) =>
      row.state === 'present' &&
      row.trust === 'trusted' &&
      row.desired === 'enabled' &&
      row.actual === 'ready',
  ).length
  if (
    item.result.phase === 'partially-disabled' &&
    rows.some((row) => row.state !== 'present' || row.desired !== 'disabled' || row.actual !== 'disabled')
  )
    return status(
      'blocked',
      'activation-failed',
      'Partially disabled. Review the remaining capabilities.',
      '部分停用，请检查未完成停用的能力。',
      'enable',
    )
  if (item.result.phase === 'enable-failed' && ready === 0)
    return status(
      'blocked',
      'activation-failed',
      'Enable failed. Review individual capability results.',
      '启用失败，请查看各项能力的结果。',
      'enable',
    )
  if (ready > 0 && ready < rows.length)
    return status(
      'blocked',
      'activation-failed',
      `Partially enabled: ${ready}/${rows.length} capabilities ready. Review individual results.`,
      `部分启用：${ready}/${rows.length} 项能力已就绪，请查看各项结果。`,
      'enable',
    )
  if (!rows.length || rows.some((row) => row.state !== 'present'))
    return status(
      'blocked',
      'observation-unavailable',
      'Some capabilities were changed, removed or could not be verified.',
      '部分能力已修改、移除或暂无法核对。',
    )
  if (desired === 'mixed')
    return status(
      'blocked',
      'activation-failed',
      'Partially enabled. Review individual capabilities.',
      '部分启用，请检查各项能力。',
      'enable',
    )
  if (rows.some((row) => row.trust !== 'trusted'))
    return status(
      'untrusted',
      'trust-required',
      'Review trust before enabling this package.',
      '请审阅信任后启用插件。',
      'trust',
    )
  if (desired === 'disabled')
    return status(
      'disabled',
      'disabled',
      'The installed capabilities are disabled.',
      '已安装的能力均已停用。',
      'enable',
    )
  if (rows.every((row) => row.actual === 'ready'))
    return status('ready', 'ready', 'All installed capabilities are ready.', '已安装的能力均已就绪。')
  if (rows.some((row) => row.actual === 'unavailable' || row.actual === 'degraded'))
    return status(
      'blocked',
      'activation-failed',
      'Some capabilities failed to become available.',
      '部分能力未能正常运行，请查看详情。',
    )
  return status(
    'blocked',
    'starting',
    'Enabled; waiting for capability readiness.',
    '已启用，正在等待各项能力就绪。',
  )
}
