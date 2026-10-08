import {
  Button,
  Field,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { sessionStartUrl } from './runtime-panels.js'

type Config = {
  rulesEnabled: boolean
  timeEnabled: boolean
  timeZone: string
  customSkillRoots: string[]
  refreshIntervalMs: number
  maxBytes: number
  maxSourceBytes: number
  instructionFiles: string[]
  localInstructionFiles: string[]
}
type Snapshot = {
  config: Config
  workspaces: { path: string; available: boolean }[]
  rules?: { files: { path: string; scope: string; content: string; trust: string }[]; skipped: string[] }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
function validSnapshot(value: unknown): value is Snapshot {
  const snapshot = object(value)
  const config = object(snapshot?.config)
  if (
    !config ||
    typeof config.rulesEnabled !== 'boolean' ||
    typeof config.timeEnabled !== 'boolean' ||
    typeof config.timeZone !== 'string' ||
    !['refreshIntervalMs', 'maxBytes', 'maxSourceBytes'].every(
      (key) => typeof config[key] === 'number' && Number.isFinite(config[key]),
    ) ||
    !['customSkillRoots', 'instructionFiles', 'localInstructionFiles'].every((key) => strings(config[key])) ||
    !Array.isArray(snapshot?.workspaces) ||
    !snapshot.workspaces.every((entry) => {
      const workspace = object(entry)
      return typeof workspace?.path === 'string' && typeof workspace.available === 'boolean'
    })
  )
    return false
  if (snapshot.rules === undefined) return true
  const rules = object(snapshot.rules)
  return (
    !!rules &&
    strings(rules.skipped) &&
    Array.isArray(rules.files) &&
    rules.files.every((entry) => {
      const file = object(entry)
      return !!file && ['path', 'scope', 'content', 'trust'].every((key) => typeof file[key] === 'string')
    })
  )
}
export async function contextRequest(
  input: { cwd?: string; config?: Config },
  fetcher = fetch,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const response = await fetcher('/api/context', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error('context unavailable')
  const value: unknown = await response.json()
  if (!validSnapshot(value)) throw new Error('invalid context response')
  return value
}
export function ContextPanel({ canSave }: { canSave: boolean }) {
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [config, setConfig] = useState<Config>()
  const [cwd, setCwd] = useState('')
  const [roots, setRoots] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState(false)
  const [skill, setSkill] = useState('')
  const [args, setArgs] = useState('')
  useEffect(() => {
    let current = true
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(true)
    void contextRequest({}, fetch, abort.signal)
      .then((value) => {
        if (!current) return
        setSnapshot(value)
        setConfig(value.config)
        setRoots(value.config.customSkillRoots.join('\n'))
      })
      .catch(() => {
        if (current) setError(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      abort.abort()
    }
  }, [])
  async function refresh(save = false) {
    if (busy) return
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      const value = await contextRequest(
        {
          ...(cwd ? { cwd } : {}),
          ...(save && config
            ? {
                config: {
                  ...config,
                  customSkillRoots: roots
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              }
            : {}),
        },
        fetch,
        lifetime.current?.signal,
      )
      if (lifetime.current?.signal.aborted) return
      setSnapshot(value)
      setConfig(value.config)
      setRoots(value.config.customSkillRoots.join('\n'))
      setSaved(save)
    } catch {
      if (!lifetime.current?.signal.aborted) setError(true)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  return (
    <SettingsCard data-testid="context-panel" aria-busy={busy}>
      <p>{t('contextHelp')}</p>
      {error && <SettingsState tone="error">{t('contextFailed')}</SettingsState>}
      {saved && <SettingsState tone="success">{t('contextSaved')}</SettingsState>}
      {config && (
        <fieldset disabled={!canSave || busy}>
          <legend>{t('contextDefaults')}</legend>
          <label className="agnes-settings-checkbox" htmlFor="context-rules-enabled">
            <SettingsInput
              id="context-rules-enabled"
              data-testid="context-rules-enabled"
              type="checkbox"
              checked={config.rulesEnabled}
              onChange={(e) => setConfig({ ...config, rulesEnabled: e.target.checked })}
            />
            {t('contextRules')}
          </label>
          <label className="agnes-settings-checkbox" htmlFor="context-time-enabled">
            <SettingsInput
              id="context-time-enabled"
              data-testid="context-time-enabled"
              type="checkbox"
              checked={config.timeEnabled}
              onChange={(e) => setConfig({ ...config, timeEnabled: e.target.checked })}
            />
            {t('contextTime')}
          </label>
          <Field label={t('contextZone')} htmlFor="context-zone">
            <SettingsInput
              id="context-zone"
              data-testid="context-zone"
              value={config.timeZone}
              onChange={(e) => setConfig({ ...config, timeZone: e.target.value })}
            />
          </Field>
          <Field label={t('contextInterval')} htmlFor="context-interval">
            <SettingsInput
              id="context-interval"
              type="number"
              min={0}
              max={86400000}
              value={config.refreshIntervalMs}
              onChange={(e) => setConfig({ ...config, refreshIntervalMs: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('contextRoots')} htmlFor="context-roots">
            <SettingsTextArea
              id="context-roots"
              data-testid="context-skill-roots"
              value={roots}
              onChange={(e) => setRoots(e.target.value)}
            />
          </Field>
          <Button data-testid="context-save" onClick={() => void refresh(true)}>
            {t('contextSave')}
          </Button>
        </fieldset>
      )}
      <Field label={t('workspace')} htmlFor="context-workspace">
        <SettingsSelect
          id="context-workspace"
          data-testid="context-workspace"
          disabled={busy}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        >
          <option value="">{t('contextChoose')}</option>
          {snapshot?.workspaces
            .filter((w) => w.available)
            .map((w) => (
              <option key={w.path} value={w.path}>
                {w.path}
              </option>
            ))}
        </SettingsSelect>
      </Field>
      <Button data-testid="context-refresh" disabled={busy} onClick={() => void refresh()}>
        {t('contextRefresh')}
      </Button>
      <p>{t('contextScopeHelp')}</p>
      {snapshot?.rules && (
        <div data-testid="context-rule-files">
          {!snapshot.rules.files.length && <p>{t('contextNoRules')}</p>}
          {snapshot.rules.files.map((file) => (
            <details key={file.path}>
              <summary>
                {file.path} · {file.scope} · {file.trust}
              </summary>
              <pre>{file.content}</pre>
            </details>
          ))}
          {snapshot.rules.skipped.length > 0 && (
            <SettingsState tone="success">
              {t('contextSkipped')}: {snapshot.rules.skipped.join(', ')}
            </SettingsState>
          )}
        </div>
      )}
      <h3>{t('contextSkillInvoke')}</h3>
      <Field label={t('contextSkillName')} htmlFor="context-skill">
        <SettingsInput
          id="context-skill"
          data-testid="context-skill-name"
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
        />
      </Field>
      <Field label={t('contextSkillArgs')} htmlFor="context-skill-args">
        <SettingsInput id="context-skill-args" value={args} onChange={(e) => setArgs(e.target.value)} />
      </Field>
      <Button
        data-testid="context-skill-invoke"
        disabled={!skill.trim() || /\s/.test(skill.trim())}
        href={sessionStartUrl(undefined, `/skill invoke ${skill.trim()} ${args}`)}
      >
        {t('contextSkillInvoke')}
      </Button>
      <p>{t('contextQuestionHelp')}</p>
    </SettingsCard>
  )
}
