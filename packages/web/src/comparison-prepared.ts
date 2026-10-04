import type { ComparisonPreparedReceipt } from '@agnes/protocol'

/** Historical producer evidence only; this renderer never reads the current profile or preset. */
export function renderComparisonPrepared(
  host: HTMLElement,
  receipt: ComparisonPreparedReceipt | null | undefined,
): void {
  if (!receipt) {
    const unknown = document.createElement('p')
    unknown.textContent = '准备配置：未知（此前缀无可信冻结回执；不以当前配置补历史）'
    host.append(unknown)
    return
  }
  const details = document.createElement('details')
  details.className = 'comparison-prepared'
  const summary = document.createElement('summary')
  const { effective, runtime, runtimeConfig, fingerprints } = receipt.configuration
  summary.textContent = `准备配置 · ${effective.preset.name} · ${runtime.id}@${runtime.version} · 源 #${receipt.sourceSeq}`
  const note = document.createElement('p')
  note.textContent =
    '冻结自会话实际状态。预设指纹覆盖已解析的执行设置。' +
    (effective.mounted
      ? '挂载配置指纹覆盖当时已生效的插件及选中预设。'
      : '挂载配置：未知（此回执无可信挂载证据）。') +
    '工具指纹覆盖已注册定义，具体模型可见工具仍受能力过滤。'
  const list = document.createElement('dl')
  const row = (name: string, value: string) => {
    const key = document.createElement('dt')
    const text = document.createElement('dd')
    key.textContent = name
    text.textContent = value
    list.append(key, text)
  }
  for (const model of effective.models)
    row(
      `模型 ${model.slot}`,
      `${model.route ?? '未知路由'} / ${model.model ?? '未知模型'} · thinking ${model.thinking ?? '未知'} · 上下文 ${model.contextWindow ?? '未知'} · 预设输出上限 ${model.maxTokens === undefined ? '未知（旧回执未记录）' : model.slot !== 'primary' ? '未独立配置' : model.maxTokens === null ? '未设置覆盖值' : model.maxTokens}`,
    )
  row('实际审批模式', effective.permission.approvalMode ?? '未知')
  row('YOLO', effective.permission.yolo ? '启用' : '关闭')
  row(
    '隔离强度',
    effective.permission.enforcement
      ? `${effective.permission.enforcement.level} · ${effective.permission.enforcement.scope.join(' / ')}`
      : '未知',
  )
  row('已注册工具', String(effective.tools.count))
  if (effective.mounted) row('已生效配置项', String(effective.mounted.count))
  if (runtimeConfig) {
    row(
      '决策连接',
      `${runtimeConfig.decision.backend} · ${runtimeConfig.decision.endpoint} · ${runtimeConfig.decision.model}`,
    )
    row('冻结运行设置', JSON.stringify(runtimeConfig.config))
  } else row('运行专用配置', runtime.id === 'native' ? '无（Native）' : '未知')
  for (const [name, value] of Object.entries(fingerprints)) row(`指纹 ${name}`, value ?? '未知')
  row('源事件摘要', receipt.sourceDigest)
  row('实际权限策略摘要', effective.permission.policyDigest ?? '未知')
  details.append(summary, note, list)
  host.append(details)
}
