import type { VoiceSettings, VoiceSettingsSnapshot } from '@agnes/protocol'
import { settingsSections, type VoiceSettingsApi } from '@agnes/web-client'
import {
  Banner,
  Button,
  type ConfigIssue,
  configIssues,
  fallbackT,
  reportSuccess,
  SchemaControl,
  SettingsBlock,
  SettingsInput,
  SettingsItem,
  SettingsSelect,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { voiceConfigSchema } from './config-schemas.js'
import { failureCode } from './side-models/model.js'
import { VOICE_SETTINGS_NAMESPACE, voiceSettingsCatalog } from './voice-locale.js'

type Form = {
  inputEnabled: boolean
  language: string
  autoSend: boolean
  maxSeconds: number
  readingEnabled: boolean
  voice: string
  speed: number
  autoRead: boolean
  pauseSeconds: number
}
type TextField = 'language' | 'maxSeconds' | 'voice' | 'speed' | 'pauseSeconds'
type Account = Readonly<{ route: string; label: string }>

export function toVoiceForm(settings: VoiceSettings): Form {
  return {
    inputEnabled: settings.input.enabled,
    language: settings.input.language,
    autoSend: settings.input.autoSend,
    maxSeconds: settings.input.maxSeconds,
    readingEnabled: settings.reading.enabled,
    voice: settings.reading.voice,
    speed: settings.reading.speed,
    autoRead: settings.reading.autoRead,
    pauseSeconds: settings.conversation.pauseSeconds,
  }
}
export function fromVoiceForm(form: Form, account: string): VoiceSettings {
  return {
    account,
    input: {
      enabled: form.inputEnabled,
      language: form.language,
      autoSend: form.autoSend,
      maxSeconds: form.maxSeconds,
    },
    reading: { enabled: form.readingEnabled, voice: form.voice, speed: form.speed, autoRead: form.autoRead },
    conversation: { pauseSeconds: form.pauseSeconds },
  }
}

const field = (name: keyof Form) => voiceConfigSchema.properties[name]
const sameSettings = (a: VoiceSettings, b: VoiceSettings) => JSON.stringify(a) === JSON.stringify(b)
const NUMERIC: ReadonlySet<TextField> = new Set(['maxSeconds', 'speed', 'pauseSeconds'])
/** What a typed text means as the field's value; an empty or malformed number is NaN, which no range accepts. */
const parseText = (name: TextField, text: string): string | number =>
  NUMERIC.has(name) ? (text.trim() === '' ? Number.NaN : Number(text)) : text
const MESSAGE: Record<TextField, string> = {
  language: 'voice.error.language',
  maxSeconds: 'voice.error.integer',
  speed: 'voice.error.number',
  pauseSeconds: 'voice.error.number',
  voice: 'voice.error.invalid',
}

/**
 * The voice settings section: the account, voice input, read-aloud and conversation settings.
 * Every change saves itself against the revision last read; a conflicting save reloads the page.
 */
export function VoiceSettingsPanel({ api }: { api: VoiceSettingsApi }) {
  const { t } = useUiText(VOICE_SETTINGS_NAMESPACE, voiceSettingsCatalog)
  const [snapshot, setSnapshot] = useState<VoiceSettingsSnapshot>()
  const [accounts, setAccounts] = useState<readonly Account[]>([])
  const [failed, setFailed] = useState(false)
  const [reads, setReads] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [generation, setGeneration] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    let live = true
    setFailed(false)
    void api.read().then(
      (value) => {
        if (live) setSnapshot(value)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    // Without the account list the section still works; the route in use stays visible.
    void api.accounts().then(
      (rows) => {
        if (live) setAccounts(rows)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [api, reads])
  if (!snapshot)
    return (
      <div className="voice-settings" data-testid="voice-settings">
        <SettingsBlock state={failed ? 'error' : 'loading'} onReload={() => setReads((count) => count + 1)} />
      </div>
    )
  return (
    <div className="voice-settings" data-testid="voice-settings">
      {conflict && (
        <Banner tone="warning" data-testid="voice-conflict">
          {t('voice.conflict')}
        </Banner>
      )}
      <VoiceFields
        key={generation}
        api={api}
        snapshot={snapshot}
        accounts={accounts}
        t={t}
        onSaved={() => setConflict(false)}
        onConflict={(fresh) => {
          setSnapshot(fresh)
          setGeneration((count) => count + 1)
          setConflict(true)
        }}
      />
    </div>
  )
}

type Text = (key: string, vars?: Record<string, string | number>) => string

function VoiceFields(props: {
  api: VoiceSettingsApi
  snapshot: VoiceSettingsSnapshot
  accounts: readonly Account[]
  t: Text
  onSaved(): void
  onConflict(fresh: VoiceSettingsSnapshot): void
}) {
  const { api, snapshot, accounts, t } = props
  const [stored, setStored] = useState(snapshot.settings)
  // Read when a save is sent, so a save queued behind another one uses the revision the first returned.
  const revision = useRef(snapshot.revision)
  const [edits, setEdits] = useState<Partial<Record<TextField, string>>>({})
  const autosave = useAutosave<VoiceSettings>({
    stored,
    equal: sameSettings,
    onSaved: () => {
      props.onSaved()
      reportSuccess('settings:voice', fallbackT('ui.settingsSaved'))
    },
    save: async (next) => {
      try {
        const saved = await api.save(next, revision.current)
        revision.current = saved.revision
        setStored(saved.settings)
      } catch (error) {
        // The conflict error names no current state: read it again, show it, and drop the lost edit.
        if (failureCode(error) !== 'CONFIG_REVISION_CONFLICT') throw error
        props.onConflict(await api.read())
      }
    },
  })
  const settings = autosave.value ?? stored
  const form = toVoiceForm(settings)
  const issues = (name: TextField): readonly ConfigIssue[] => {
    const text = edits[name]
    if (text === undefined) return []
    return configIssues(voiceConfigSchema, { ...form, [name]: parseText(name, text) }).filter(
      (issue) => issue.path === `/${name}`,
    )
  }
  const change = (patch: Partial<Form>, when: 'now' | 'idle' = 'now') =>
    autosave.set(fromVoiceForm({ ...form, ...patch }, settings.account), when)
  const edit = (name: TextField, text: string) => {
    setEdits((current) => ({ ...current, [name]: text }))
    const value = parseText(name, text)
    if (
      configIssues(voiceConfigSchema, { ...form, [name]: value }).some((issue) => issue.path === `/${name}`)
    ) {
      // An invalid entry is never sent; it also cancels an earlier valid entry of this field that is still
      // waiting. Other fields keep their edits, including a switch whose save is on its way.
      if (!autosave.failed) change({ [name]: toVoiceForm(stored)[name] }, 'idle')
      return
    }
    change({ [name]: value } as Partial<Form>, 'idle')
  }
  const finish = (name: TextField) => {
    autosave.flush()
    if (issues(name).length === 0)
      setEdits((current) => {
        const { [name]: _done, ...rest } = current
        return rest
      })
  }
  const toggle = (name: 'inputEnabled' | 'autoSend' | 'readingEnabled' | 'autoRead') => (
    <SchemaControl
      schema={field(name)}
      value={form[name]}
      t={t}
      onChange={(value) => change({ [name]: value === true })}
    />
  )
  const text = (name: TextField): ReactNode => {
    const ui = field(name)['x-ui']
    const label = t(ui.labelKey)
    return (
      <SettingsInput
        id={ui.id}
        data-testid={ui.testId}
        aria-label={label}
        aria-invalid={issues(name).length > 0 || undefined}
        autoComplete="off"
        spellCheck={false}
        inputMode={NUMERIC.has(name) ? 'decimal' : 'text'}
        maxLength={
          name === 'language' || name === 'voice'
            ? (field(name) as { maxLength: number }).maxLength
            : undefined
        }
        value={edits[name] ?? String(form[name])}
        onChange={(event) => edit(name, event.target.value)}
        onBlur={() => finish(name)}
      />
    )
  }
  const row = (name: keyof Form, control: ReactNode) => {
    const ui = field(name)['x-ui']
    const problem = name in MESSAGE ? issues(name as TextField)[0] : undefined
    const schema = field(name) as { minimum?: number; maximum?: number }
    return (
      <SettingsItem
        key={name}
        label={t(ui.labelKey)}
        description={
          problem ? (
            <span role="alert" data-testid={`${ui.testId}-error`}>
              {t(MESSAGE[name as TextField], { min: schema.minimum ?? 0, max: schema.maximum ?? 0 })}
            </span>
          ) : 'hintKey' in ui ? (
            t(ui.hintKey)
          ) : undefined
        }
      >
        {control}
      </SettingsItem>
    )
  }
  return (
    <>
      <SettingsBlock
        label={t('voice.group.general')}
        aria-busy={autosave.busy}
        failed={autosave.failed}
        onRetry={autosave.retry}
      >
        <SettingsItem label={t('voice.account')} description={t('voice.account.hint')}>
          <SettingsSelect
            id="voice-account"
            data-testid="voice-account"
            aria-label={t('voice.account')}
            value={settings.account}
            onChange={(event) => autosave.set({ ...settings, account: event.target.value }, 'now')}
          >
            <option value="">{t('voice.account.auto')}</option>
            {accounts.map((account) => (
              <option key={account.route} value={account.route}>
                {account.label}
              </option>
            ))}
          </SettingsSelect>
        </SettingsItem>
        <SettingsItem label={t('voice.configure.title')} description={t('voice.configure.hint')}>
          <Button type="text" data-testid="voice-configure" onClick={() => api.openSideModels()}>
            {t('voice.configure')}
          </Button>
        </SettingsItem>
        <SettingsItem label={t('voice.privacy.title')}>
          <span data-testid="voice-privacy">{t('voice.privacy')}</span>
        </SettingsItem>
      </SettingsBlock>
      <SettingsBlock label={t('voice.group.input')}>
        {row('inputEnabled', toggle('inputEnabled'))}
        {row('language', text('language'))}
        {row('autoSend', toggle('autoSend'))}
        {row('maxSeconds', text('maxSeconds'))}
      </SettingsBlock>
      <SettingsBlock label={t('voice.group.reading')}>
        {row('readingEnabled', toggle('readingEnabled'))}
        {row('voice', text('voice'))}
        {row('speed', text('speed'))}
        {row('autoRead', toggle('autoRead'))}
      </SettingsBlock>
      <SettingsBlock label={t('voice.group.conversation')}>
        {row('pauseSeconds', text('pauseSeconds'))}
      </SettingsBlock>
    </>
  )
}

/** Installed by the voice controller, which owns the settings calls; the section needs no install. */
export function registerVoiceSettingsSection(api: VoiceSettingsApi): () => void {
  return settingsSections.register({
    id: 'voice',
    group: 'general',
    order: 20,
    icon: 'mic',
    runtimeCatalog: false,
    titleKey: 'settings-shell.voice',
    groupTitleKey: 'settings-shell.group.general',
    component: () => <VoiceSettingsPanel api={api} />,
  })
}
