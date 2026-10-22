import type { ApplicationPreview, ApplicationState, PresentationRole } from '@agnes/protocol'
import { presentationRoles, STANDARD_PRESENTATION_ROLES, selectPresentationRoles } from '@agnes/web-client'
import { Button, reportSuccess, SettingsBlock, StatusMessage, useDocumentLanguage } from '@agnes/web-ui'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { ApplicationPreviewSummary, PRESENTATION_ROLE_LABELS as labels } from './application-preview.js'
import { captureRequest, useRequestScope } from './async-request.js'

const recoveryPath = '/?admin'
const clearCommand = 'agh app clear'
const reasons: Record<string, [string, string]> = {
  'inventory-unavailable': ['Plugin inventory unavailable', '插件清单不可用'],
  removed: ['Package removed', '插件已移除'],
  disabled: ['Package disabled', '插件已停用'],
  untrusted: ['Package is untrusted', '插件未受信任'],
  'package-changed': ['Package changed', '插件内容已变更'],
  'declaration-changed': ['Client declaration changed', '界面声明已变更'],
  'consent-mismatch': ['Loaded interface does not match your consent', '已加载的界面与同意内容不一致'],
  'consent-changed': ['Reviewed content changed', '已审阅内容发生变更'],
  'mount-failed': ['Interface failed to load', '界面加载失败'],
  'code-unavailable': ['Interface is unavailable', '界面不可用'],
  'code-or-references-unavailable': ['Code or dependencies unavailable', '代码或依赖不可用'],
}

/** Administration only selects static declarations. The host still owns mounting and recovery. */
export function InterfaceImplementations({
  api,
  state,
  canSave,
  onChange,
}: {
  api?: PluginAdminApi | undefined
  state: ApplicationState
  canSave: boolean
  onChange(state: ApplicationState): void
}) {
  const language = useDocumentLanguage()
  const tr = (en: string, zh: string) => (language === 'zh-CN' ? zh : en)
  const [review, setReview] = useState<{
    role: PresentationRole
    clientId: string
    preview: ApplicationPreview
  }>()
  const reviewRef = useRef<HTMLElement>(null)
  // The review opens after the role rows; bring it into view the way the dialog it replaced did.
  useEffect(() => {
    if (review) reviewRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [review])
  const lifetime = useRequestScope(api, `${canSave}:${state.revision}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    setBusy(false)
    setReview(undefined)
  }, [api, canSave, state.revision])
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection and permission changes reset diagnostics.
  useEffect(() => setError(''), [api, canSave])
  useSyncExternalStore(presentationRoles.subscribe, presentationRoles.getSnapshot)
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (!api || busy) return
    const { isCurrent } = captureRequest(lifetime)
    setBusy(true)
    setError('')
    try {
      await action(isCurrent)
    } catch {
      if (!isCurrent()) return
      setReview(undefined)
      setError(
        tr(
          'The choice changed or is unavailable. Reload, preview and confirm again.',
          '选择已变更或不可用，请重新加载、预览并确认。',
        ),
      )
      await api
        .application()
        .then((next) => {
          if (isCurrent()) onChange(next)
        })
        .catch(() => undefined)
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }
  const saved = (next: ApplicationState) => {
    selectPresentationRoles(next)
    onChange(next)
    setReview(undefined)
    if (
      next.roles?.some(
        (item) =>
          item.selection &&
          (item.status === 'unresolved' ||
            (item.source === 'choice' && presentationRoles.resolution(item.role).reason)),
      )
    )
      return
    reportSuccess('interface-implementations', tr('Interface choice applied.', '已应用界面选择。'))
  }
  return (
    <SettingsBlock bare label={tr('Interface implementations', '界面实现')}>
      <div className="agnes-settings-prose">
        <p>
          {tr(
            'Explicit choice takes precedence over the application, then the host default. Presentation only; execution and existing sessions keep their bindings.',
            '你的选择优先于应用，之后为宿主默认。仅影响展示，执行和已有会话保持原绑定。',
          )}
        </p>
        {error && (
          <StatusMessage
            kind="error"
            action={{
              label: tr('Reload', '重新加载'),
              onSelect: () =>
                void run(async (current) => {
                  if (!api) return
                  const next = await api.application()
                  if (current()) onChange(next)
                }),
            }}
          >
            {error}
          </StatusMessage>
        )}
        {STANDARD_PRESENTATION_ROLES.map((role) => {
          const item = state.roles?.find((item) => item.role === role)
          const runtime = presentationRoles.resolution(role)
          const reason = item?.reason ?? (item?.source === 'choice' ? runtime.reason : undefined)
          const effective =
            (reason || item?.source === 'default') && runtime.effective ? runtime.effective : item?.effective
          const appTarget = state.effective?.presentation?.roles?.[role]
          const source =
            reason && item?.source === 'choice'
              ? effective &&
                effective.packageId === appTarget?.packageId &&
                effective.clientId === appTarget.clientId
                ? 'application'
                : 'default'
              : item?.source
          const sourceLabel =
            source === 'choice'
              ? tr('Your choice', '你的选择')
              : source === 'application'
                ? tr('Application', '应用')
                : tr('Default', '默认')
          return (
            <section key={role} aria-label={tr(...labels[role])}>
              <h4>{tr(...labels[role])}</h4>
              <p>
                {sourceLabel} ·{' '}
                {effective ? `${effective.packageId}#${effective.clientId}` : tr('Host default', '宿主默认')}
              </p>
              {item?.selection && reason && (
                <StatusMessage
                  kind="notice"
                  action={
                    canSave
                      ? {
                          label: tr('Restore default', '恢复默认'),
                          busy,
                          onSelect: () =>
                            void run(async (current) => {
                              if (!api) return
                              const next = await api.clearRole(role, state.revision)
                              if (current()) saved(next)
                            }),
                        }
                      : undefined
                  }
                >
                  {tr(
                    'Unresolved choice; using the application or host default. Your saved choice is retained.',
                    '选择未解析，已回落到应用或宿主默认；保留已保存的选择。',
                  )}{' '}
                  {tr(...(reasons[reason] ?? ['Interface is unavailable', '界面不可用']))} ·{' '}
                  {`${item.selection.packageId}#${item.selection.clientId}`}
                </StatusMessage>
              )}
              {item?.candidates.map((candidate) => (
                <p key={`${candidate.packageId}#${candidate.clientId}`}>
                  {`${candidate.packageId}#${candidate.clientId}`} · {candidate.version}{' '}
                  <Button
                    disabled={!canSave || busy || !api}
                    onClick={() =>
                      void run(async (current) => {
                        if (!api) return
                        const preview = await api.previewRole(role, candidate.packageId, candidate.clientId)
                        if (!current()) return
                        setReview({ role, clientId: candidate.clientId, preview })
                      })
                    }
                  >
                    {tr('Preview', '预览')}
                  </Button>
                </p>
              ))}
              <Button
                disabled={!item?.selection || !canSave || busy || !api}
                onClick={() =>
                  void run(async (current) => {
                    if (!api) return
                    const next = await api.clearRole(role, state.revision)
                    if (current()) saved(next)
                  })
                }
              >
                {tr('Restore default', '恢复默认')}
              </Button>
            </section>
          )
        })}
        {review && (
          <section ref={reviewRef} aria-label={tr('Interface consent preview', '界面实现同意预览')}>
            <h4>
              {tr('Review replacement', '审阅替换')} · {tr(...labels[review.role])}
            </h4>
            <ApplicationPreviewSummary preview={review.preview} />
            <p>
              {tr(
                'Presentation only. No execution change. Trusted JavaScript is not a sandbox.',
                '仅影响展示，不改变执行。受信 JavaScript 并非沙箱。',
              )}
            </p>
            <p>
              {tr('Recovery', '恢复方法')}: <a href={recoveryPath}>{recoveryPath}</a> ·{' '}
              <code>{clearCommand}</code>
            </p>
            <div className="home-push-actions">
              <Button disabled={busy} onClick={() => setReview(undefined)}>
                {tr('Cancel', '取消')}
              </Button>
              <Button
                appearance="primary"
                disabled={!canSave || busy || !api}
                onClick={() =>
                  void run(async (current) => {
                    if (!api) return
                    const next = await api.selectRole(
                      review.role,
                      review.preview.packageId,
                      review.clientId,
                      state.revision,
                      review.preview.consentDigest,
                    )
                    if (current()) saved(next)
                  })
                }
              >
                {tr('Use this implementation', '使用此实现')}
              </Button>
            </div>
          </section>
        )}
      </div>
    </SettingsBlock>
  )
}
