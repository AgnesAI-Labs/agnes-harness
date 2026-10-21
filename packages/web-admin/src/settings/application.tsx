import type { ApplicationPreview, ApplicationState } from '@agnes/protocol'
import {
  Button,
  Icon,
  SettingsBlock,
  SettingsGroup,
  SettingsPageDescription,
  SettingsSection,
  SettingsTechnicalDetails,
  scopedResourceKey,
  setResource,
  useDocumentLanguage,
  useResource,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { ApplicationChoice } from './application-choice.js'
import { ApplicationPreviewSummary } from './application-preview.js'
import { ApplicationSummary } from './application-summary.js'
import { captureRequest, useRequestScope } from './async-request.js'
import { InterfaceImplementations } from './interface-implementations.js'

const clearCommand = 'agh app clear'

/** Minimal application settings. Backend owns preview validation and compare-and-swap. */
export function ApplicationPanel({ api, canSave }: { api?: PluginAdminApi | undefined; canSave: boolean }) {
  const language = useDocumentLanguage()
  const tr = useCallback((en: string, zh: string) => (language === 'zh-CN' ? zh : en), [language])
  const resourceKey = api ? scopedResourceKey(api, 'settings:application') : undefined
  const resource = useResource(resourceKey, async () => {
    if (!api) throw new Error('Admin unavailable')
    return api.application()
  })
  const state = resource.data
  const lifetime = useRequestScope(api, `${canSave}:${state?.revision}`)
  const setState = (next: ApplicationState) => {
    if (resourceKey) setResource(resourceKey, next)
  }
  const [preview, setPreview] = useState<ApplicationPreview>()
  const previewRef = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The review opens below the candidate list; bring it into view the way the dialog it replaced did.
  useEffect(() => {
    if (preview) previewRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [preview])
  const refresh = resource.reload
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    setBusy(false)
    setPreview(undefined)
  }, [api, canSave, state?.revision])
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection and permission changes reset diagnostics.
  useEffect(() => setError(''), [api, canSave])
  useEffect(() => {
    if (!api) return
    // Host daemon notices and completed plugin-admin operations already publish these hints.
    // Re-read the authoritative candidates; an event itself never supplies trusted data.
    const invalidate = () => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    const events = ['agnes:plugins-invalidated', 'agnes:packages-changed']
    for (const event of events) window.addEventListener(event, invalidate)
    return () => {
      for (const event of events) window.removeEventListener(event, invalidate)
    }
  }, [api, refresh])
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (busy) return
    const { isCurrent } = captureRequest(lifetime)
    setBusy(true)
    setError('')
    try {
      await action(isCurrent)
    } catch {
      if (!isCurrent()) return
      setError(
        tr(
          'The application changed or is unavailable. Reload, preview and confirm again.',
          '应用已变更或不可用，请重新加载、预览并确认。',
        ),
      )
      refresh()
      setPreview(undefined)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  return (
    <>
      <SettingsPageDescription>
        {tr(
          'An application changes the name, home page, navigation and available agents. Existing conversations keep their settings.',
          '应用会改变名称、首页、导航和可选智能体。已有对话保留原来的运行设置。',
        )}
      </SettingsPageDescription>
      <div className="application-settings">
        {!state && <SettingsBlock state={error || resource.error ? 'error' : 'loading'} onReload={refresh} />}
        {error && state && <p role="alert">{error}</p>}
        {!!resource.error && state && (
          <p role="alert">{tr('Could not refresh applications. Retry.', '无法刷新应用，请重试。')}</p>
        )}
        {state && (
          <ApplicationSummary
            state={state}
            restore={
              <Button
                appearance="primary"
                disabled={
                  busy ||
                  resource.loading ||
                  !canSave ||
                  (!state.selection && !Object.keys(state.roleSelections ?? {}).length)
                }
                onClick={() =>
                  void run(async (current) => {
                    if (!api) return
                    await api.clearApplication(state.revision)
                    if (current()) location.reload()
                  })
                }
              >
                {tr('Restore official interface', '恢复官方界面')}
              </Button>
            }
          />
        )}
        <SettingsSection
          title={tr('Available applications', '可选应用')}
          actions={
            <Button
              appearance="ghost"
              size="small"
              icon={<Icon name="refresh-cw" />}
              disabled={!api || busy || resource.loading}
              onClick={refresh}
            >
              {tr('Refresh', '刷新')}
            </Button>
          }
        >
          {state?.candidates.length ? (
            <SettingsGroup>
              {state.candidates.map((candidate) => (
                <ApplicationChoice
                  key={candidate.packageId}
                  api={api}
                  state={state}
                  candidate={candidate}
                  disabled={busy || resource.loading || !canSave}
                  onPreview={() =>
                    void run(async (current) => {
                      if (!api) return
                      const preview = await api.previewApplication(candidate.packageId)
                      if (current()) setPreview(preview)
                    })
                  }
                />
              ))}
            </SettingsGroup>
          ) : (
            state && (
              <p className="agnes-settings-note">
                {tr(
                  'Install an application from Plugins to see it here.',
                  '在插件页安装应用后，可在这里选择。',
                )}
              </p>
            )
          )}
        </SettingsSection>
        {preview && (
          <section ref={previewRef} aria-label={tr('Application consent preview', '应用采纳预览')}>
            <h3>{tr('Review application', '审阅应用')}</h3>
            <ApplicationPreviewSummary preview={preview} application />
            <p className="agnes-settings-note">
              {tr(
                'You can switch applications again from the sidebar.',
                '可随时通过侧栏的“切换应用”回到此页。',
              )}
            </p>
            <div className="home-push-actions">
              <Button disabled={busy} onClick={() => setPreview(undefined)}>
                {tr('Cancel', '取消')}
              </Button>
              <Button
                appearance="primary"
                disabled={busy || resource.loading || !canSave || !state}
                onClick={() =>
                  void run(async (current) => {
                    if (!api || !state) return
                    await api.adoptApplication(preview.packageId, state.revision, preview.consentDigest)
                    if (!current()) return
                    setPreview(undefined)
                    location.reload()
                  })
                }
              >
                {tr('Adopt', '采用')}
              </Button>
            </div>
          </section>
        )}
        <SettingsTechnicalDetails title={tr('Recovery tools', '恢复工具')}>
          <p>
            <a href="/?admin">{tr('Host recovery', '宿主恢复')}</a> · <code>{clearCommand}</code>
          </p>
        </SettingsTechnicalDetails>
      </div>
      {state && (
        <SettingsTechnicalDetails title={tr('Advanced interface choices', '高级界面选择')}>
          <InterfaceImplementations
            api={api}
            state={state}
            canSave={canSave && !busy && !resource.loading}
            onChange={setState}
          />
        </SettingsTechnicalDetails>
      )}
    </>
  )
}
