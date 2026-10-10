import type { ComparisonLane, EventEnvelope } from '@agnes/protocol'
import type { ComparisonJournalState } from './comparison-journal.js'
import type { Translate } from './jev-locale.js'

type Side = ComparisonLane['side']
export type ComparisonCuts = Record<Side, number>
export type ComparisonReplayLane = { events: readonly EventEnvelope[]; complete: boolean; loading: boolean }

/** Explicit legacy fallback: local ledger ranks never claim a global publication order. */
export function comparisonReplayCuts(
  position: number | null,
  lanes: ReadonlyMap<Side, ComparisonReplayLane>,
): ComparisonCuts {
  if (position !== null && (!Number.isSafeInteger(position) || position < 0))
    throw new RangeError('Invalid comparison replay position')
  const cut = (side: Side) => {
    const events = lanes.get(side)?.events ?? []
    return events[(position === null ? events.length : Math.min(position, events.length)) - 1]?.seq ?? 0
  }
  return { left: cut('left'), right: cut('right') }
}

/** One timer and one inclusive cut pair govern every lane view. */
export function createComparisonReplay(
  host: HTMLElement,
  apply: (
    cuts: ComparisonCuts,
    live: boolean,
    current: () => boolean,
    atSeq: number | null,
  ) => Promise<boolean>,
  fail: (error: unknown) => void,
  t: Translate,
) {
  const bar = document.createElement('div')
  bar.className = 'comparison-replay'
  bar.setAttribute('aria-label', t('replay.aria.label'))
  const makeButton = (text: string, action: () => void) => {
    const value = document.createElement('button')
    value.type = 'button'
    value.textContent = text
    value.addEventListener('click', action)
    bar.append(value)
    return value
  }
  const fact = document.createElement('details')
  fact.className = 'comparison-journal-fact'
  const lanes = new Map<Side, ComparisonReplayLane>()
  let journal: ComparisonJournalState = { mode: 'loading', entries: [], throughSeq: 0, loading: true }
  let position: number | null = null
  let playing = false
  let pending = false
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let applied: ComparisonCuts = { left: 0, right: 0 }
  let appliedSeq: number | null = null
  const max = () =>
    journal.mode === 'journal'
      ? journal.throughSeq
      : journal.mode === 'per-lane-only'
        ? Math.max(0, ...[...lanes.values()].map((lane) => lane.events.length))
        : 0
  const pause = () => {
    playing = false
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const play = makeButton(t('replay.play'), () => {
    if (playing) pause()
    else {
      playing = true
      if (position === null || position >= max()) position = 0
      request()
    }
    draw()
  })
  const restart = makeButton(t('replay.restart'), () => {
    pause()
    position = 0
    playing = true
    request()
  })
  const previous = makeButton(t('replay.previous'), () => {
    pause()
    position = Math.max(0, (position ?? max()) - 1)
    request()
  })
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.setAttribute('aria-label', t('replay.aria.position'))
  slider.addEventListener('input', () => {
    pause()
    position = Number(slider.value)
    request()
  })
  bar.append(slider)
  const next = makeButton(t('replay.next'), () => {
    pause()
    position = Math.min(max(), (position ?? max()) + 1)
    request()
  })
  makeButton(t('replay.live'), () => {
    pause()
    position = null
    request()
  })
  const speed = document.createElement('select')
  speed.setAttribute('aria-label', t('replay.aria.speed'))
  for (const value of [1, 2, 4, 8]) {
    const option = document.createElement('option')
    option.value = String(value)
    option.textContent = `${value}×`
    speed.append(option)
  }
  speed.addEventListener('change', () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    schedule()
  })
  const status = document.createElement('span')
  status.className = 'comparison-replay-status'
  status.setAttribute('role', 'status')
  bar.append(speed, status)
  host.append(bar, fact)
  function draw() {
    slider.max = String(max())
    slider.value = String(position ?? max())
    slider.disabled = max() === 0
    play.disabled = restart.disabled = max() === 0
    previous.disabled = (position ?? max()) <= 0
    next.disabled = (position ?? max()) >= max()
    play.textContent = playing ? t('replay.pause') : t('replay.play')
    play.setAttribute('aria-pressed', String(playing))
    const incomplete = lanes.size < 2 || [...lanes.values()].some((lane) => !lane.complete)
    const prefix = pending
      ? t('replay.syncing')
      : position === null
        ? t('replay.livePrefix')
        : journal.mode === 'journal'
          ? t('replay.journalPrefix', { seq: appliedSeq ?? 0 })
          : t('replay.stepPrefix', { position })
    const ordering =
      journal.mode === 'journal'
        ? t('replay.ordering.journal', { seq: appliedSeq ?? 0, through: journal.throughSeq })
        : journal.mode === 'per-lane-only'
          ? t('replay.ordering.perLane')
          : journal.mode === 'error'
            ? t('replay.ordering.error')
            : t('replay.ordering.loading')
    const checkpoint = journal.entries
      .slice(0, appliedSeq ?? 0)
      .findLast((entry) => entry.fact.kind === 'checkpoint')
    const coverage =
      checkpoint?.fact.kind === 'checkpoint'
        ? t('replay.checkpoint', {
            reason: checkpoint.fact.reason,
            seq: checkpoint.seq,
            perLane: checkpoint.fact.coverage === 'per-lane-only' ? t('replay.checkpoint.perLane') : '',
          })
        : ''
    status.textContent = t('replay.status', {
      prefix,
      sides: t('replay.sides', { left: applied.left, right: applied.right }),
      noData: max() === 0 ? t('replay.noData') : '',
      incomplete: incomplete ? t('replay.incomplete') : '',
      ordering,
      coverage,
      loading: journal.loading ? t('replay.loadingPrefix') : '',
      error: journal.error ? ` · ${journal.error}` : '',
    })
    const selected = appliedSeq === null ? undefined : journal.entries[appliedSeq - 1]
    fact.hidden = selected === undefined
    fact.replaceChildren()
    if (selected) {
      const summary = document.createElement('summary')
      summary.textContent = t('replay.fact', { seq: selected.seq, kind: selected.fact.kind })
      const raw = document.createElement('pre')
      raw.textContent = JSON.stringify(selected.fact, null, 2)
      fact.append(summary, raw)
    }
  }
  function schedule() {
    if (!playing || pending || timer !== undefined) return
    if ((position ?? max()) >= max()) {
      pause()
      draw()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      position = Math.min(max(), (position ?? 0) + 1)
      request()
    }, 350 / Number(speed.value))
  }
  function request() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (journal.mode !== 'journal' && journal.mode !== 'per-lane-only') {
      draw()
      return
    }
    const ticket = ++revision
    const atSeq = journal.mode === 'journal' ? (position ?? max()) : null
    const cuts =
      atSeq === null
        ? comparisonReplayCuts(position, lanes)
        : atSeq === 0
          ? { left: 0, right: 0 }
          : journal.entries[atSeq - 1]?.cuts
    if (!cuts) throw new RangeError('共享 journal 游标尚未读取')
    const live = position === null
    pending = true
    draw()
    const current = () => ticket === revision
    void apply(cuts, live, current, atSeq).then(
      (committed) => {
        if (!current() || !committed) return
        applied = cuts
        appliedSeq = atSeq
        pending = false
        draw()
        schedule()
      },
      (error: unknown) => {
        if (!current()) return
        pause()
        pending = false
        fail(error)
        draw()
      },
    )
  }
  draw()
  return {
    updateJournal(value: ComparisonJournalState) {
      if (journal.mode !== value.mode && value.mode !== 'loading') {
        pause()
        position = null
      }
      journal = value
      if (!value.loading) request()
      else draw()
    },
    update(side: Side, lane: ComparisonReplayLane) {
      lanes.set(side, lane)
      request()
    },
    live: () => position === null,
    reset() {
      revision++
      pause()
      lanes.clear()
      position = null
      pending = false
      applied = { left: 0, right: 0 }
      appliedSeq = null
      journal = { mode: 'loading', entries: [], throughSeq: 0, loading: true }
      draw()
    },
  }
}
