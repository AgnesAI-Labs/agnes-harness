import {
  fallbackT,
  type LocaleCatalog,
  reportSuccess,
  SettingsBlock,
  SettingsItem,
  StateSwitch,
  setResource,
  useAutosave,
  useResource,
  useUiText,
} from '@agnes/web-ui'
import { canEditPrompt, useCanSave, useVisits } from './prompt-config.js'
import { telemetryRequest } from './telemetry-api.js'

const KEY = 'settings:telemetry'
const catalog: LocaleCatalog = {
  en: {
    upload: 'Upload Session Log when using model APIs',
    description: 'Help improve Agnes models and products',
  },
  'zh-CN': {
    upload: '在使用模型API时上传Session Log',
    description: '帮助改进Agnes模型与产品',
  },
}

export function TelemetrySettingsPanel({
  permission = canEditPrompt,
}: {
  permission?: () => Promise<boolean>
}) {
  const [ref, visits] = useVisits()
  const canSave = useCanSave(visits > 0, permission)
  const { t } = useUiText('@agnes/web/telemetry', catalog)
  return (
    <div ref={ref} id="settings-subsection-telemetry" data-testid="telemetry-settings">
      {visits > 0 && (
        <TelemetrySwitch key={visits} canSave={canSave} label={t('upload')} description={t('description')} />
      )}
    </div>
  )
}

function TelemetrySwitch({
  canSave,
  label,
  description,
}: {
  canSave: boolean
  label: string
  description: string
}) {
  const { data, loading, error, reload } = useResource(KEY, () => telemetryRequest())
  const field = useAutosave<boolean>({
    resourceKey: KEY,
    stored: data?.settings.traceUploadEnabled,
    onSaved: () => reportSuccess(KEY, fallbackT('ui.settingsSaved')),
    save: async (traceUploadEnabled) => {
      const saved = await telemetryRequest({ settings: { traceUploadEnabled } })
      setResource(KEY, saved)
    },
  })
  const disabled = !canSave || !data || data.status.disabledByEnv || field.busy
  return (
    <SettingsBlock
      aria-busy={loading || field.busy}
      failed={field.failed}
      onRetry={disabled ? undefined : field.retry}
      state={error && !data ? 'error' : undefined}
      onReload={reload}
    >
      <SettingsItem label={label} description={<span id="telemetry-trace-description">{description}</span>}>
        <StateSwitch
          id="telemetry-trace-upload"
          testId="telemetry-trace-upload"
          label={label}
          describedBy="telemetry-trace-description"
          checked={field.value ?? true}
          disabled={disabled}
          onToggle={(next) => field.set(next, 'now')}
        />
      </SettingsItem>
    </SettingsBlock>
  )
}
