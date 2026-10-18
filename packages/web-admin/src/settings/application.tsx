const clearCommand = 'agh app clear'
const recoveryPath = '/?admin'

import type { ApplicationPreview, ApplicationState } from '@agnes/protocol'
import {
  Button,
  SettingsBlock,
  SettingsCode,
  SettingsPageDescription,
  SettingsTechnicalDetails,
  scopedResourceKey,
  setResource,
  useDocumentLanguage,
  useResource,
} from '@agnes/web-ui'
import { useCallback, useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { ApplicationPreviewSummary } from './application-preview.js'
import { InterfaceImplementations } from './interface-implementations.js'

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
  const setState = (next: ApplicationState) => {
    if (resourceKey) setResource(resourceKey, next)
  }
  const [preview, setPreview] = useState<ApplicationPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = resource.reload
  useEffect(() => {
    if (!api || busy || resource.loading) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh()
    }, 5_000)
    return () => clearInterval(timer)
  }, [api, busy, resource.loading, refresh])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      setError(
        tr(
          'The application changed or is unavailable. Reload, preview and confirm again.',
          '应用已变更或不可用，请重新加载、预览并确认。',
        ),
      )
      refresh()
      setPreview(undefined)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <SettingsPageDescription>
        {tr(
          'Choose product identity and presentation defaults. Execution settings and existing sessions keep their bindings.',
          '选择产品身份与展示默认值，执行配置和已有会话保持原绑定。',
        )}
      </SettingsPageDescription>
      <SettingsBlock
        state={!state ? (error || resource.error ? 'error' : 'loading') : undefined}
        onReload={refresh}
      >
        {error && state && <p role="alert">{error}</p>}
        {resource.error && state ? (
          <p role="alert">{tr('Could not refresh applications. Retry.', '无法刷新应用，请重试。')}</p>
        ) : null}
        <Button disabled={!api || busy || resource.loading} onClick={refresh}>
          {tr('Refresh candidates', '刷新候选')}
        </Button>
        <p>
          {tr('Current application', '当前应用')}: {state?.selection?.applicationId ?? 'Agnes Harness'}
        </p>
        {state?.status === 'unresolved' && (
          <p role="status">
            {tr('Unresolved; showing Agnes Harness', '选择未解析，当前显示 Agnes Harness')} · {state.reason}
          </p>
        )}
        <p>
          {tr('Default agent', '默认智能体')}:{' '}
          {state?.effective?.defaultAgent ?? tr('General assistant', '通用助手')}
        </p>
        {state?.effective && (
          <SettingsTechnicalDetails title={tr('Technical details', '技术详情')}>
            <SettingsCode
              label={tr('Current presentation', '当前展示')}
              copy={JSON.stringify(state.effective, null, 2)}
            >
              {JSON.stringify(state.effective, null, 2)}
            </SettingsCode>
          </SettingsTechnicalDetails>
        )}
        {state?.candidates.map((candidate) => (
          <p key={candidate.packageId}>
            <span>
              {candidate.applicationId} · {candidate.packageId}@{candidate.version}
            </span>{' '}
            <Button
              disabled={busy || resource.loading || !candidate.available || !canSave}
              onClick={() =>
                void run(async () => {
                  if (api) setPreview(await api.previewApplication(candidate.packageId))
                })
              }
            >
              {tr('Preview', '预览')}
            </Button>
          </p>
        ))}
        {preview && (
          <section aria-label={tr('Application consent preview', '应用采纳预览')}>
            <h3>{tr('Review application', '审阅应用')}</h3>
            <ApplicationPreviewSummary preview={preview} application />
            <p>
              {tr(
                'Applies to product identity, navigation, presentation and the agent catalogue. Trusted JavaScript is not a sandbox.',
                '作用于产品身份、导航、展示和智能体目录。受信 JavaScript 并非沙箱。',
              )}
            </p>
            <p>
              {tr('Recovery', '恢复方法')}: <a href={recoveryPath}>{recoveryPath}</a> ·{' '}
              <code>{clearCommand}</code>
            </p>
            <Button
              disabled={busy || resource.loading || !canSave || !state}
              onClick={() =>
                void run(async () => {
                  if (!api || !state) return
                  await api.adoptApplication(preview.packageId, state.revision, preview.consentDigest)
                  setPreview(undefined)
                  location.reload()
                })
              }
            >
              {tr('Adopt this preview', '采纳此预览')}
            </Button>
          </section>
        )}
        <Button
          disabled={
            busy ||
            resource.loading ||
            !canSave ||
            (!state?.selection && !Object.keys(state?.roleSelections ?? {}).length)
          }
          onClick={() =>
            void run(async () => {
              if (!api || !state) return
              await api.clearApplication(state.revision)
              location.reload()
            })
          }
        >
          {tr('Clear application and interface choices', '清除应用与界面实现选择')}
        </Button>
        <p>
          <a href="/?admin">{tr('Host recovery', '宿主恢复')}</a> · <code>{clearCommand}</code>
        </p>
      </SettingsBlock>
      {state && (
        <InterfaceImplementations
          api={api}
          state={state}
          canSave={canSave && !busy && !resource.loading}
          onChange={setState}
        />
      )}
    </>
  )
}
