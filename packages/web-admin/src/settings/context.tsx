import {
  appServerErrorMessage,
  Banner,
  Button,
  IconButton,
  Select,
  SettingsCode,
  SettingsDetails,
  SettingsFooter,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsSection,
  SettingsState,
  SettingsTechnicalDetails,
  SettingsTextArea,
  StateSwitch,
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
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
    throw Object.assign(new Error('context unavailable'), { envelope: body?.error })
  }
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
  const [error, setError] = useState<unknown>(false)
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
      .catch((error) => {
        if (current) setError((error as { envelope?: unknown })?.envelope ?? true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      abort.abort()
    }
  }, [])
  async function refresh(save = false, workspace = cwd) {
    if (busy) return
    setBusy(true)
    setError(false)
    setSaved(false)
    try {
      const value = await contextRequest(
        {
          ...(workspace ? { cwd: workspace } : {}),
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
    } catch (error) {
      if (!lifetime.current?.signal.aborted) setError((error as { envelope?: unknown })?.envelope ?? true)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const stored = snapshot?.config
  const dirty =
    !!config &&
    !!stored &&
    (config.rulesEnabled !== stored.rulesEnabled ||
      config.timeEnabled !== stored.timeEnabled ||
      config.timeZone !== stored.timeZone ||
      config.refreshIntervalMs !== stored.refreshIntervalMs ||
      roots.trim() !== stored.customSkillRoots.join('\n'))
  const edit = (next: Config) => {
    setSaved(false)
    setConfig(next)
  }
  const locked = !canSave || busy
  const workspaces = snapshot?.workspaces.filter((entry) => entry.available) ?? []
  return (
    <div className="agnes-settings-stack" data-testid="context-panel" aria-busy={busy}>
      {Boolean(error) && (
        <Banner tone="error" role="alert">
          {appServerErrorMessage(error, document.documentElement.lang) ?? t('contextFailed')}
        </Banner>
      )}
      {busy && !config && <SettingsState tone="loading" />}
      {config && (
        <>
          <SettingsGroup>
            <SettingsItem label={t('contextRules')} description={t('contextRulesHint')}>
              <StateSwitch
                id="context-rules-enabled"
                testId="context-rules-enabled"
                label={t('contextRules')}
                disabled={locked}
                checked={config.rulesEnabled}
                onToggle={(checked) => edit({ ...config, rulesEnabled: checked })}
              />
            </SettingsItem>
            <SettingsItem label={t('contextTime')} description={t('contextTimeHint')}>
              <StateSwitch
                id="context-time-enabled"
                testId="context-time-enabled"
                label={t('contextTime')}
                disabled={locked}
                checked={config.timeEnabled}
                onToggle={(checked) => edit({ ...config, timeEnabled: checked })}
              />
            </SettingsItem>
            <SettingsItem
              label={t('contextZone')}
              description={t('contextZoneHint')}
              labelId="context-zone-label"
            >
              <SettingsInput
                id="context-zone"
                data-testid="context-zone"
                aria-labelledby="context-zone-label"
                disabled={locked || !config.timeEnabled}
                value={config.timeZone}
                onChange={(e) => edit({ ...config, timeZone: e.target.value })}
              />
            </SettingsItem>
            <SettingsItem
              label={t('contextInterval')}
              description={t('contextIntervalHint')}
              labelId="context-interval-label"
            >
              <SettingsInput
                id="context-interval"
                type="number"
                min={0}
                max={86400000}
                aria-labelledby="context-interval-label"
                disabled={locked || !config.timeEnabled}
                value={config.refreshIntervalMs}
                onChange={(e) => edit({ ...config, refreshIntervalMs: Number(e.target.value) })}
              />
            </SettingsItem>
            <SettingsItem
              stacked
              label={t('contextRoots')}
              description={t('contextRootsHint')}
              labelId="context-roots-label"
            >
              <SettingsTextArea
                id="context-roots"
                data-testid="context-skill-roots"
                aria-labelledby="context-roots-label"
                rows={2}
                disabled={locked}
                value={roots}
                onChange={(e) => {
                  setSaved(false)
                  setRoots(e.target.value)
                }}
              />
            </SettingsItem>
          </SettingsGroup>
          <SettingsFooter status={saved ? t('contextSaved') : undefined}>
            <Button
              appearance="primary"
              data-testid="context-save"
              disabled={locked || !dirty}
              loading={busy && dirty}
              onClick={() => void refresh(true)}
            >
              {t('contextSave')}
            </Button>
          </SettingsFooter>
        </>
      )}
      <SettingsSection
        title={t('contextLoaded')}
        description={t('contextScopeHelp')}
        actions={
          <>
            <Select<string>
              id="context-workspace"
              data-testid="context-workspace"
              aria-label={t('contextChoose')}
              disabled={busy || !workspaces.length}
              value={cwd || null}
              placeholder={t('contextChoose')}
              popupMatchSelectWidth={false}
              onChange={(value) => {
                setCwd(value)
                void refresh(false, value)
              }}
              options={workspaces.map((entry) => ({ value: entry.path, label: entry.path }))}
            />
            <IconButton
              name="refresh-cw"
              label={t('contextRefresh')}
              data-testid="context-refresh"
              disabled={busy || !cwd}
              onClick={() => void refresh()}
            />
          </>
        }
      >
        {!snapshot?.rules ? (
          <SettingsState>{t(workspaces.length ? 'contextPick' : 'contextNoWorkspace')}</SettingsState>
        ) : (
          <div className="agnes-settings-stack" data-testid="context-rule-files">
            {!snapshot.rules.files.length && <SettingsState>{t('contextNoRules')}</SettingsState>}
            {snapshot.rules.files.length > 0 && (
              <SettingsGroup>
                {snapshot.rules.files.map((file) => (
                  <SettingsDetails
                    key={file.path}
                    title={<span translate="no">{file.path}</span>}
                    summary={`${file.scope} · ${file.trust}`}
                  >
                    <SettingsCode label={file.path} copy={file.content}>
                      {file.content}
                    </SettingsCode>
                  </SettingsDetails>
                ))}
              </SettingsGroup>
            )}
            {snapshot.rules.skipped.length > 0 && (
              <SettingsState>
                {t('contextSkipped')}: {snapshot.rules.skipped.join(', ')}
              </SettingsState>
            )}
          </div>
        )}
      </SettingsSection>
      <SettingsTechnicalDetails data-testid="context-technical">
        <SettingsGroup>
          <SettingsItem stacked label={t('contextSkillInvoke')} description={t('contextSkillInvokeHint')}>
            <SettingsInput
              id="context-skill"
              data-testid="context-skill-name"
              aria-label={t('contextSkillName')}
              placeholder={t('contextSkillName')}
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
            />
            <SettingsInput
              id="context-skill-args"
              aria-label={t('contextSkillArgs')}
              placeholder={t('contextSkillArgs')}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
            <Button
              data-testid="context-skill-invoke"
              disabled={!skill.trim() || /\s/.test(skill.trim())}
              href={sessionStartUrl(undefined, `/skill invoke ${skill.trim()} ${args}`)}
            >
              {t('contextSkillStart')}
            </Button>
          </SettingsItem>
        </SettingsGroup>
      </SettingsTechnicalDetails>
    </div>
  )
}
