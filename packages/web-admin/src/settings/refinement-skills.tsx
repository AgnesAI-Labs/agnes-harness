import type { RefinementSavedSkill, RefinementSkillsParams, RefinementSkillsResult } from '@agnes/protocol'
import {
  appServerErrorMessage,
  Banner,
  Button,
  SettingsBlock,
  SettingsItem,
  SettingsSelect,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { SAVED_SKILLS_NAMESPACE, savedSkillsCatalog } from './refinement-skills-locale.js'

/** The daemon's view of the skills task experience saved in a workspace, for the owner. */
export type SavedSkillsApi = {
  workspaces(): Promise<readonly { path: string; available: boolean }[]>
  skills(input: RefinementSkillsParams): Promise<RefinementSkillsResult>
}

const errorEnvelope = (error: unknown) =>
  (error as { envelope?: unknown; data?: unknown })?.envelope ?? (error as { data?: unknown })?.data ?? true

/**
 * The skills task experience installed in one workspace: whether each is on or awaiting review (the
 * 30-day review switched it off), who saved it, and the owner's uninstall and rollback; then the drafts
 * kept for a person instead of writing a skill they wrote or changed. A draft holds planner text, so it
 * is shown as plain text only.
 */
export function SavedSkillsBlock({ api }: { api: SavedSkillsApi }) {
  const { t, locale } = useUiText(SAVED_SKILLS_NAMESPACE, savedSkillsCatalog)
  const [workspaces, setWorkspaces] = useState<readonly { path: string; available: boolean }[]>([])
  const [cwd, setCwd] = useState('')
  const [result, setResult] = useState<RefinementSkillsResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    let live = true
    void api.workspaces().then(
      (listed) => {
        if (!live) return
        setWorkspaces(listed)
        setCwd(listed.find((workspace) => workspace.available)?.path ?? '')
      },
      (failure) => {
        if (live) setError(errorEnvelope(failure))
      },
    )
    return () => {
      live = false
    }
  }, [api])
  useEffect(() => {
    if (!cwd) return
    let live = true
    setResult(undefined)
    setError(undefined)
    void api.skills({ cwd, action: 'list' }).then(
      (value) => {
        if (live) setResult(value)
      },
      (failure) => {
        if (live) setError(errorEnvelope(failure))
      },
    )
    return () => {
      live = false
    }
  }, [api, cwd])
  const act = async (action: 'uninstall' | 'rollback', name: string) => {
    if (busy || !cwd) return
    setBusy(true)
    setError(undefined)
    try {
      setResult(await api.skills({ cwd, action, name }))
    } catch (failure) {
      setError(errorEnvelope(failure))
    } finally {
      setBusy(false)
    }
  }
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  const status = (skill: RefinementSavedSkill) =>
    [
      t(`skills.${skill.state}`, { date: date.format(skill.reviewAfter) }),
      t('skills.by', { who: t(`skills.initiator.${skill.initiator}`) }),
    ].join(' ')
  const available = workspaces.filter((workspace) => workspace.available)
  return (
    <SettingsBlock label={t('skills.title')} data-testid="refinement-saved-skills" aria-busy={busy}>
      <p className="agnes-settings-note">{t('skills.help')}</p>
      {available.length > 1 && (
        <SettingsItem label={t('skills.workspace')}>
          <SettingsSelect
            id="refinement-skills-workspace"
            data-testid="refinement-skills-workspace"
            aria-label={t('skills.workspace')}
            value={cwd}
            disabled={busy}
            onChange={(event) => setCwd(event.target.value)}
          >
            {available.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>
                {workspace.path}
              </option>
            ))}
          </SettingsSelect>
        </SettingsItem>
      )}
      {Boolean(error) && (
        <Banner tone="error" role="alert" data-testid="refinement-saved-skills-error">
          {appServerErrorMessage(error, locale) ?? t('skills.failed')}
        </Banner>
      )}
      {result && result.skills.length === 0 && <SettingsItem label={t('skills.none')} />}
      {result?.skills.map((skill) => (
        <SettingsItem
          key={skill.name}
          data-testid="refinement-saved-skill"
          label={<span translate="no">{skill.name}</span>}
          description={status(skill)}
        >
          <Button
            size="small"
            data-testid="refinement-saved-skill-rollback"
            disabled={busy || skill.previous.length === 0}
            onClick={() => void act('rollback', skill.name)}
          >
            {t('skills.rollback')}
          </Button>
          <Button
            size="small"
            data-testid="refinement-saved-skill-uninstall"
            disabled={busy}
            onClick={() => void act('uninstall', skill.name)}
          >
            {t('skills.uninstall')}
          </Button>
        </SettingsItem>
      ))}
      {Boolean(result?.drafts.length) && (
        <>
          <p className="agnes-settings-note">
            <strong>{t('skills.drafts')}</strong> {t('skills.drafts.help')}
          </p>
          {result?.drafts.map((draft) => (
            <div key={draft.id} data-testid="refinement-skill-draft">
              <SettingsItem
                label={<span translate="no">{draft.name}</span>}
                description={`${t(`skills.draft.${draft.reason}`, {})} ${date.format(draft.at)}`}
              />
              <pre className="agnes-settings-note" translate="no">
                {draft.diff}
              </pre>
            </div>
          ))}
        </>
      )}
    </SettingsBlock>
  )
}
