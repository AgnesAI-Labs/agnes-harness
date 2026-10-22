import { Badge, Button } from '@agnes/web-ui'
import React from 'react'
import { h, jumpTo, time } from './board.js'

const SEEN_KEY = 'devboard.activitySeen'
const SHOWN = 12

/** Where a feed line opens: kind → [home entry, detail page or undefined to open the page only]. */
const OPENS = {
  approval: ['devboard-reviews', 'approval'],
  gate: ['devboard-reviews', 'gate'],
  intervention: ['devboard-reviews', 'intervention'],
  change: ['devboard-changes', 'detail'],
  defect: ['devboard-quality', 'detail'],
  testRun: ['devboard-quality'],
  trial: ['trials', 'detail'],
  problem: ['service', 'problem'],
  task: ['devboard-tasks', 'detail'],
  requirement: ['devboard-tasks'],
  project: ['devboard-projects'],
  stage: ['devboard-projects'],
  artifact: ['devboard-projects'],
}

/** The last revision this browser showed; null on the first visit. Storage may be blocked. */
export function readSeen() {
  try {
    const value = Number(window.localStorage.getItem(SEEN_KEY))
    return window.localStorage.getItem(SEEN_KEY) === null || !Number.isInteger(value) ? null : value
  } catch {
    return null
  }
}
function writeSeen(rev) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(rev))
  } catch {}
}

/** Lines newer than the last revision seen; the first visit has none. */
export const freshCount = (activity, seen) =>
  seen === null ? 0 : activity.filter((a) => a.rev > seen).length

/** What the agent wrote on the board, newest first; lines since the last visit are highlighted. */
export function ActivityPanel({ data }) {
  const feed = data.activity ?? []
  const latest = feed[0]?.rev ?? 0
  const [seen, setSeen] = React.useState(readSeen)
  const [all, setAll] = React.useState(false)
  const latestRef = React.useRef(latest)
  latestRef.current = latest
  // The first visit has nothing to compare with; leaving the page counts everything shown as seen.
  React.useEffect(() => {
    if (readSeen() === null) writeSeen(latestRef.current)
    return () => writeSeen(latestRef.current)
  }, [])
  const fresh = freshCount(feed, seen)
  const markRead = () => {
    setSeen(latest)
    writeSeen(latest)
  }
  const rows = all ? feed : feed.slice(0, SHOWN)
  return h(
    'section',
    { className: 'devboard-card', 'aria-label': '智能体动态', 'data-guide': 'overview-activity' },
    h(
      'h2',
      null,
      '智能体动态',
      fresh > 0 && h(Badge, { tone: 'warn' }, `新 ${fresh} 条`),
      fresh > 0 && h(Button, { size: 'small', onClick: markRead }, '全部标为已读'),
    ),
    rows.length
      ? h(
          'ul',
          { className: 'devboard-todo-list' },
          rows.map((a) => {
            const [entry, page] = OPENS[a.entity.kind] ?? []
            const isNew = seen !== null && a.rev > seen
            return h(
              'li',
              {
                key: a.id,
                className: isNew ? 'devboard-todo-item devboard-activity-new' : 'devboard-todo-item',
                'data-new': isNew ? 'true' : undefined,
              },
              h(
                'span',
                null,
                isNew && h(Badge, { tone: 'warn' }, '新'),
                isNew && ' ',
                entry
                  ? h(
                      Button,
                      { appearance: 'link', onClick: () => jumpTo(entry, a.entity.id, page) },
                      a.summary,
                    )
                  : a.summary,
              ),
              h('span', { className: 'devboard-muted' }, `${a.actor} · ${time(a.at)}`),
            )
          }),
        )
      : h('p', { className: 'devboard-muted' }, '暂无动态'),
    feed.length > SHOWN &&
      h(Button, { size: 'small', onClick: () => setAll(!all) }, all ? '收起' : `显示全部 ${feed.length} 条`),
  )
}
