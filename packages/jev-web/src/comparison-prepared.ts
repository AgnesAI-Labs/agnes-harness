import type { ComparisonPreparedReceipt } from '@agnes/protocol'
import type { Translate } from './jev-locale.js'

/** Historical producer evidence only; this renderer never reads the current profile or preset. */
export function renderComparisonPrepared(
  host: HTMLElement,
  receipt: ComparisonPreparedReceipt | null | undefined,
  t: Translate,
): void {
  if (!receipt) {
    const unknown = document.createElement('p')
    unknown.textContent = t('prepared.noReceipt')
    host.append(unknown)
    return
  }
  const details = document.createElement('details')
  details.className = 'comparison-prepared'
  const summary = document.createElement('summary')
  const { effective, runtime, runtimeConfig, fingerprints } = receipt.configuration
  summary.textContent = t('prepared.summary', {
    preset: effective.preset.name,
    runtime: `${runtime.id}@${runtime.version}`,
    seq: receipt.sourceSeq,
  })
  const note = document.createElement('p')
  note.textContent = t('prepared.note', {
    mounted: effective.mounted ? t('prepared.note.mounted') : t('prepared.note.mountUnknown'),
  })
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
      t('prepared.model', { slot: model.slot }),
      t('prepared.modelValue', {
        route: model.route ?? t('prepared.unknownRoute'),
        model: model.model ?? t('prepared.unknownModel'),
        thinking: model.thinking ?? t('prepared.unknown'),
        context: model.contextWindow ?? t('prepared.unknown'),
        limit:
          model.maxTokens === undefined
            ? t('prepared.limit.unrecorded')
            : model.slot !== 'primary'
              ? t('prepared.limit.unconfigured')
              : model.maxTokens === null
                ? t('prepared.limit.noOverride')
                : model.maxTokens,
      }),
    )
  row(t('prepared.approvalMode'), effective.permission.approvalMode ?? t('prepared.unknown'))
  row(t('prepared.yolo'), effective.permission.yolo ? t('prepared.enabled') : t('prepared.disabled'))
  row(
    t('prepared.isolation'),
    effective.permission.enforcement
      ? `${effective.permission.enforcement.level} · ${effective.permission.enforcement.scope.join(' / ')}`
      : t('prepared.unknown'),
  )
  row(t('prepared.registeredTools'), String(effective.tools.count))
  if (effective.mounted) row(t('prepared.mountedCount'), String(effective.mounted.count))
  if (runtimeConfig) {
    row(
      t('prepared.decisionConnection'),
      `${runtimeConfig.decision.backend} · ${runtimeConfig.decision.endpoint} · ${runtimeConfig.decision.model}`,
    )
    row(t('prepared.frozenRuntime'), JSON.stringify(runtimeConfig.config))
  } else
    row(
      t('prepared.runtimeConfig'),
      runtime.id === 'native' ? t('prepared.runtimeConfigNone') : t('prepared.unknown'),
    )
  for (const [name, value] of Object.entries(fingerprints))
    row(t('prepared.fingerprint', { name }), value ?? t('prepared.unknown'))
  row(t('prepared.sourceDigest'), receipt.sourceDigest)
  row(t('prepared.policyDigest'), effective.permission.policyDigest ?? t('prepared.unknown'))
  details.append(summary, note, list)
  host.append(details)
}
