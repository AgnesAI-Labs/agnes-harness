import { captureRequest, useRequestScope } from './async-request.js'

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
  const lifetime = useRequestScope(api, `${canSave}:${state?.revision}`)
  const setState = (next: ApplicationState) => {
    if (resourceKey) setResource(resourceKey, next)
  }
  const [preview, setPreview] = useState<ApplicationPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
                void run(async (current) => {
                  if (!api) return
                  const preview = await api.previewApplication(candidate.packageId)
                  if (current()) setPreview(preview)
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
                void run(async (current) => {
                  if (!api || !state) return
                  await api.adoptApplication(preview.packageId, state.revision, preview.consentDigest)
                  if (!current()) return
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
            void run(async (current) => {
              if (!api || !state) return
              await api.clearApplication(state.revision)
              if (current()) location.reload()
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
