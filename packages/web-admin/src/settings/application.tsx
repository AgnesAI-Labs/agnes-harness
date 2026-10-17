import { resolveApplicationBrand } from '@agnes/web-client'

const clearCommand = 'agh app clear'
const recoveryPath = '/?admin'

import type { ApplicationPreview, ApplicationState } from '@agnes/protocol'
import { Button, SettingsBlock, SettingsPageDescription, useDocumentLanguage } from '@agnes/web-ui'
import { useCallback, useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'

function PreviewBrand({ preview }: { preview: ApplicationPreview }) {
  const [mark, setMark] = useState<string>()
  const language = useDocumentLanguage()
  useEffect(() => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif|x-icon));base64,([A-Za-z0-9+/=]+)$/.exec(
      preview.assets.mark ?? '',
    )
    if (!match?.[1] || !match[2]) {
      setMark(undefined)
      return
    }
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: match[1] }))
    setMark(url)
    return () => URL.revokeObjectURL(url)
  }, [preview])
  const brand = resolveApplicationBrand(preview.declaration, language)
  return (
    <p>
      {mark ? (
        <img src={mark} alt="" width={32} height={32} />
      ) : (
        <span className="agnes-mark" aria-hidden="true" />
      )}{' '}
      {brand.name} · {brand.title} · {brand.assistantName}
    </p>
  )
}

/** Minimal application settings. Backend owns preview validation and compare-and-swap. */
export function ApplicationPanel({ api, canSave }: { api?: PluginAdminApi | undefined; canSave: boolean }) {
  const language = useDocumentLanguage()
  const tr = useCallback((en: string, zh: string) => (language === 'zh-CN' ? zh : en), [language])
  const [state, setState] = useState<ApplicationState>()
  const [preview, setPreview] = useState<ApplicationPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = async () => {
    if (api) setState(await api.application())
  }
  useEffect(() => {
    let live = true
    void api
      ?.application()
      .then((state) => {
        if (live) setState(state)
      })
      .catch(() => {
        if (live) setError(tr('Could not load applications.', '无法加载应用。'))
      })
    return () => {
      live = false
    }
  }, [api, tr])
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
      await refresh().catch(() => undefined)
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
        state={!state ? (error ? 'error' : 'loading') : undefined}
        onReload={() => void run(refresh)}
      >
        {error && state && <p role="alert">{error}</p>}
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
          <pre>
            {JSON.stringify(
              { brand: state.effective.brand, presentation: state.effective.presentation },
              null,
              2,
            )}
          </pre>
        )}
        {state?.candidates.map((candidate) => (
          <p key={candidate.packageId}>
            <span>
              {candidate.applicationId} · {candidate.packageId}@{candidate.version}
            </span>{' '}
            <Button
              disabled={busy || !candidate.available || !canSave}
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
            <PreviewBrand preview={preview} />
            <p>
              {tr('Visible agents', '可见智能体')}:{' '}
              {preview.declaration.agents?.join(', ') ?? tr('All available agents', '全部可用智能体')}
            </p>
            <p>
              {tr('Default agent', '默认智能体')}:{' '}
              {preview.declaration.defaultAgent ?? tr('General assistant', '通用助手')}
            </p>
            <p>
              {tr('Home / skin', '主页 / 皮肤')}:{' '}
              {preview.declaration.presentation?.home ?? tr('Host default', '宿主默认')} /{' '}
              {preview.declaration.presentation?.skin ?? tr('Host default', '宿主默认')}
            </p>
            <p>
              {tr('Source and signature', '来源与签名')}: {preview.source.ref} · {preview.signature}
            </p>
            <p>
              {preview.packageId}@{preview.version} · {preview.integrity}
            </p>
            <pre>{JSON.stringify(preview.declaration, null, 2)}</pre>
            <h4>{tr('Replaced roles and code sources', '替换的接管角色与代码来源')}</h4>
            <pre>{JSON.stringify(preview.replacedRoles, null, 2)}</pre>
            <h4>{tr('Dependencies, permissions and changes', '依赖、权限和变化')}</h4>
            <pre>
              {JSON.stringify(
                { dependencies: preview.dependencies, changes: preview.dependencyDiff },
                null,
                2,
              )}
            </pre>
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
              disabled={busy || !canSave || !state}
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
          disabled={busy || !canSave || !state?.selection}
          onClick={() =>
            void run(async () => {
              if (!api || !state) return
              await api.clearApplication(state.revision)
              location.reload()
            })
          }
        >
          {tr('Clear application', '清除应用')}
        </Button>
        <p>
          <a href="/?admin">{tr('Host recovery', '宿主恢复')}</a> · <code>{clearCommand}</code>
        </p>
      </SettingsBlock>
    </>
  )
}
