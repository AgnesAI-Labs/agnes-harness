import type { SystemPromptSnapshot } from '@agnes/protocol'
import {
  Banner,
  Button,
  CopyButton,
  promptSourceLabel,
  Segmented,
  Select,
  type SessionOption,
  SettingsBlock,
  SettingsCheckbox,
  SettingsCode,
  SettingsDrill,
  SettingsExpand,
  SettingsItem,
  SettingsTextArea,
  StateSwitch,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { jobsSessions } from './jobs-api.js'
import {
  browserPromptApi as browserApi,
  PROMPT_NAMESPACE as NAMESPACE,
  type PromptApi,
  usePromptSnapshot,
} from './prompt-config.js'
import { promptCatalog } from './system-prompt-locale.js'

/** Opens another settings page or subpage of the dialog by its id. */
function openSettings(id: string) {
  document
    .getElementById('config-form')
    ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: id, bubbles: true }))
}

/**
 * 提示词 in 运行配置: two rows, each a subpage. 完整替换默认提示词 replaces the default prompt as a
 * whole, applied with an explicit 「应用替换」 after 「我已理解」; 当前提示词预览 shows the sections a
 * new session (or one chosen session) gets, each expanding in place with copy.
 */
export function PromptRows({ canSave, api = browserApi }: { canSave: boolean; api?: PromptApi }) {
  const { t } = useUiText(NAMESPACE, promptCatalog)
  return (
    <SettingsBlock label={t('promptGroup')} id="settings-subsection-prompt" data-testid="prompt-rows">
      <PromptOverride canSave={canSave} api={api} />
      <PromptPreview api={api} />
    </SettingsBlock>
  )
}

/** One of the two prompt rows on its own, for a surface that shows only that part. */
export function SystemPromptPanel({
  canSave,
  api = browserApi,
  part,
}: {
  canSave: boolean
  api?: PromptApi
  part: 'override' | 'preview'
}) {
  return (
    <SettingsBlock>
      {part === 'override' ? <PromptOverride canSave={canSave} api={api} /> : <PromptPreview api={api} />}
    </SettingsBlock>
  )
}

function PromptOverride({ canSave, api }: { canSave: boolean; api: PromptApi }) {
  const { t } = useUiText(NAMESPACE, promptCatalog)
  const { snapshot, busy, failed, save, reload } = usePromptSnapshot(api)
  const stored = snapshot?.config.fullOverride ?? ''
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  useEffect(() => {
    setText(stored)
    setOpen(!!stored)
    setConfirmed(false)
  }, [stored])
  const config = snapshot?.config ?? {}
  // A full replacement leaves no place for the instructions added around the default prompt.
  const conflict = !!text && !!(config.personaPrefix || config.personaSuffix || config.replyStyle)
  const dirty = text !== stored
  const locked = !canSave || busy || saving || !snapshot
  async function store(value: string) {
    const { fullOverride: _replaced, ...rest } = config
    setSaving(true)
    setSaveFailed(false)
    try {
      await save(value ? { ...rest, fullOverride: value } : rest, !!value && confirmed)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <SettingsDrill
        id="system-prompt"
        data-testid="settings-drill-system-prompt"
        label={t('overrideTitle')}
        value={snapshot ? t(stored ? 'inUse' : 'notUsed') : undefined}
        description={t('overrideHelp')}
      >
        <div className="agnes-settings-stack" data-testid="system-prompt-editor" aria-busy={busy || saving}>
          <SettingsBlock
            failed={saveFailed}
            onRetry={() => void store(text)}
            state={failed && !snapshot ? 'error' : busy && !snapshot ? 'loading' : undefined}
            onReload={reload}
          >
            <SettingsItem label={t('overrideUse')}>
              <StateSwitch
                id="system-prompt-override-on"
                testId="system-prompt-override-on"
                label={t('overrideUse')}
                checked={open}
                disabled={locked}
                onToggle={(checked) => {
                  setOpen(checked)
                  // Turning it off goes back to the default prompt.
                  if (!checked && stored) void store('')
                }}
              />
            </SettingsItem>
          </SettingsBlock>
          {open && (
            <>
              <Banner tone="warning">{t('warning')}</Banner>
              {conflict && (
                <Banner
                  tone="info"
                  role="alert"
                  action={
                    <Button
                      size="small"
                      data-testid="system-prompt-clear-instructions"
                      onClick={() => openSettings('custom-instructions')}
                    >
                      {t('goClear')}
                    </Button>
                  }
                >
                  {t('conflict')}
                </Banner>
              )}
              <SettingsBlock
                bare
                label={t('override')}
                actions={
                  <span className="agnes-settings-note">{t('characters', { count: text.length })}</span>
                }
              >
                <SettingsTextArea
                  id="system-prompt-fullOverride"
                  data-testid="system-prompt-fullOverride"
                  className="agnes-settings-code-input"
                  aria-label={t('override')}
                  placeholder={t('overridePlaceholder')}
                  rows={12}
                  maxLength={65536}
                  disabled={locked}
                  value={text}
                  onChange={(event) => {
                    setText(event.currentTarget.value)
                    setConfirmed(false)
                  }}
                />
              </SettingsBlock>
              <div className="agnes-settings-apply" data-testid="system-prompt-actions">
                <SettingsCheckbox
                  label={t('confirm')}
                  data-testid="system-prompt-confirm"
                  checked={confirmed}
                  disabled={locked || !text || !dirty}
                  onChange={(event) => setConfirmed(event.currentTarget.checked)}
                />
                {!!stored && (
                  <Button
                    appearance="ghost"
                    data-testid="system-prompt-override-reset"
                    disabled={locked}
                    onClick={() => void store('')}
                  >
                    {t('reset')}
                  </Button>
                )}
                <Button
                  appearance="primary"
                  data-testid="system-prompt-override-save"
                  disabled={locked || !dirty || !text || conflict || !confirmed}
                  loading={saving}
                  onClick={() => void store(text)}
                >
                  {t('apply')}
                </Button>
              </div>
            </>
          )}
          <p className="agnes-settings-note">{t('newSessionsOnly')}</p>
        </div>
      </SettingsDrill>
    </>
  )
}

function PromptSections({
  list,
  locale,
}: {
  list: SystemPromptSnapshot['sections']
  locale: Parameters<typeof promptSourceLabel>[2]
}) {
  const { t } = useUiText(NAMESPACE, promptCatalog)
  return (
    <SettingsBlock data-testid="system-prompt-sections">
      {list.map((section) => {
        const label = promptSourceLabel(section.id, section.source, locale)
        return (
          <SettingsExpand
            key={section.id}
            data-testid="system-prompt-section"
            label={
              <span data-testid="system-prompt-source" title={`${section.id} · ${section.source}`}>
                {label}
              </span>
            }
            value={t('characters', { count: section.text.length })}
          >
            <SettingsCode label={label} className="system-prompt-section" copy={section.text}>
              {section.text}
            </SettingsCode>
          </SettingsExpand>
        )
      })}
    </SettingsBlock>
  )
}

function PromptPreview({ api }: { api: PromptApi }) {
  const { t, locale } = useUiText(NAMESPACE, promptCatalog)
  const { snapshot, busy, failed, reload } = usePromptSnapshot(api)
  const current = new URL(window.location.href).searchParams.get('session') ?? undefined
  const [view, setView] = useState<'defaults' | 'session'>('defaults')
  const [sessions, setSessions] = useState<SessionOption[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(current)
  const [session, setSession] = useState<SystemPromptSnapshot>()
  const [sessionFailed, setSessionFailed] = useState(false)
  useEffect(() => {
    if (view !== 'session') return
    let live = true
    void jobsSessions()
      .list()
      .then((list) => {
        if (!live) return
        setSessions(list)
        setSessionId((known) => known ?? list[0]?.id)
      })
      // Without the session list, the open session (if any) is still offered.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [view])
  useEffect(() => {
    if (view !== 'session' || !sessionId) return
    const pending = new AbortController()
    setSessionFailed(false)
    setSession(undefined)
    void api
      .session(sessionId, pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) setSession(value)
      })
      .catch(() => {
        if (!pending.signal.aborted) setSessionFailed(true)
      })
    return () => pending.abort()
  }, [api, sessionId, view])
  const shown = view === 'session' ? session : snapshot
  const full = shown?.sections.map((section) => section.text).join('\n\n') ?? ''
  const options = sessions.length
    ? sessions.map((entry) => ({ value: entry.id, label: entry.title || entry.id }))
    : current
      ? [{ value: current, label: t('openSession') }]
      : []
  return (
    <>
      <SettingsDrill
        id="prompt-preview"
        data-testid="settings-drill-prompt-preview"
        label={t('previewTitle')}
        value={snapshot ? t('sectionCount', { count: snapshot.sections.length }) : undefined}
        description={t('previewHelp')}
      >
        <div className="agnes-settings-stack" data-testid="system-prompt-preview">
          <div className="agnes-settings-toolbar-row">
            <Segmented<'defaults' | 'session'>
              label={t('previewTitle')}
              testId="system-prompt-preview-view"
              value={view}
              options={[
                { value: 'defaults', label: t('previewDefaults') },
                { value: 'session', label: t('previewSession') },
              ]}
              onChange={setView}
            />
            {view === 'session' && (
              <Select<string>
                aria-label={t('session')}
                data-testid="system-prompt-session-picker"
                value={sessionId ?? null}
                placeholder={t('noSessions')}
                disabled={!options.length}
                popupMatchSelectWidth={false}
                onChange={setSessionId}
                options={options}
              />
            )}
            <span className="agnes-settings-spacer" />
            {full && (
              <CopyButton
                label={t('copyAll')}
                copiedLabel={t('copied')}
                text={full}
                data-testid="system-prompt-copy-all"
              />
            )}
          </div>
          <SettingsBlock
            state={
              view === 'defaults'
                ? failed && !snapshot
                  ? 'error'
                  : busy && !snapshot
                    ? 'loading'
                    : undefined
                : sessionFailed
                  ? 'error'
                  : sessionId && !session
                    ? 'loading'
                    : undefined
            }
            onReload={view === 'defaults' ? reload : undefined}
            bare
          >
            {shown &&
              (shown.sections.length ? (
                <PromptSections list={shown.sections} locale={locale} />
              ) : (
                <SettingsBlock>
                  <SettingsItem label={t('empty')} />
                </SettingsBlock>
              ))}
          </SettingsBlock>
          {view === 'session' && session && (
            <p className="agnes-settings-note" data-testid="system-prompt-session-preview">
              {t(session.preview === 'last-request' ? 'lastRequest' : 'initial')}
            </p>
          )}
          <p className="agnes-settings-note">{t('sources')}</p>
        </div>
      </SettingsDrill>
    </>
  )
}

export {
  CustomInstructions,
  Personalization,
  replyStyleChoice,
  SettingsGeneralExtras,
} from './personalization.js'
