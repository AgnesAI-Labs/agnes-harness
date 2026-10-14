import type { SystemPromptConfig, SystemPromptSnapshot } from '@agnes/protocol'
import {
  Banner,
  Button,
  createDocumentLocaleSource,
  hasPermission,
  promptSourceLabel,
  SettingsCheckbox,
  SettingsCode,
  SettingsDetails,
  SettingsFooter,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsSection,
  SettingsState,
  SettingsTextArea,
  UiLocaleProvider,
  type UiLocaleSource,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { systemPromptApi } from './system-prompt-api.js'
import { promptCatalog } from './system-prompt-locale.js'

const NAMESPACE = '@agnes/web/system-prompt'
const browserApi = systemPromptApi()
type PromptApi = ReturnType<typeof systemPromptApi>
type Instruction = 'personaPrefix' | 'personaSuffix' | 'replyStyle'

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

/** Whether an element's pane and dialog are open, so a hidden settings pane reads nothing. */
function useShown(eager: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(eager)
  useEffect(() => {
    const node = ref.current
    if (shown || !node) return
    const check = () => {
      if (!node.closest('[hidden]') && (node.closest('dialog')?.open ?? true)) setShown(true)
    }
    check()
    // The pane and the dialog around it are shown by attribute changes on its ancestors.
    const observer = new MutationObserver(check)
    for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ['hidden', 'open'] })
    return () => observer.disconnect()
  }, [shown])
  return [ref, shown] as const
}

const canEditPrompt = async () => {
  const context = await PluginAdminApi.context()
  return !context.readOnly && hasPermission(context.permissions, 'packages.activate')
}

/**
 * What the user wants the agent to do, and how it should reply: the General page's own group. It
 * writes the opening instruction and the reply style; a closing instruction saved earlier stays
 * editable so nothing is lost. While a full replacement is in use these are read-only.
 */
export function CustomInstructions({
  api = browserApi,
  permission = canEditPrompt,
  eager = false,
  onRunConfiguration,
}: {
  api?: PromptApi
  /** Whether this connection may save; the default asks the daemon the page is served by. */
  permission?: () => Promise<boolean>
  /** Read at once instead of waiting for the group to be on screen. */
  eager?: boolean
  /** Opens the run configuration's full-replacement section. */
  onRunConfiguration?: () => void
}) {
  const { t } = useUiText(NAMESPACE, promptCatalog)
  const [ref, shown] = useShown(eager)
  const { snapshot, busy, failed, saved, save, edited } = usePromptConfig(api, shown)
  const [canSave, setCanSave] = useState(false)
  const [draft, setDraft] = useState<SystemPromptConfig>({})
  const [hadClosing, setHadClosing] = useState(false)
  useEffect(() => {
    if (!shown) return
    let current = true
    void permission().then(
      (value) => {
        if (current) setCanSave(value)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [shown, permission])
  useEffect(() => {
    if (!snapshot) return
    setDraft(snapshot.config)
    setHadClosing(!!snapshot.config.personaSuffix)
  }, [snapshot])
  const stored = snapshot?.config ?? {}
  const replaced = !!stored.fullOverride
  const locked = !canSave || busy || replaced || !snapshot
  const dirty = (['personaPrefix', 'personaSuffix', 'replyStyle'] as const).some(
    (name) => (draft[name] ?? '') !== (stored[name] ?? ''),
  )
  const edit = (name: Instruction, value: string) => {
    edited()
    setDraft((previous) => {
      const next = { ...previous }
      if (value) next[name] = value
      else delete next[name]
      return next
    })
  }
  return (
    <div ref={ref}>
      <SettingsSection
        title={t('instructions')}
        description={t('instructionsHelp')}
        data-testid="custom-instructions"
        aria-busy={busy}
      >
        {replaced && (
          <Banner
            tone="info"
            action={
              onRunConfiguration && (
                <Button
                  size="small"
                  data-testid="custom-instructions-run-config"
                  onClick={onRunConfiguration}
                >
                  {t('openRunConfig')}
                </Button>
              )
            }
          >
            {t('replaced')}
          </Banner>
        )}
        {failed && (
          <Banner tone="error" role="alert">
            {t('failed')}
          </Banner>
        )}
        <SettingsGroup>
          <SettingsItem stacked label={t('how')} labelId="custom-instructions-how-label">
            <SettingsTextArea
              id="custom-instructions-how"
              data-testid="system-prompt-personaPrefix"
              aria-labelledby="custom-instructions-how-label"
              rows={4}
              maxLength={8192}
              placeholder={t('howPlaceholder')}
              value={draft.personaPrefix ?? ''}
              disabled={locked}
              onChange={(event) => edit('personaPrefix', event.currentTarget.value)}
            />
          </SettingsItem>
          <SettingsItem stacked label={t('style')} labelId="custom-instructions-style-label">
            <SettingsInput
              id="custom-instructions-style"
              data-testid="system-prompt-replyStyle"
              aria-labelledby="custom-instructions-style-label"
              maxLength={8192}
              placeholder={t('stylePlaceholder')}
              value={draft.replyStyle ?? ''}
              disabled={locked}
              onChange={(event) => edit('replyStyle', event.currentTarget.value)}
            />
          </SettingsItem>
          {hadClosing && (
            <SettingsItem stacked label={t('suffix')} labelId="custom-instructions-closing-label">
              <SettingsTextArea
                id="custom-instructions-closing"
                data-testid="system-prompt-personaSuffix"
                aria-labelledby="custom-instructions-closing-label"
                rows={3}
                maxLength={8192}
                value={draft.personaSuffix ?? ''}
                disabled={locked}
                onChange={(event) => edit('personaSuffix', event.currentTarget.value)}
              />
            </SettingsItem>
          )}
        </SettingsGroup>
        <SettingsFooter
          status={
            saved && !dirty ? (
              <span data-testid="system-prompt-saved">{t('saved')}</span>
            ) : snapshot && !canSave && !replaced ? (
              t('readOnly')
            ) : undefined
          }
        >
          <Button
            appearance="primary"
            data-testid="system-prompt-save"
            disabled={locked || !dirty}
            loading={busy && dirty}
            onClick={() => void save(draft, false)}
          >
            {t('save')}
          </Button>
        </SettingsFooter>
      </SettingsSection>
    </div>
  )
}

let documentLocale: UiLocaleSource | undefined

/** What the settings dialog adds to its General page, with the language the document is in. */
export function SettingsGeneralExtras() {
  documentLocale ??= createDocumentLocaleSource({}).source
  return (
    <UiLocaleProvider source={documentLocale}>
      <CustomInstructions
        onRunConfiguration={() =>
          document
            .getElementById('config-form')
            ?.dispatchEvent(
              new CustomEvent('agnes:settings-route', { detail: 'system-prompt', bubbles: true }),
            )
        }
      />
    </UiLocaleProvider>
  )
}
