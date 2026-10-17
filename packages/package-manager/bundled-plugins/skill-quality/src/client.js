import { workbenchPanels } from '@agnes/web-client'
import { Button, Field, Segmented, Select, StatusMessage } from '@agnes/web-ui'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { catalog } from './locales.js'

export function validSnapshot(result) {
  return (
    result?.schemaVersion === 1 &&
    Array.isArray(result.records) &&
    result.records.length <= 8 &&
    result.records.every(
      (row) =>
        typeof row?.candidate?.candidateId === 'string' &&
        Array.isArray(row.reasons) &&
        ['observed', 'stale', 'unknown'].includes(row.freshness) &&
        (row.evidence === null ||
          (Array.isArray(row.evidence?.cases) &&
            row.evidence?.environment &&
            row.counts &&
            row.evidence?.artifact)),
    )
  )
}

export const inject = ['session', 'locale', 'presentationRoles']
export function apply(ctx) {
  return ctx.presentationRoles.register({
    role: 'skill-quality',
    priority: 100,
    mount() {
      const off = [ctx.locale.register('skill-quality', catalog)]
      function Panel({ context }) {
        const t = context.t
        const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
        const [snapshot, setSnapshot] = useState(null)
        const [error, setError] = useState(false)
        const [loading, setLoading] = useState(false)
        const [revision, setRevision] = useState(0)
        const [selected, setSelected] = useState(undefined)
        const [filter, setFilter] = useState('all')
        useEffect(() => {
          let live = true
          setSnapshot(null)
          setError(false)
          setSelected(undefined)
          if (!sessionId)
            return () => {
              live = false
            }
          setLoading(true)
          ctx.profile.services
            .query('quality.read', { sessionId }, { sessionReads: [sessionId] })
            .then((result) => {
              if (!live) return
              if (!validSnapshot(result)) {
                setError(true)
                return
              }
              setSnapshot({ sessionId, revision, records: result.records })
              setSelected(result.records[0]?.candidate.candidateId)
            })
            .catch(() => {
              if (live) setError(true)
            })
            .finally(() => {
              if (live) setLoading(false)
            })
          return () => {
            live = false
          }
        }, [sessionId, revision])
        const records =
          snapshot?.sessionId === sessionId && snapshot?.revision === revision ? snapshot.records : []
        const row = records.find((item) => item.candidate.candidateId === selected)
        return h(
          'section',
          { className: 'agh-skill-quality', 'aria-label': t('quality.title') },
          h('p', null, t('quality.advisory')),
          !sessionId ? h(StatusMessage, { kind: 'notice' }, t('quality.noSession')) : null,
          loading ? h(StatusMessage, { kind: 'pending' }, t('quality.loading')) : null,
          error ? h(StatusMessage, { kind: 'error' }, t('quality.error')) : null,
          h(
            Button,
            { disabled: !sessionId || loading, onClick: () => setRevision((value) => value + 1) },
            t('quality.refresh'),
          ),
          !loading && !error && sessionId && !records.length ? h('p', null, t('quality.empty')) : null,
          records.length
            ? h(
                Field,
                { label: t('quality.candidate') },
                h(Select, {
                  'aria-label': t('quality.candidate'),
                  className: 'agh-skill-quality-select',
                  value: selected,
                  options: records.map((item) => ({
                    value: item.candidate.candidateId,
                    label: `${item.candidate.packageId} · ${item.candidate.candidateId}`,
                  })),
                  onChange: setSelected,
                }),
              )
            : null,
          row
            ? h(
                'div',
                null,
                h(
                  StatusMessage,
                  { kind: row.freshness === 'stale' ? 'error' : 'notice' },
                  t(`quality.${row.freshness}`),
                ),
                h(
                  'dl',
                  null,
                  ...[
                    ['candidate', row.candidate.candidateId],
                    ['hash', row.candidate.candidateHash],
                    ['base', row.candidate.baseHash ?? t('quality.absent')],
                    [
                      'installed',
                      row.installedObservation === undefined
                        ? t('quality.unknown')
                        : (row.installedObservation ?? t('quality.absent')),
                    ],
                    ['source', row.candidate.sourceSession],
                    ['state', t(`quality.state.${row.candidate.state}`)],
                    [
                      'hostTests',
                      row.candidate.hostTests
                        ? `${t(`quality.${row.candidate.hostTests.state}`)} · ${row.candidate.hostTests.count} · ${row.candidate.hostTests.runner} · ${row.candidate.hostTests.hash}`
                        : t('quality.unknown'),
                    ],
                    ['authority', t(`quality.authority.${row.authority}`)],
                    ['skillRevision', row.evidence?.skillRevision ?? t('quality.unknown')],
                    [
                      'artifact',
                      row.evidence
                        ? `${row.evidence.artifact.label} · ${row.evidence.artifact.sha256}`
                        : t('quality.unknown'),
                    ],
                  ].flatMap(([key, value]) => [
                    h('dt', { key: `${key}:label` }, t(`quality.${key}`)),
                    h('dd', { key }, value),
                  ]),
                ),
                row.reasons.length
                  ? h(
                      'ul',
                      null,
                      ...row.reasons.map((reason) => h('li', { key: reason }, t(`quality.reason.${reason}`))),
                    )
                  : null,
                row.evidence
                  ? h(
                      'div',
                      null,
                      h('h3', null, t('quality.environment')),
                      h(
                        'dl',
                        null,
                        ...Object.entries(row.evidence.environment).flatMap(([key, value]) => [
                          h('dt', { key: `${key}:label` }, t(`quality.env.${key}`)),
                          h('dd', { key }, value === null ? t('quality.unknown') : String(value)),
                        ]),
                      ),
                      h('h3', null, t('quality.cases')),
                      h(Segmented, {
                        label: t('quality.cases'),
                        value: filter,
                        onChange: setFilter,
                        options: ['all', 'passed', 'failed'].map((value) => ({
                          value,
                          label: t(`quality.${value}`),
                        })),
                      }),
                      h(
                        'p',
                        null,
                        `${t('quality.executed')}: ${row.counts.executed} · ${t('quality.passed')}: ${row.counts.passed} · ${t('quality.failed')}: ${row.counts.failed} · ${t('quality.skipped')}: ${row.counts.skipped}`,
                      ),
                      h(
                        'ul',
                        null,
                        ...row.evidence.cases
                          .filter((item) => filter === 'all' || item.status === filter)
                          .map((item) =>
                            h(
                              'li',
                              { key: item.id },
                              h(
                                'strong',
                                null,
                                `${item.id} · ${t(`quality.${item.status}`)} · ${item.executed}`,
                              ),
                              h('p', null, `${t('quality.expected')}: ${item.expected}`),
                              h('p', null, `${t('quality.actual')}: ${item.actual}`),
                            ),
                          ),
                      ),
                    )
                  : null,
                h('p', null, t('quality.publication')),
                h('p', null, t('quality.pins')),
              )
            : null,
        )
      }
      off.push(
        workbenchPanels.register({
          id: 'skill-quality',
          order: 85,
          edge: 'right',
          titleKey: 'quality.title',
          component: Panel,
        }),
      )
      return () => {
        for (const dispose of off.reverse()) dispose()
      }
    },
  })
}
