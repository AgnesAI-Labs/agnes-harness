import { Button, Icon, SettingsInput, SettingsState } from '@agnes/web-ui'
import { useState } from 'react'

type Text = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** Directory discovery supplies paths, not verified Skill metadata. */
export function SkillCandidates({
  candidates,
  busy,
  onSelect,
  t,
}: {
  candidates: string[]
  busy: boolean
  onSelect(path: string): void
  t: Text
}) {
  const [query, setQuery] = useState('')
  const filtered = candidates.filter((path) =>
    path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  return (
    <section className="skill-candidates" aria-label={t('skill.candidates.title')} aria-busy={busy}>
      <div className="skill-candidates-heading">
        <h4>{t('skill.candidates.title')}</h4>
        <span>{t('skill.candidates.count', { count: candidates.length })}</span>
      </div>
      <p className="skill-candidates-help">{t('skill.candidates.help')}</p>
      <SettingsInput
        type="search"
        value={query}
        disabled={busy}
        aria-label={t('skill.candidates.search')}
        placeholder={t('skill.candidates.search')}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <ul className="skill-candidates-list">
        {filtered.map((path) => {
          const name = path.split('/').filter(Boolean).at(-1) ?? '/'
          return (
            <li key={path}>
              <Button
                className="skill-candidate"
                disabled={busy}
                onClick={() => onSelect(path)}
                aria-label={t('skill.candidates.select', { name })}
              >
                <span className="skill-candidate-content">
                  <span className="skill-candidate-icon">
                    <Icon name="puzzle" size={20} />
                  </span>
                  <span className="skill-candidate-text">
                    <strong>{name}</strong>
                    <span className="skill-candidate-path">{path || '/'}</span>
                  </span>
                  <span className="skill-candidate-action">{t('skill.candidates.check')}</span>
                </span>
              </Button>
            </li>
          )
        })}
      </ul>
      {!filtered.length && <SettingsState>{t('skill.candidates.empty')}</SettingsState>}
    </section>
  )
}
