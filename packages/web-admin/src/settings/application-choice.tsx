import type { ApplicationState } from '@agnes/protocol'
import { resolveApplicationBrand } from '@agnes/web-client'
import { Button, SettingsItem, scopedResourceKey, useDocumentLanguage, useResource } from '@agnes/web-ui'
import type { PluginAdminApi } from '../admin/plugins/api.js'

/** A declared human name is read before presenting the app as a choice. */
export function ApplicationChoice({
  api,
  candidate,
  state,
  disabled,
  onPreview,
}: {
  api: PluginAdminApi | undefined
  candidate: ApplicationState['candidates'][number]
  state: ApplicationState
  disabled: boolean
  onPreview(): void
}) {
  const language = useDocumentLanguage()
  const tr = (en: string, zh: string) => (language === 'zh-CN' ? zh : en)
  const preview = useResource(
    api && candidate.available
      ? scopedResourceKey(
          api,
          `application-name:${candidate.packageId}:${candidate.version}:${state.revision}`,
        )
      : undefined,
    async () => {
      if (!api) throw new Error('Admin unavailable')
      return api.previewApplication(candidate.packageId)
    },
  )
  const declaration =
    preview.data?.declaration ??
    (state.selection?.packageId === candidate.packageId ? state.effective : undefined)
  return (
    <SettingsItem
      data-testid="application-choice"
      data-loading={!declaration && preview.loading}
      icon="puzzle"
      label={
        <>
          {declaration
            ? resolveApplicationBrand(declaration, language).name
            : preview.error || !candidate.available
              ? tr('Application unavailable', '应用暂不可用')
              : tr('Loading application…', '正在读取应用名称…')}
          <span className="application-version">{candidate.version}</span>
        </>
      }
      description={tr('Preview its changes before adopting.', '预览界面变化，再决定是否采用。')}
    >
      <Button disabled={disabled || !candidate.available || !declaration} onClick={onPreview}>
        {tr('Preview', '预览')}
      </Button>
    </SettingsItem>
  )
}
