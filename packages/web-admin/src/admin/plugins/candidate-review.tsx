import type { AuthoringCandidate } from '@agnes/protocol'
import { Badge } from '@agnes/web-ui'
import { useMemo, useState } from 'react'
import { candidateDiff } from './candidate-diff.js'

export type CandidateText = (key: string, params?: Record<string, string | number>) => string
const names: Record<string, string> = {
  network: 'network',
  exec: 'exec',
  secrets: 'secrets',
  credentials: 'credentials',
  'filesystem.read': 'read',
  'filesystem.write': 'write',
  model: 'model',
  childAgents: 'childAgents',
  ui: 'ui',
  device: 'device',
  tools: 'tools',
  hooks: 'hooks',
  slots: 'slots',
  resources: 'resources',
  services: 'services',
  projections: 'projections',
  'network.publicRead': 'publicRead',
  events: 'events',
  'tools.invoke': 'invoke',
  artifacts: 'artifacts',
  subagent: 'childAgents',
}
const registration = (atom: string) =>
  /^(tools|hooks|slots|resources|services|projections|ui):sha256-/.test(atom)
export function addedPermissions(value: AuthoringCandidate) {
  const delta = value.preview?.capabilityDiff
  return delta
    ? delta.added.filter((atom) => !registration(atom)).length + delta.serviceGrantsAdded.length
    : undefined
}
export function capabilityLabel(atom: string, t: CandidateText) {
  const colon = atom.indexOf(':'),
    key = colon < 0 ? atom : atom.slice(0, colon),
    scope = colon < 0 ? '' : atom.slice(colon + 1)
  const label = names[key] ? t('capability.' + names[key]) : t('candidates.otherCapability')
  return scope && !scope.startsWith('sha256-') ? `${label} · ${scope}` : label
}
export function CandidateDelta({ value, t }: { value: AuthoringCandidate; t: CandidateText }) {
  const delta = value.preview?.capabilityDiff
  if (!delta) return <p>{t('candidates.permissionsUnknown')}</p>
  const groups = [
    {
      label: t('candidates.permissionsAdded'),
      values: [
        ...delta.added.filter((atom) => !registration(atom)).map((atom) => capabilityLabel(atom, t)),
        ...delta.serviceGrantsAdded.map(
          (grant) => `${t('candidates.serviceAccess')} · ${grant.extension} / ${grant.name} (${grant.range})`,
        ),
      ],
    },
    {
      label: t('candidates.capabilitiesAdded'),
      values: delta.added.filter(registration).map((atom) => capabilityLabel(atom, t)),
    },
    {
      label: t('candidates.capabilitiesRemoved'),
      values: delta.removed.map((atom) => capabilityLabel(atom, t)),
    },
    { label: t('candidates.dependenciesAdded'), values: delta.dependenciesAdded },
    {
      label: t('candidates.runtimeRemoved'),
      values: delta.runtimeSupportRemoved.map((atom) =>
        t(
          atom.endsWith(':in-process')
            ? 'candidates.runtimeLocal'
            : atom.endsWith(':isolated')
              ? 'candidates.runtimeIsolated'
              : 'candidates.runtimeOther',
        ),
      ),
    },
  ]
  return (
    <section data-testid="candidate-capability-delta" aria-label={t('candidates.delta')}>
      {groups.map((group, i) =>
        group.values.length ? (
          <div key={group.label}>
            <h5>{group.label}</h5>
            <ul>
              {[...new Set(group.values)].map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        ) : i === 0 ? (
          <p key={group.label}>{t('candidates.noPermissionsAdded')}</p>
        ) : null,
      )}
    </section>
  )
}
export function CandidateFileDiff({
  file,
  t,
}: {
  file: AuthoringCandidate['files'][number]
  t: CandidateText
}) {
  const [open, setOpen] = useState(false)
  const lines = useMemo(
    () => (open ? candidateDiff(file.before, file.after) : []),
    [open, file.before, file.after],
  )
  return (
    <details
      className="candidate-file"
      data-testid="candidate-file-diff"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <code>{file.path}</code>
        <Badge tone={file.before === null ? 'ok' : file.after === null ? 'bad' : 'off'}>
          {t(
            file.before === null
              ? 'candidates.newFile'
              : file.after === null
                ? 'candidates.deletedFile'
                : 'candidates.modifiedFile',
          )}
        </Badge>
      </summary>
      {open && (
        <pre
          role="region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded source view supports keyboard scrolling.
          tabIndex={0}
          aria-label={`${t('candidates.diff')} ${file.path}`}
          data-testid="candidate-diff-lines"
        >
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are immutable text without component state.
            <span key={`${index}:${line.kind}`} className={`candidate-diff-line candidate-diff-${line.kind}`}>
              <span aria-hidden="true">
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}{' '}
              </span>
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </details>
  )
}
export function CandidateTechnical({ value, t }: { value: AuthoringCandidate; t: CandidateText }) {
  return (
    <details className="candidate-technical" data-testid="candidate-technical">
      <summary>{t('candidates.technical')}</summary>
      <dl>
        <dt>{t('candidates.hash')}</dt>
        <dd data-testid="candidate-hash">
          <code>{value.candidateHash}</code>
        </dd>
        <dt>{t('candidates.base')}</dt>
        <dd>
          <code>{value.baseHash ?? t('candidates.new')}</code>
        </dd>
        <dt>{t('candidates.reviewHash')}</dt>
        <dd data-testid="candidate-review-hash">
          <code>{value.reviewHash ?? t('candidates.none')}</code>
        </dd>
        <dt>{t('candidates.testHash')}</dt>
        <dd>
          <code data-testid="candidate-test-hash">{value.tests?.hash ?? t('candidates.tests.none')}</code>
        </dd>
        <dt>{t('candidates.provenance')}</dt>
        <dd data-testid="candidate-origin">
          <code>{JSON.stringify({ installer: value.installer, ...value.origin }, null, 2)}</code>
        </dd>
      </dl>
      <h5>{t('candidates.rawDelta')}</h5>
      <pre
        role="region"
        aria-label={t('candidates.rawDelta')}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling of bounded technical output.
        tabIndex={0}
      >
        {JSON.stringify(value.preview?.capabilityDiff ?? null, null, 2)}
      </pre>
      {value.tests && (
        <>
          <h5>{t('candidates.output')}</h5>
          <pre
            role="region"
            aria-label={t('candidates.output')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling of bounded test output.
            tabIndex={0}
          >
            {value.tests.output}
          </pre>
        </>
      )}
    </details>
  )
}
