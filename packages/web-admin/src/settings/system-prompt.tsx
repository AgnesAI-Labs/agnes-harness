import type { SystemPromptConfig, SystemPromptSnapshot } from '@agnes/protocol'
import {
  Banner,
  Button,
  promptSourceLabel,
  SettingsCheckbox,
  SettingsCode,
  SettingsDetails,
  SettingsFooter,
  SettingsGroup,
  SettingsSection,
  SettingsState,
  SettingsTextArea,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import {
  browserPromptApi as browserApi,
  PROMPT_NAMESPACE as NAMESPACE,
  type PromptApi,
} from './prompt-config.js'
import { promptCatalog } from './system-prompt-locale.js'

/** The stored prompt configuration, read once and replaced by every save. */
function usePromptConfig(api: PromptApi, enabled = true) {
  const [snapshot, setSnapshot] = useState<SystemPromptSnapshot>()
  const [busy, setBusy] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const pending = new AbortController()
    setBusy(true)
    void api
      .get(pending.signal)
      .then((value) => {
        if (pending.signal.aborted) return
        setSnapshot(value)
        setFailed(false)
      })
      .catch(() => {
        if (!pending.signal.aborted) setFailed(true)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => pending.abort()
  }, [api, enabled])
  async function save(config: SystemPromptConfig, confirmFullOverride: boolean) {
    setBusy(true)
    setFailed(false)
    setSaved(false)
    try {
      const result = await api.save({ config, confirmFullOverride })
      setSnapshot(result)
      setSaved(true)
      return result
    } catch {
      setFailed(true)
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { snapshot, busy, failed, saved, save, edited: () => setSaved(false) }
}

/**
 * The run configuration's two prompt sections. `override` replaces the default prompt as a whole;
 * `preview` shows what the selected prompt plugins provide now. The opening instruction and reply
 * style are everyday settings and live on the General page (`CustomInstructions`).
 */
export function SystemPromptPanel({
  canSave,
  api = browserApi,
  part,
}: {
  canSave: boolean
  api?: PromptApi
  part: 'override' | 'preview'
}) {
  return part === 'override' ? <PromptOverride canSave={canSave} api={api} /> : <PromptPreview api={api} />
}

function PromptOverride({ canSave, api }: { canSave: boolean; api: PromptApi }) {
  const { t } = useUiText(NAMESPACE, promptCatalog)
  const { snapshot, busy, failed, saved, save, edited } = usePromptConfig(api)
  const stored = snapshot?.config.fullOverride ?? ''
  const [text, setText] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    setText(stored)
    setConfirmed(false)
  }, [stored])
  const config = snapshot?.config ?? {}
  // A full replacement leaves no place for the instructions added around the default prompt.
  const conflict = !!text && !!(config.personaPrefix || config.personaSuffix || config.replyStyle)
  const dirty = text !== stored
  const locked = !canSave || busy || !snapshot
  const store = (value: string) => {
    const { fullOverride: _replaced, ...rest } = config
    return save(value ? { ...rest, fullOverride: value } : rest, !!value && confirmed)
  }
  return (
    <div className="agnes-settings-stack" data-testid="system-prompt-editor" aria-busy={busy}>
      {failed && (
        <Banner tone="error" role="alert">
          {t('failed')}
        </Banner>
      )}
      {busy && !snapshot && <SettingsState tone="loading" />}
      <Banner tone="warning">{t('warning')}</Banner>
      {conflict && (
        <Banner tone="error" role="alert">
          {t('conflict')}
        </Banner>
      )}
      <SettingsTextArea
        id="system-prompt-fullOverride"
        data-testid="system-prompt-fullOverride"
        aria-label={t('override')}
        placeholder={t('overridePlaceholder')}
        rows={10}
        maxLength={65536}
        disabled={locked}
        value={text}
        onChange={(event) => {
          edited()
          setText(event.currentTarget.value)
        }}
      />
      {!!text && dirty && (
        <SettingsCheckbox
          label={t('confirm')}
          data-testid="system-prompt-confirm"
          checked={confirmed}
          disabled={locked}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
      )}
      <SettingsFooter
        status={
          saved && !dirty ? <span data-testid="system-prompt-override-saved">{t('saved')}</span> : undefined
        }
      >
        {!!stored && (
          <Button data-testid="system-prompt-override-reset" disabled={locked} onClick={() => void store('')}>
            {t('reset')}
          </Button>
        )}
        <Button
          appearance="primary"
          data-testid="system-prompt-override-save"
          disabled={locked || !dirty || conflict || (!!text && !confirmed)}
          loading={busy && dirty}
          onClick={() => void store(text)}
        >
          {t('save')}
        </Button>
      </SettingsFooter>
    </div>
  )
}

function PromptSections({
  list,
  locale,
}: {
  list: SystemPromptSnapshot['sections']
  locale: Parameters<typeof promptSourceLabel>[2]
}) {
  return (
    <SettingsGroup>
      {list.map((section) => {
        const label = promptSourceLabel(section.id, section.source, locale)
        return (
          <SettingsDetails
            key={section.id}
            title={
              <span data-testid="system-prompt-source" title={`${section.id} · ${section.source}`}>
                {label}
              </span>
            }
          >
            <SettingsCode label={label} className="system-prompt-section" copy={section.text}>
              {section.text}
            </SettingsCode>
          </SettingsDetails>
        )
      })}
    </SettingsGroup>
  )
}

function PromptPreview({ api }: { api: PromptApi }) {
  const { t, locale } = useUiText(NAMESPACE, promptCatalog)
  const { snapshot, busy, failed } = usePromptConfig(api)
  const [session, setSession] = useState<SystemPromptSnapshot>()
  const sessionId = new URL(window.location.href).searchParams.get('session') ?? undefined
  useEffect(() => {
    if (!sessionId) return
    const pending = new AbortController()
    void api
      .session(sessionId, pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) setSession(value)
      })
      // The session's own version is an extra; the configured preview stands without it.
      .catch(() => {})
    return () => pending.abort()
  }, [api, sessionId])
  return (
    <div className="agnes-settings-stack" data-testid="system-prompt-preview">
      {failed && (
        <Banner tone="error" role="alert">
          {t('failed')}
        </Banner>
      )}
      {busy && !snapshot && <SettingsState tone="loading" />}
      {snapshot && (
        <SettingsSection description={t('sources')}>
          {snapshot.sections.length ? (
            <PromptSections list={snapshot.sections} locale={locale} />
          ) : (
            <SettingsState>{t('empty')}</SettingsState>
          )}
        </SettingsSection>
      )}
      {session && (
        <SettingsSection
          title={t('session')}
          description={t(session.preview === 'last-request' ? 'lastRequest' : 'initial')}
          data-testid="system-prompt-session-preview"
        >
          <PromptSections list={session.sections} locale={locale} />
        </SettingsSection>
      )}
    </div>
  )
}

export {
  CustomInstructions,
  Personalization,
  replyStyleChoice,
  SettingsGeneralExtras,
} from './personalization.js'
