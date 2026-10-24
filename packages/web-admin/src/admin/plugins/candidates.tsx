import {
  type AuthoringCandidate,
  type AuthoringCandidateSummary,
  resolvePluginMetadata,
} from '@agnes/protocol'
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  ListRow,
  MetaText,
  PushCrumbs,
  reportSuccess,
  SettingsDetails,
  SettingsState,
  SettingsToolbar,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { visibleRefresh } from '../../visible-refresh.js'
import type { PluginAdminApi } from './api.js'
import { CandidateListFacts, candidateIdentity, candidateSkillText } from './candidate-list.js'
import {
  addedPermissions,
  CandidateDelta,
  CandidateFileDiff,
  CandidateTechnical,
  type CandidateText,
} from './candidate-review.js'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from './locales/admin.js'

type ListFacts = {
  candidateHash: string
  identity: ReturnType<typeof candidateIdentity>
  startedAt?: string | undefined
  metadata?: NonNullable<AuthoringCandidate['preview']>['metadata'] | undefined
  sourceTitle?: string | undefined
  skillText?: ReturnType<typeof candidateSkillText> | undefined
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
  scope,
  merged = false,
  type,
  onPendingCount,
  reviewSurface,
  openId,
  onSelectedChange,
}: {
  api: PluginAdminApi | undefined
  canReview: boolean
  canTest: boolean
  t: CandidateText
  confirm: (input: Confirmation) => void
  onPublished: () => Promise<void>
  sessionTitle?: ((key: string) => Promise<string | undefined>) | undefined
  sessionTurnTime?: ((key: string, turn: number) => Promise<string | undefined>) | undefined
  scope?: 'skill' | 'plugin'
  /** One list for plugin and skill candidates, in rows; `type` narrows it without a second read. */
  merged?: boolean
  type?: 'skill' | 'plugin' | undefined
  onPendingCount?(count: number): void
  reviewSurface?(content: ReactNode, onClose: () => void, candidate: AuthoringCandidate): ReactNode
  /**
   * The candidate the host's address names. Setting it opens that candidate; clearing it (the reader
   * went back) closes the one that is open.
   */
  openId?: string | undefined
  /** Which candidate is open, so the host can name it in its address. */
  onSelectedChange?(candidateId: string | undefined): void
}) {
  const { locale } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  const [items, setItems] = useState<AuthoringCandidateSummary[]>([]),
    [selected, setSelected] = useState<AuthoringCandidate>(),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [originTitle, setOriginTitle] = useState<string>(),
    [published, setPublished] = useState<AuthoringCandidate>()
  const [facts, setFacts] = useState<Record<string, ListFacts>>({})
  const review = useRef<HTMLElement>(null)
  const refreshFacts = useRef<(() => Promise<boolean>) | undefined>(undefined)
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
  const reportSelected = useRef(onSelectedChange)
  reportSelected.current = onSelectedChange
  const reportedSelection = useRef(selectedId)
  useEffect(() => {
    if (reportedSelection.current === selectedId) return
    reportedSelection.current = selectedId
    reportSelected.current?.(selectedId)
  }, [selectedId])
  // Follows the host's address only when it changes: opening a row here reports first, then the
  // address catches up.
  const showing = useRef(selectedId)
  showing.current = selectedId
  useEffect(() => {
    if (openId === undefined) {
      setBusy(false)
      if (showing.current !== undefined) setSelected(undefined)
      return
    }
    if (!api || openId === showing.current) return
    let alive = true
    setBusy(true)
    api
      .candidatesShow(openId)
      .then(
        (value) => {
          if (alive) setSelected(value)
        },
        () => {
          // A draft that is gone (or never was) leaves its page.
          if (alive) reportSelected.current?.(undefined)
        },
      )
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [api, openId])
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
    const read = async () => {
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
                      metadata: candidate.preview?.metadata,
                      skillText:
                        candidateIdentity(candidate).type === 'skill'
                          ? candidateSkillText(candidate)
                          : undefined,
                      sourceTitle: await sessionTitle?.(candidate.origin.sessionKey).catch(() => undefined),
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
          if (scope) {
            if (entries.some(([, detail]) => !detail)) {
              setError(t('candidates.metadataUnavailable'))
              return false
            } else setError((current) => (current === t('candidates.metadataUnavailable') ? '' : current))
          }
        }
        return true
      } catch {
        if (alive) setError(t('candidates.unavailable'))
        return false
      }
    }
    let result = false
    const reader = visibleRefresh(async () => {
      result = await read()
    }, ['agnes:plugins-invalidated', 'agnes:candidates-changed'])
    const refresh = async () => {
      await reader.request()
      return result
    }
    refreshFacts.current = refresh
    void refresh()
    return () => {
      alive = false
      reader.dispose()
      if (refreshFacts.current === refresh) refreshFacts.current = undefined
    }
  }, [api, t, sessionTurnTime, sessionTitle, scope])
  const refresh = async () => {
    await refreshFacts.current?.()
    window.dispatchEvent(new CustomEvent('agnes:candidate-count-changed'))
  }
  // Finish navigation reads before allowing another action to replace the selected review.
  const navigate = async (read: () => Promise<void | boolean>) => {
    setBusy(true)
    try {
      await read()
    } catch {
      setError(t('candidates.unavailable'))
    } finally {
      setBusy(false)
    }
  }
  const act = async (fn: () => Promise<AuthoringCandidate>) => {
    setBusy(true)
    try {
      const value = await fn()
      setError('')
      if (value.state === 'published') {
        setSelected(undefined)
        setPublished(value)
        reportSuccess('candidate-publish', t('candidates.publishSuccess'))
        await onPublished().catch(() => setError(t('candidates.unavailable')))
        await refresh().catch(() => setError(t('candidates.unavailable')))
      } else {
        setSelected(value)
        await refresh()
      }
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
  const visibleItems = scope
    ? items.filter(
        (item) =>
          facts[item.candidateId]?.candidateHash === item.candidateHash &&
          facts[item.candidateId]?.identity.type === scope,
      )
    : type
      ? items.filter((item) => facts[item.candidateId]?.identity.type === type)
      : items
  // The count is the whole inbox: narrowing the list by type must not change the tab's number.
  const pendingCount = (merged ? items : visibleItems).filter((item) => item.state === 'review').length
  useEffect(() => {
    onPendingCount?.(pendingCount)
  }, [onPendingCount, pendingCount])
  const ordered = [...visibleItems].sort(
    (a, b) =>
      Number(b.state === 'review') - Number(a.state === 'review') ||
      (Date.parse(facts[b.candidateId]?.startedAt ?? '') || 0) -
        (Date.parse(facts[a.candidateId]?.startedAt ?? '') || 0) ||
      a.packageId.localeCompare(b.packageId) ||
      a.state.localeCompare(b.state),
  )
  const terminal = (value: AuthoringCandidateSummary) =>
    ['published', 'rejected', 'interrupted'].includes(value.state)
  const pendingItems = ordered.filter((value) => !terminal(value))
  const history = ordered.filter(terminal)
  const renderItem = (value: AuthoringCandidateSummary) => (
    <li key={value.candidateId} data-candidate-id={value.candidateId}>
      {scope === 'skill' || merged ? (
        <ListRow
          icon={
            <Icon
              name={facts[value.candidateId]?.identity.type === 'plugin' ? 'puzzle' : 'file-text'}
              size={20}
            />
          }
          title={
            resolvePluginMetadata(facts[value.candidateId]?.metadata, locale)?.displayName ??
            facts[value.candidateId]?.skillText?.name ??
            value.packageId
          }
          description={
            resolvePluginMetadata(facts[value.candidateId]?.metadata, locale)?.summary ??
            facts[value.candidateId]?.skillText?.summary
          }
          meta={
            <>
              <span>{facts[value.candidateId]?.sourceTitle ?? t('candidates.untitledSession')}</span>
              {!['review', 'failed', 'interrupted'].includes(value.state) && (
                <MetaText> · {t('candidates.state.' + value.state)}</MetaText>
              )}
              {facts[value.candidateId] && (
                <CandidateListFacts
                  identity={facts[value.candidateId]!.identity}
                  startedAt={facts[value.candidateId]!.startedAt}
                  t={t}
                />
              )}
            </>
          }
          status={
            value.state === 'review' || ['failed', 'interrupted'].includes(value.state) ? (
              <Tag tone={tone(value.state) === 'bad' ? 'bad' : 'warn'}>
                {t('candidates.state.' + value.state)}
              </Tag>
            ) : undefined
          }
          actions={
            <Button
              data-testid="candidate-open"
              disabled={!api || busy}
              onClick={() => {
                if (api) void navigate(async () => setSelected(await api.candidatesShow(value.candidateId)))
              }}
            >
              {t('candidates.review')}
            </Button>
          }
        />
      ) : (
        <Button
          data-testid="candidate-open"
          disabled={busy}
          onClick={() => {
            if (api) void navigate(async () => setSelected(await api.candidatesShow(value.candidateId)))
          }}
        >
          <span>
            <strong>{value.packageId}</strong>
            {facts[value.candidateId] && facts[value.candidateId]!.candidateHash === value.candidateHash ? (
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
      )}
    </li>
  )
  const renderReview = (content: ReactNode) =>
    reviewSurface && selected
      ? reviewSurface(
          // The pushed page can portal outside the inbox; keep its review stylesheet scope.
          <section className="plugin-candidates">{content}</section>,
          () => setSelected(undefined),
          selected,
        )
      : content
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
  if (loaded && !visibleItems.length && !selected && !published && !error && scope !== 'skill' && !merged)
    return null
  return (
    <section className="plugin-candidates" data-testid="plugin-candidates" aria-label={t('candidates.title')}>
      <SettingsToolbar>
        {selected && !reviewSurface ? (
          // A candidate is a view inside the list: 「‹ Candidates › Package name」, the list is the way back.
          <PushCrumbs
            title={selected.packageId}
            crumbs={[t('candidates.title')]}
            backTestId="candidate-back"
            disabled={busy}
            onBack={() => setSelected(undefined)}
          />
        ) : (
          !merged && <h3>{t('candidates.title')}</h3>
        )}
        <Button
          data-testid="candidate-refresh"
          disabled={!api || busy}
          onClick={() =>
            void navigate(async () => {
              const ok = refreshFacts.current ? await refreshFacts.current() : (await refresh(), true)
              if (ok) setSelected(undefined)
              return ok
            })
          }
        >
          {t('candidates.refresh')}
        </Button>
      </SettingsToolbar>
      {published && (
        <SettingsState role="status" data-testid="candidate-published">
          <p>{t('candidates.publishSuccess')}</p>
          <a
            data-testid="candidate-published-link"
            href={
              candidateIdentity(published).type === 'skill'
                ? `/?${new URLSearchParams({ ...(merged ? { page: 'plugins', tab: 'skills' } : { settings: 'skills' }), skill: candidateSkillText(published).name ?? published.packageId })}`
                : merged
                  ? '/?page=plugins'
                  : '/admin/plugins'
            }
          >
            {t('candidates.viewPublished')}: {candidateSkillText(published).name ?? published.packageId}
          </a>
        </SettingsState>
      )}
      {error && (!selected || !reviewSurface) && (
        <p role="alert" data-testid="candidate-error">
          {error}
        </p>
      )}
      {!selected ? (
        <>
          {!merged && <p>{t('candidates.description')}</p>}
          {!loaded ? (
            error ? null : (
              <SettingsState tone="loading">{t('candidates.loading')}</SettingsState>
            )
          ) : !visibleItems.length ? (
            <EmptyState
              icon={<Icon name="file-text" size={48} />}
              title={t('candidates.empty')}
              description={t('candidates.description')}
            />
          ) : (
            <ul className="candidate-list" data-testid="candidate-list">
              {pendingItems.map(renderItem)}
            </ul>
          )}
          {!!history.length && (
            <SettingsDetails
              title={t('candidates.history', { count: history.length })}
              data-testid="candidate-history"
            >
              <ul className="candidate-list">{history.map(renderItem)}</ul>
            </SettingsDetails>
          )}
        </>
      ) : (
        renderReview(
          <section
            ref={review}
            className="candidate-review-panel"
            data-testid="candidate-review"
            aria-label={t('candidates.review')}
          >
            {reviewSurface && error && (
              <p role="alert" data-testid="candidate-error">
                {error}
              </p>
            )}
            {reviewSurface && (
              <PushCrumbs
                title={selected.packageId}
                crumbs={[t('candidates.title')]}
                backTestId="candidate-back"
                disabled={busy}
                onBack={() => setSelected(undefined)}
              />
            )}
            <header className="candidate-summary" data-testid="candidate-summary">
              <div className="candidate-summary-heading">
                <h4>{selected.packageId}</h4>
                <span data-testid="candidate-state">
                  <Badge tone={tone(selected.state)}>{t('candidates.state.' + selected.state)}</Badge>
                </span>
              </div>
              <p>
                {t(
                  selected.baseHash === null
                    ? candidateIdentity(selected).type === 'skill'
                      ? 'candidates.summaryNewSkill'
                      : 'candidates.summaryNew'
                    : candidateIdentity(selected).type === 'skill'
                      ? 'candidates.summaryUpdateSkill'
                      : 'candidates.summaryUpdate',
                  {
                    session: title,
                  },
                )}
              </p>
              <p title={title} data-testid="candidate-provenance">
                {t('candidates.byAgent', { session: title, turn: selected.origin.turn })}
              </p>
              <a
                data-testid="candidate-fact-chain"
                href={`/?session=${encodeURIComponent(selected.origin.sessionKey)}&factCandidate=${encodeURIComponent(selected.candidateId)}`}
              >
                {t('candidates.viewDrafting')}
              </a>
              <div className="candidate-summary-facts">
                <span data-testid="candidate-tests">
                  {selected.tests?.state === 'passed'
                    ? t(
                        selected.tests.count === 1 ? 'candidates.testsPassed' : 'candidates.testsPassedTotal',
                        {
                          count: selected.tests.count,
                        },
                      )
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
                    if (api)
                      void act(() => api.candidatesSubmit(selected.candidateId, selected.candidateHash))
                  }}
                >
                  {t('candidates.submit')}
                </Button>
              )}
              {selected.state === 'review' && (
                <>
                  <Button
                    appearance="primary"
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
                </>
              )}
            </SettingsToolbar>
          </section>,
        )
      )}
    </section>
  )
}
