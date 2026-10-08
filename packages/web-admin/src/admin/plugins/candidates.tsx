import type { AuthoringCandidate, AuthoringCandidateSummary } from '@agnes/protocol'
import { Button, SettingsToolbar } from '@agnes/web-ui'
import { type ReactNode, useEffect, useState } from 'react'
import type { PluginAdminApi } from './api.js'
import { CapabilityReview } from './capability-review.js'

type Confirmation = {
  title: string
  description: string
  label: string
  facts?: ReactNode
  run: () => Promise<void>
}
/** The same host review is used by CLI and Web; the page never authorizes a mutable directory. */
export function CandidateInbox({
  api,
  canReview,
  canTest,
  t,
  confirm,
  onPublished,
}: {
  api: PluginAdminApi | undefined
  canReview: boolean
  canTest: boolean
  t: (key: string) => string
  confirm: (input: Confirmation) => void
  onPublished: () => Promise<void>
}) {
  const [items, setItems] = useState<AuthoringCandidateSummary[]>([]),
    [selected, setSelected] = useState<AuthoringCandidate>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!api) return
    let alive = true
    const refresh = async () => {
      try {
        const value = await api.candidatesList()
        if (alive) {
          setItems(value.candidates)
        }
      } catch {
        if (alive) setError(t('candidates.unavailable'))
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, t])
  const refresh = async () => {
    if (api) setItems((await api.candidatesList()).candidates)
  }
  const act = async (fn: () => Promise<AuthoringCandidate>) => {
    setBusy(true)
    try {
      const value = await fn()
      setSelected(value)
      await refresh()
      setError('')
      if (value.state === 'published') await onPublished()
    } catch {
      setError(t('candidates.stale'))
      await refresh().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }
  const decide = (value: AuthoringCandidate, approve: boolean) => {
    if (!api || !value.reviewHash) return
    const reviewHash = value.reviewHash
    confirm({
      title: t(approve ? 'candidates.approve' : 'candidates.reject'),
      description: t(approve ? 'candidates.publishWarning' : 'candidates.rejectWarning'),
      label: t(approve ? 'candidates.approve' : 'candidates.reject'),
      facts: (
        <dl>
          <dt>{t('candidates.hash')}</dt>
          <dd>
            <code>{value.candidateHash}</code>
          </dd>
          <dt>{t('candidates.reviewHash')}</dt>
          <dd>
            <code>{reviewHash}</code>
          </dd>
        </dl>
      ),
      run: () => act(() => api.candidatesDecide(value.candidateId, value.candidateHash, reviewHash, approve)),
    })
  }
  return (
    <section className="plugin-candidates" data-testid="plugin-candidates" aria-label={t('candidates.title')}>
      <SettingsToolbar>
        <h3>{t('candidates.title')}</h3>
        <Button
          data-testid="candidate-refresh"
          disabled={!api || busy}
          onClick={() => void refresh().catch(() => setError(t('candidates.unavailable')))}
        >
          {t('candidates.refresh')}
        </Button>
      </SettingsToolbar>
      <p>{t('candidates.description')}</p>
      {error && (
        <p role="alert" data-testid="candidate-error">
          {error}
        </p>
      )}
      {!items.length ? (
        <p>{t('candidates.empty')}</p>
      ) : (
        <ul>
          {items.map((value) => (
            <li key={value.candidateId}>
              <Button
                data-testid="candidate-open"
                disabled={busy}
                onClick={() => {
                  if (api)
                    void api
                      .candidatesShow(value.candidateId)
                      .then(setSelected)
                      .catch(() => setError(t('candidates.unavailable')))
                }}
              >
                {value.packageId} · {t('candidates.state.' + value.state)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <section data-testid="candidate-review" aria-label={t('candidates.review')}>
          <h4>{selected.packageId}</h4>
          <p data-testid="candidate-state">{t('candidates.state.' + selected.state)}</p>
          <dl>
            <dt>{t('candidates.hash')}</dt>
            <dd data-testid="candidate-hash">
              <code>{selected.candidateHash}</code>
            </dd>
            <dt>{t('candidates.base')}</dt>
            <dd>
              <code>{selected.baseHash ?? t('candidates.new')}</code>
            </dd>
            <dt>{t('candidates.reviewHash')}</dt>
            <dd data-testid="candidate-review-hash">
              <code>{selected.reviewHash ?? t('candidates.none')}</code>
            </dd>
            <dt>{t('candidates.provenance')}</dt>
            <dd data-testid="candidate-provenance">
              installer={selected.installer} ·{' '}
              <span data-testid="candidate-origin">
                {selected.origin.sessionKey} · {selected.origin.toolUseId}
              </span>{' '}
              · {selected.origin.turn}
            </dd>
          </dl>
          <CapabilityReview value={selected.preview?.declaredCapabilities} t={t} />
          {selected.preview && (
            <section aria-label={t('candidates.delta')}>
              <h4>{t('candidates.delta')}</h4>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of reviewed source and test output. */}
              <pre
                role="region"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of the capability delta.
                tabIndex={0}
                aria-label={t('candidates.delta')}
                data-testid="candidate-capability-delta"
              >
                {JSON.stringify(selected.preview.capabilityDiff, null, 2)}
              </pre>
            </section>
          )}
          <section aria-label={t('candidates.tests')}>
            <h4>{t('candidates.tests')}</h4>
            <p data-testid="candidate-tests">
              {selected.tests ? (
                <>
                  {t('candidates.tests.' + selected.tests.state)} · {selected.tests.count} ·{' '}
                  <code data-testid="candidate-test-hash">{selected.tests.hash}</code>
                </>
              ) : (
                t('candidates.tests.none')
              )}
            </p>
            {selected.tests && (
              <details>
                <summary>{t('candidates.output')}</summary>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of reviewed source and test output. */}
                <pre role="region" tabIndex={0} aria-label={t('candidates.output')}>
                  {selected.tests.output}
                </pre>
              </details>
            )}
          </section>
          <section aria-label={t('candidates.diff')}>
            <h4>{t('candidates.diff')}</h4>
            {selected.files.map((file) => (
              <details key={file.path} data-testid="candidate-file-diff">
                <summary>{file.path}</summary>
                <h5>{t('candidates.before')}</h5>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of reviewed source and test output. */}
                <pre role="region" tabIndex={0} aria-label={`${t('candidates.before')} ${file.path}`}>
                  {file.before ?? t('candidates.absent')}
                </pre>
                <h5>{t('candidates.after')}</h5>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus enables keyboard scrolling of reviewed source and test output. */}
                <pre role="region" tabIndex={0} aria-label={`${t('candidates.after')} ${file.path}`}>
                  {file.after ?? t('candidates.absent')}
                </pre>
              </details>
            ))}
          </section>
          <SettingsToolbar>
            <Button
              data-testid="candidate-test"
              disabled={
                !api ||
                !canTest ||
                busy ||
                ['published', 'rejected', 'publishing', 'interrupted'].includes(selected.state)
              }
              onClick={() => {
                const value = selected
                if (api)
                  confirm({
                    title: t('candidates.runTests'),
                    description: t('candidates.testWarning'),
                    label: t('candidates.runTests'),
                    facts: <code>{value.candidateHash}</code>,
                    run: () => act(() => api.candidatesTest(value.candidateId, value.candidateHash)),
                  })
              }}
            >
              {t('candidates.runTests')}
            </Button>
            <Button
              data-testid="candidate-submit"
              disabled={!api || !canReview || busy || selected.state !== 'tested'}
              onClick={() => {
                if (api) void act(() => api.candidatesSubmit(selected.candidateId, selected.candidateHash))
              }}
            >
              {t('candidates.submit')}
            </Button>
            <Button
              type="primary"
              data-testid="candidate-approve"
              disabled={!api || !canReview || busy || selected.state !== 'review'}
              onClick={() => decide(selected, true)}
            >
              {t('candidates.approve')}
            </Button>
            <Button
              data-testid="candidate-reject"
              disabled={!api || !canReview || busy || selected.state !== 'review'}
              onClick={() => decide(selected, false)}
            >
              {t('candidates.reject')}
            </Button>
          </SettingsToolbar>
        </section>
      )}
    </section>
  )
}
