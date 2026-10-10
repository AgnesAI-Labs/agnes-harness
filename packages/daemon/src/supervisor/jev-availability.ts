import type { JevConfigSnapshot, RuntimeDescriptor } from '@agnes/protocol'

/** Saved settings explain pending activation, never change the worker's actual availability. */
export function withPendingJevConfiguration(
  items: RuntimeDescriptor[],
  saved: JevConfigSnapshot | undefined,
): RuntimeDescriptor[] {
  if (!saved?.configured || saved.effect !== 'restart-required') return items
  const label = saved.settings?.backend === 'laya' ? 'Laya' : 'Jev'
  const unavailableReason =
    saved.source === 'environment'
      ? `${label} 配置已保存，但环境变量正在覆盖该配置；请检查环境配置后重启后台。`
      : `${label} 配置已保存，需重启后台后生效。`
  return items.map((item) =>
    item.id === 'jevloop' && !item.available ? { ...item, unavailableReason } : item,
  )
}
