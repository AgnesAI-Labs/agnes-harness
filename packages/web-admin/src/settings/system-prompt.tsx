import type { SystemPromptConfig, SystemPromptSnapshot } from '@agnes/protocol'
import {
  Banner,
  Button,
  Field,
  promptSourceLabel,
  SettingsCard,
  SettingsCheckbox,
  SettingsCode,
  SettingsDetails,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { systemPromptApi } from './system-prompt-api.js'
import { promptCatalog } from './system-prompt-locale.js'

const browserApi = systemPromptApi()
export function SystemPromptPanel({
  canSave,
  api = browserApi,
  part,
}: {
  canSave: boolean
  api?: ReturnType<typeof systemPromptApi>
  /**
   * One part of the panel on its own: `override` is the full replacement and the closing
   * instruction (the opening instruction and reply style are edited with the context capability);
   * `preview` is what the selected prompt plugins provide now. Without it the panel shows everything.
   */
  part?: 'override' | 'preview'
}) {
  const { t, locale } = useUiText('@agnes/web/system-prompt', promptCatalog)
  const [sessionSnapshot, setSessionSnapshot] = useState<SystemPromptSnapshot>()
  const sessionId = new URL(window.location.href).searchParams.get('session') ?? undefined
  const [snapshot, setSnapshot] = useState<SystemPromptSnapshot>()
  const [config, setConfig] = useState<SystemPromptConfig>({})
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const pending = new AbortController()
    setBusy(true)
    void api
      .get(pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) {
          setSnapshot(value)
          setConfig(value.config)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => pending.abort()
  }, [api])
  useEffect(() => {
    if (!sessionId) return
    const pending = new AbortController()
    void api
      .session(sessionId, pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) setSessionSnapshot(value)
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
    return () => pending.abort()
  }, [api, sessionId])
  async function save(reset = false) {
    setBusy(true)
    setFailed(false)
    setSaved(false)
    try {
      const result = await api.save({ config: reset ? {} : config, confirmFullOverride: confirmed })
      setSnapshot(result)
      setConfig(result.config)
      setConfirmed(false)
      setSaved(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const overrideConflict =
    !!config.fullOverride && !!(config.personaPrefix || config.personaSuffix || config.replyStyle)
  const edit = (name: 'personaPrefix' | 'personaSuffix' | 'replyStyle' | 'fullOverride', value: string) => {
    setConfig((previous) => {
      const next = { ...previous }
      if (value) next[name] = value
      else delete next[name]
      return next
    })
    setSaved(false)
  }
  const override = (
    <>
      <Banner tone="warning">{t('warning')}</Banner>
      {overrideConflict && (
        <SettingsState tone="error" role="alert">
          {t('conflict')}
        </SettingsState>
      )}
      <Field label={t('override')} htmlFor="system-prompt-fullOverride">
        <SettingsTextArea
          id="system-prompt-fullOverride"
          data-testid="system-prompt-fullOverride"
          rows={8}
          maxLength={65536}
          disabled={!canSave || busy}
          value={config.fullOverride ?? ''}
          onChange={(event) => edit('fullOverride', event.currentTarget.value)}
        />
      </Field>
      <SettingsCheckbox
        label={t('confirm')}
        data-testid="system-prompt-confirm"
        checked={confirmed}
        disabled={!canSave || busy}
        onChange={(event) => setConfirmed(event.currentTarget.checked)}
      />
    </>
  )
  const actions = (
    <SettingsToolbar>
      <Button
        data-testid="system-prompt-save"
        disabled={!canSave || busy || overrideConflict || (!!config.fullOverride && !confirmed)}
        onClick={() => void save()}
      >
        {t('save')}
      </Button>
      <Button data-testid="system-prompt-reset" disabled={!canSave || busy} onClick={() => void save(true)}>
        {t('reset')}
      </Button>
    </SettingsToolbar>
  )
  const sections = (list: SystemPromptSnapshot['sections'] | undefined, open: boolean) =>
    list?.map((section) => (
      <SettingsDetails
        key={section.id}
        title={
          <span data-testid="system-prompt-source" title={`${section.id} · ${section.source}`}>
            {promptSourceLabel(section.id, section.source, locale)}
          </span>
        }
        {...(open ? { open: true } : {})}
        compact
      >
        <SettingsCode
          label={promptSourceLabel(section.id, section.source, locale)}
          className="system-prompt-section"
        >
          {section.text}
        </SettingsCode>
      </SettingsDetails>
    ))
  const status = (
    <>
      {failed && (
        <SettingsState tone="error" role="alert">
          {t('failed')}
        </SettingsState>
      )}
      {saved && (
        <SettingsState tone="success" role="status" data-testid="system-prompt-saved">
          {t('saved')}
        </SettingsState>
      )}
      {busy && !snapshot && <SettingsState tone="loading">{t('loading')}</SettingsState>}
    </>
  )
  if (part === 'override')
    return (
      <div data-testid="system-prompt-editor" aria-busy={busy}>
        {status}
        {override}
        <Field label={t('suffix')} htmlFor="system-prompt-personaSuffix" hint={t('suffixHelp')}>
          <SettingsTextArea
            id="system-prompt-personaSuffix"
            data-testid="system-prompt-personaSuffix"
            rows={3}
            maxLength={8192}
            value={config.personaSuffix ?? ''}
            disabled={!canSave || busy}
            onChange={(event) => edit('personaSuffix', event.currentTarget.value)}
          />
        </Field>
        {actions}
      </div>
    )
  if (part === 'preview')
    return (
      <div data-testid="system-prompt-preview">
        {status}
        <p>{t('sources')}</p>
        {sections(snapshot?.sections, false)}
        {sessionSnapshot && (
          <SettingsCard title={t('session')} data-testid="system-prompt-session-preview">
            <p>{t(sessionSnapshot.preview === 'last-request' ? 'lastRequest' : 'initial')}</p>
            {sections(sessionSnapshot.sections, false)}
          </SettingsCard>
        )}
      </div>
    )
  return (
    <>
      <p>{t('help')}</p>
      {failed && (
        <SettingsState tone="error" role="alert">
          {t('failed')}
        </SettingsState>
      )}
      {saved && (
        <SettingsState tone="success" role="status" data-testid="system-prompt-saved">
          {t('saved')}
        </SettingsState>
      )}
      {busy && !snapshot && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      <div className="system-prompt-layout">
        <SettingsCard title={t('custom')} data-testid="system-prompt-editor" aria-busy={busy}>
          {(['personaPrefix', 'personaSuffix', 'replyStyle'] as const).map((name, index) => (
            <Field
              key={name}
              label={t(['prefix', 'suffix', 'style'][index]!)}
              htmlFor={`system-prompt-${name}`}
            >
              <SettingsTextArea
                id={`system-prompt-${name}`}
                data-testid={`system-prompt-${name}`}
                rows={4}
                maxLength={8192}
                value={config[name] ?? ''}
                disabled={!canSave || busy}
                onChange={(event) => edit(name, event.currentTarget.value)}
              />
            </Field>
          ))}
          <SettingsDetails title={t('advanced')} data-testid="system-prompt-advanced">
            <SettingsState tone="empty">{t('warning')}</SettingsState>
            {overrideConflict && (
              <SettingsState tone="error" role="alert">
                {t('conflict')}
              </SettingsState>
            )}
            <Field label={t('override')} htmlFor="system-prompt-fullOverride">
              <SettingsTextArea
                id="system-prompt-fullOverride"
                data-testid="system-prompt-fullOverride"
                rows={8}
                maxLength={65536}
                disabled={!canSave || busy}
                value={config.fullOverride ?? ''}
                onChange={(event) => edit('fullOverride', event.currentTarget.value)}
              />
            </Field>
            <SettingsCheckbox
              label={t('confirm')}
              data-testid="system-prompt-confirm"
              checked={confirmed}
              disabled={!canSave || busy}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
            />
          </SettingsDetails>
          <SettingsToolbar>
            <Button
              data-testid="system-prompt-save"
              disabled={!canSave || busy || overrideConflict || (!!config.fullOverride && !confirmed)}
              onClick={() => void save()}
            >
              {t('save')}
            </Button>
            <Button
              data-testid="system-prompt-reset"
              disabled={!canSave || busy}
              onClick={() => void save(true)}
            >
              {t('reset')}
            </Button>
          </SettingsToolbar>
        </SettingsCard>
        <SettingsCard title={t('preview')} data-testid="system-prompt-preview">
          <p>{t('sources')}</p>
          {snapshot?.sections.map((section) => (
            <SettingsDetails
              key={section.id}
              title={
                <span data-testid="system-prompt-source" title={`${section.id} · ${section.source}`}>
                  {promptSourceLabel(section.id, section.source, locale)}
                </span>
              }
              open
              compact
            >
              <SettingsCode
                label={promptSourceLabel(section.id, section.source, locale)}
                className="system-prompt-section"
              >
                {section.text}
              </SettingsCode>
            </SettingsDetails>
          ))}
        </SettingsCard>
      </div>
      {sessionSnapshot && (
        <SettingsCard title={t('session')} data-testid="system-prompt-session-preview">
          <p>{t(sessionSnapshot.preview === 'last-request' ? 'lastRequest' : 'initial')}</p>
          {sessionSnapshot.sections.map((section) => (
            <SettingsDetails
              key={section.id}
              title={
                <span data-testid="system-prompt-source" title={`${section.id} · ${section.source}`}>
                  {promptSourceLabel(section.id, section.source, locale)}
                </span>
              }
              compact
            >
              <SettingsCode
                label={promptSourceLabel(section.id, section.source, locale)}
                className="system-prompt-section"
              >
                {section.text}
              </SettingsCode>
            </SettingsDetails>
          ))}
        </SettingsCard>
      )}
    </>
  )
}
