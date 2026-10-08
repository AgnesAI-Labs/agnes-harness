import type { AuthoringCandidate, AuthoringCandidateSummary } from '@agnes/protocol'
import { Badge, Button, SettingsToolbar } from '@agnes/web-ui'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { PluginAdminApi } from './api.js'
import { CandidateListFacts, candidateIdentity } from './candidate-list.js'
import {
  addedPermissions,
  CandidateDelta,
  CandidateFileDiff,
  CandidateTechnical,
  type CandidateText,
} from './candidate-review.js'

type ListFacts = {
  candidateHash: string
  identity: ReturnType<typeof candidateIdentity>
  startedAt?: string | undefined
}

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
  sessionTitle,
  sessionTurnTime,
}: {
  api: PluginAdminApi | undefined
  canReview: boolean
  canTest: boolean
  t: CandidateText
  confirm: (input: Confirmation) => void
  onPublished: () => Promise<void>
  sessionTitle?: ((key: string) => Promise<string | undefined>) | undefined
  sessionTurnTime?: ((key: string, turn: number) => Promise<string | undefined>) | undefined
}) {
  const [items, setItems] = useState<AuthoringCandidateSummary[]>([]),
    [selected, setSelected] = useState<AuthoringCandidate>(),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [originTitle, setOriginTitle] = useState<string>()
  const [facts, setFacts] = useState<Record<string, ListFacts>>({})
  const review = useRef<HTMLElement>(null)
  const originKey = selected?.origin.sessionKey
  useEffect(() => {
    let alive = true
    setOriginTitle(undefined)
    if (originKey && sessionTitle)
      void sessionTitle(originKey)
        .then((title) => {
          if (alive) setOriginTitle(title)
        })
        .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [originKey, sessionTitle])
  const selectedId = selected?.candidateId
  useEffect(() => {
    if (!selectedId) return
    let frame = 0
    const reveal = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => review.current?.scrollIntoView({ block: 'nearest' }))
    }
    reveal()
    window.addEventListener('resize', reveal)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', reveal)
    }
  }, [selectedId])
  useEffect(() => {
    if (!api) return
    let alive = true
    const cache = new Map<string, ListFacts>()
    const refresh = async () => {
      try {
        const value = await api.candidatesList()
        if (alive) {
          setItems(value.candidates)
          setLoaded(true)
          setError((current) => (current === t('candidates.unavailable') ? '' : current))
        }
        const entries: [string, ListFacts | undefined][] = []
        // Hydrate only presentation facts, with bounded I/O and without retaining every file tree.
        for (let offset = 0; offset < value.candidates.length && alive; offset += 4) {
          entries.push(
            ...(await Promise.all(
              value.candidates.slice(offset, offset + 4).map(async (item) => {
                const key = `${item.candidateId}:${item.candidateHash}:${item.state}`
                let detail = cache.get(key)
                if (!detail) {
                  try {
                    const candidate = await api.candidatesShow(item.candidateId)
                    const startedAt = await sessionTurnTime?.(
                      candidate.origin.sessionKey,
                      candidate.origin.turn,
                    ).catch(() => undefined)
                    detail = {
                      candidateHash: candidate.candidateHash,
                      identity: candidateIdentity(candidate),
                      startedAt,
                    }
                    cache.set(key, detail)
                  } catch {
                    /* A missing candidate remains visible and can be refreshed. */
                  }
                }
                return [item.candidateId, detail] as [string, ListFacts | undefined]
              }),
            )),
          )
        }
        const liveKeys = new Set(
          value.candidates.map((item) => `${item.candidateId}:${item.candidateHash}:${item.state}`),
        )
        for (const key of cache.keys()) if (!liveKeys.has(key)) cache.delete(key)
        if (alive) {
          setItems(value.candidates)
          setFacts(Object.fromEntries(entries.flatMap(([id, detail]) => (detail ? [[id, detail]] : []))))
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
  }, [api, t, sessionTurnTime])
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
      facts: <CandidateTechnical value={value} t={t} />,
      run: () => act(() => api.candidatesDecide(value.candidateId, value.candidateHash, reviewHash, approve)),
    })
  }
  const ordered = [...items].sort(
    (a, b) =>
      Number(b.state === 'review') - Number(a.state === 'review') ||
      (Date.parse(facts[b.candidateId]?.startedAt ?? '') || 0) -
        (Date.parse(facts[a.candidateId]?.startedAt ?? '') || 0) ||
      a.packageId.localeCompare(b.packageId) ||
      a.state.localeCompare(b.state),
  )
  const title = originTitle || t('candidates.untitledSession')
  const permissions = selected ? addedPermissions(selected) : undefined
  const tone = (state: string) =>
    state === 'published'
      ? ('ok' as const)
      : state === 'review'
        ? ('warn' as const)
        : ['failed', 'interrupted'].includes(state)
          ? ('bad' as const)
          : ('off' as const)
  if (loaded && !items.length && !selected && !error) return null
  return (
    <section className="plugin-candidates" data-testid="plugin-candidates" aria-label={t('candidates.title')}>
      <SettingsToolbar>
        {selected ? (
          <Button data-testid="candidate-back" disabled={busy} onClick={() => setSelected(undefined)}>
            {t('candidates.back')}
          </Button>
        ) : (
          <h3>{t('candidates.title')}</h3>
        )}
        <Button
          data-testid="candidate-refresh"
          disabled={!api || busy}
          onClick={() =>
            void refresh()
              .then(() => setSelected(undefined))
              .catch(() => setError(t('candidates.unavailable')))
          }
        >
          {t('candidates.refresh')}
        </Button>
      </SettingsToolbar>
      {error && (
        <p role="alert" data-testid="candidate-error">
          {error}
        </p>
      )}
      {!selected ? (
        <>
          <p>{t('candidates.description')}</p>
          {!items.length ? (
            <p>{t('candidates.empty')}</p>
          ) : (
            <ul className="candidate-list" data-testid="candidate-list">
              {ordered.map((value) => (
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
                    <span>
                      <strong>{value.packageId}</strong>
                      {facts[value.candidateId] &&
                      facts[value.candidateId]!.candidateHash === value.candidateHash ? (
                        <CandidateListFacts
                          identity={facts[value.candidateId]!.identity}
                          startedAt={facts[value.candidateId]!.startedAt}
                          t={t}
                        />
                      ) : (
                        <span className="candidate-list-facts">{t('candidates.metadataUnavailable')}</span>
                      )}
                    </span>
                    <Badge tone={tone(value.state)}>{t('candidates.state.' + value.state)}</Badge>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <section
          ref={review}
          className="candidate-review-panel"
          data-testid="candidate-review"
          aria-label={t('candidates.review')}
        >
          <header className="candidate-summary" data-testid="candidate-summary">
            <div className="candidate-summary-heading">
              <h4>{selected.packageId}</h4>
              <span data-testid="candidate-state">
                <Badge tone={tone(selected.state)}>{t('candidates.state.' + selected.state)}</Badge>
              </span>
            </div>
            <p>
              {t(selected.baseHash === null ? 'candidates.summaryNew' : 'candidates.summaryUpdate', {
                session: title,
              })}
            </p>
            <p title={title} data-testid="candidate-provenance">
              {t('candidates.byAgent', { session: title, turn: selected.origin.turn })}
            </p>
            <div className="candidate-summary-facts">
              <span data-testid="candidate-tests">
                {selected.tests?.state === 'passed'
                  ? t(selected.tests.count === 1 ? 'candidates.testsPassed' : 'candidates.testsPassedTotal', {
                      count: selected.tests.count,
                    })
                  : selected.tests
                    ? t('candidates.testsFailed', { count: selected.tests.count })
                    : t('candidates.tests.none')}
              </span>
              <span>
                {permissions === undefined
                  ? t('candidates.permissionsUnknown')
                  : permissions === 0
                    ? t('candidates.noNewPermissions')
                    : t('candidates.permissionsCount', { count: permissions })}
              </span>
            </div>
          </header>
          <div className="candidate-review-body" data-testid="candidate-review-body">
            <CandidateDelta value={selected} t={t} />
            <section aria-label={t('candidates.diff')}>
              <h4>{t('candidates.diff')}</h4>
              {selected.files.map((file) => (
                <CandidateFileDiff key={selected.candidateId + ':' + file.path} file={file} t={t} />
              ))}
            </section>
            <CandidateTechnical value={selected} t={t} />
          </div>
          <SettingsToolbar className="candidate-review-actions" data-testid="candidate-actions">
            {selected.state !== 'review' &&
              !['published', 'rejected', 'publishing', 'interrupted'].includes(selected.state) && (
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
                        facts: <CandidateTechnical value={value} t={t} />,
                        run: () => act(() => api.candidatesTest(value.candidateId, value.candidateHash)),
                      })
                  }}
                >
                  {t('candidates.runTests')}
                </Button>
              )}
            {selected.state === 'tested' && (
              <Button
                data-testid="candidate-submit"
                disabled={!api || !canReview || busy || selected.state !== 'tested'}
                onClick={() => {
                  if (api) void act(() => api.candidatesSubmit(selected.candidateId, selected.candidateHash))
                }}
              >
                {t('candidates.submit')}
              </Button>
            )}
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
