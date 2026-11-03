import type {
  RefinementSettings,
  RefinementSettingsSaveResult,
  RefinementSettingsSnapshot,
} from '@agnes/protocol'
import { settingsSections } from '@agnes/web-client'
import {
  Banner,
  fallbackT,
  reportSuccess,
  SettingsBlock,
  SettingsItem,
  SettingsSelect,
  StateSwitch,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { REFINEMENT_SETTINGS_NAMESPACE, refinementSettingsCatalog } from './refinement-locale.js'
import { type SavedSkillsApi, SavedSkillsBlock } from './refinement-skills.js'
import { failureCode } from './side-models/model.js'

/** The daemon's refinement switch: read it with its revision, save it against that revision. */
export type RefinementSettingsApi = {
  read(): Promise<RefinementSettingsSnapshot>
  save(settings: RefinementSettings, expectedRevision: string): Promise<RefinementSettingsSaveResult>
  /** The skills task experience saved in a workspace; absent where the connection cannot reach them. */
  savedSkills?: SavedSkillsApi
}

const sameSettings = (a: RefinementSettings, b: RefinementSettings) =>
  a.enabled === b.enabled && a.mode === b.mode

/** This viewer has dismissed the one-time notice about saving to the workspace (browser storage only). */
const NOTICE_KEY = 'agnes.refinement.workspace-notice'
const noticeDismissed = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(NOTICE_KEY) === 'dismissed'
  } catch {
    return false
  }
}
const dismissNotice = (): void => {
  try {
    globalThis.localStorage?.setItem(NOTICE_KEY, 'dismissed')
  } catch {
    // Without browser storage the notice only stays closed for this visit.
  }
}
/**
 * The experience-refinement section: the master switch (off by default), how reviews start, what
 * turning it on allows and what to expect. Every change saves itself against the revision last read;
 * a conflicting save reloads the section.
 */
export function RefinementSettingsPanel({ api }: { api: RefinementSettingsApi }) {
  const { t } = useUiText(REFINEMENT_SETTINGS_NAMESPACE, refinementSettingsCatalog)
  const [snapshot, setSnapshot] = useState<RefinementSettingsSnapshot>()
  const [failed, setFailed] = useState(false)
  const [reads, setReads] = useState(0)
  const [conflict, setConflict] = useState(false)
  const [generation, setGeneration] = useState(0)
  // Shown once, to a profile that had refinement on when this section was first read: saving to the
  // workspace now takes effect without asking again. Turning it on here shows the grants instead.
  const [notice, setNotice] = useState<boolean>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    let live = true
    setFailed(false)
    void api.read().then(
      (value) => {
        if (!live) return
        setSnapshot(value)
        setNotice((shown) => shown ?? (value.settings.enabled && !noticeDismissed()))
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [api, reads])
  if (!snapshot)
    return (
      <div className="refinement-settings" data-testid="refinement-settings">
        <SettingsBlock state={failed ? 'error' : 'loading'} onReload={() => setReads((count) => count + 1)} />
      </div>
    )
  return (
    <div className="refinement-settings" data-testid="refinement-settings">
      {notice && (
        <Banner
          tone="info"
          data-testid="refinement-workspace-notice"
          dismissLabel={t('refinement.notice.dismiss')}
          onDismiss={() => {
            dismissNotice()
            setNotice(false)
          }}
        >
          {t('refinement.notice')}
        </Banner>
      )}
      {conflict && (
        <Banner tone="warning" data-testid="refinement-conflict">
          {t('refinement.conflict')}
        </Banner>
      )}
      <RefinementFields
        key={generation}
        api={api}
        snapshot={snapshot}
        t={t}
        onSaved={() => setConflict(false)}
        onConflict={(fresh) => {
          setSnapshot(fresh)
          setGeneration((count) => count + 1)
          setConflict(true)
        }}
      />
      {api.savedSkills && <SavedSkillsBlock api={api.savedSkills} />}
    </div>
  )
}

type Text = (key: string, vars?: Record<string, string | number>) => string

function RefinementFields(props: {
  api: RefinementSettingsApi
  snapshot: RefinementSettingsSnapshot
  t: Text
  onSaved(): void
  onConflict(fresh: RefinementSettingsSnapshot): void
}) {
  const { api, snapshot, t } = props
  const [stored, setStored] = useState(snapshot.settings)
  // Read when a save is sent, so a save queued behind another one uses the revision the first returned.
  const revision = useRef(snapshot.revision)
  // Turning the switch on is saved at once but reaches the tools only after a restart: say so until
  // the section is left, rather than let the saved switch suggest it is already working.
  const turnedOn = useRef(false)
  const [restart, setRestart] = useState(false)
  const autosave = useAutosave<RefinementSettings>({
    stored,
    equal: sameSettings,
    onSaved: () => {
      props.onSaved()
      reportSuccess(
        'settings:refinement',
        fallbackT('ui.settingsSaved'),
        turnedOn.current ? { kind: 'restart-required', message: t('refinement.restart') } : undefined,
      )
    },
    save: async (next) => {
      try {
        const saved = await api.save(next, revision.current)
        revision.current = saved.revision
        setStored(next)
        const raised = next.enabled && !stored.enabled
        turnedOn.current = next.enabled && (turnedOn.current || raised)
        setRestart(turnedOn.current)
      } catch (error) {
        // The conflict error names no current state: read it again and show it. The edit that lost is
        // dropped, and the save ends as a failure, not a success: a success would clear the banner
        // just raised and say "Settings saved." about a change that was thrown away.
        if (failureCode(error) !== 'CONFIG_REVISION_CONFLICT') throw error
        props.onConflict(await api.read())
        throw error
      }
    },
  })
  const settings = autosave.value ?? stored
  const change = (patch: Partial<RefinementSettings>) => autosave.set({ ...settings, ...patch }, 'now')
  return (
    <>
      <SettingsBlock
        label={t('refinement.group.main')}
        aria-busy={autosave.busy}
        failed={autosave.failed}
        onRetry={autosave.retry}
      >
        <SettingsItem label={t('refinement.enabled')} description={t('refinement.enabled.hint')}>
          <StateSwitch
            id="refinement-enabled"
            testId="refinement-enabled"
            label={t('refinement.enabled')}
            checked={settings.enabled}
            disabled={false}
            onToggle={(next) => change({ enabled: next })}
          />
        </SettingsItem>
        {restart && settings.enabled && (
          <Banner tone="info" data-testid="refinement-restart">
            {t('refinement.restart')}
          </Banner>
        )}
        <SettingsItem label={t('refinement.mode')} description={t('refinement.mode.hint')}>
          <SettingsSelect
            id="refinement-mode"
            data-testid="refinement-mode"
            aria-label={t('refinement.mode')}
            value={settings.mode}
            onChange={(event) => change({ mode: event.target.value === 'auto' ? 'auto' : 'manual' })}
          >
            <option value="manual">{t('refinement.mode.manual')}</option>
            <option value="auto">{t('refinement.mode.auto')}</option>
          </SettingsSelect>
        </SettingsItem>
      </SettingsBlock>
      <SettingsBlock label={t('refinement.group.allows')} data-testid="refinement-permissions">
        {(['install', 'skill', 'memory'] as const).map((name) => (
          <SettingsItem
            key={name}
            data-testid={`refinement-allows-${name}`}
            label={t(`refinement.allows.${name}`)}
            description={t(`refinement.allows.${name}.hint`)}
          />
        ))}
        <SettingsItem
          data-testid="refinement-allows-undo"
          label={t('refinement.allows.undo')}
          description={t('refinement.allows.undo.hint')}
        />
      </SettingsBlock>
      <SettingsBlock label={t('refinement.group.notes')}>
        <SettingsItem
          data-testid="refinement-approvals"
          label={t('refinement.approvals')}
          description={t('refinement.approvals.hint')}
        />
        <SettingsItem
          data-testid="refinement-cost"
          label={t('refinement.cost')}
          description={t('refinement.cost.hint')}
        />
      </SettingsBlock>
    </>
  )
}

/** Installed with the web client, which owns the settings calls; the section needs no runtime catalog. */
export function registerRefinementSettingsSection(api: RefinementSettingsApi): () => void {
  return settingsSections.register({
    id: 'refinement',
    group: 'general',
    order: 21,
    icon: 'sparkles',
    runtimeCatalog: false,
    titleKey: 'settings-shell.refinement',
    groupTitleKey: 'settings-shell.group.general',
    component: () => <RefinementSettingsPanel api={api} />,
  })
}
