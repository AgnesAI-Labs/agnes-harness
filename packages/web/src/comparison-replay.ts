import type { ComparisonLane, EventEnvelope } from '@agnes/protocol'
import type { ComparisonJournalState } from './comparison-journal.js'

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
) {
  const bar = document.createElement('div')
  bar.className = 'comparison-replay'
  bar.setAttribute('aria-label', '双侧共享账本回放')
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
  const play = makeButton('播放', () => {
    if (playing) pause()
    else {
      playing = true
      if (position === null || position >= max()) position = 0
      request()
    }
    draw()
  })
  const restart = makeButton('从头回放', () => {
    pause()
    position = 0
    playing = true
    request()
  })
  const previous = makeButton('上一项', () => {
    pause()
    position = Math.max(0, (position ?? max()) - 1)
    request()
  })
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.setAttribute('aria-label', '双侧共享回放位置')
  slider.addEventListener('input', () => {
    pause()
    position = Number(slider.value)
    request()
  })
  bar.append(slider)
  const next = makeButton('下一项', () => {
    pause()
    position = Math.min(max(), (position ?? max()) + 1)
    request()
  })
  makeButton('实时', () => {
    pause()
    position = null
    request()
  })
  const speed = document.createElement('select')
  speed.setAttribute('aria-label', '双侧回放速度')
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
    play.textContent = playing ? '暂停' : '播放'
    play.setAttribute('aria-pressed', String(playing))
    const incomplete = lanes.size < 2 || [...lanes.values()].some((lane) => !lane.complete)
    const prefix = pending
      ? '正在同步两侧，保留上一位置'
      : position === null
        ? '实时持久记录'
        : journal.mode === 'journal'
          ? `共享 journal #${appliedSeq ?? 0}`
          : `同步步进 ${position}`
    const ordering =
      journal.mode === 'journal'
        ? `后端持久发布顺序 · 共享 cursor #${appliedSeq ?? 0} / #${journal.throughSeq}`
        : journal.mode === 'per-lane-only'
          ? 'per-lane-only：按各侧记录顺序，非全局时序（无共享 journal）'
          : journal.mode === 'error'
            ? '共享 journal 不可用，保留上一位置'
            : '正在载入共享 journal'
    const checkpoint = journal.entries
      .slice(0, appliedSeq ?? 0)
      .findLast((entry) => entry.fact.kind === 'checkpoint')
    const coverage =
      checkpoint?.fact.kind === 'checkpoint'
        ? ` · ${checkpoint.fact.reason} checkpoint #${checkpoint.seq}：历史前缀交错未知${checkpoint.fact.coverage === 'per-lane-only' ? '，仅单侧顺序' : ''}`
        : ''
    status.textContent = `${prefix} · 左 #${applied.left} / 右 #${applied.right}${max() === 0 ? ' · 尚无账本数据' : ''}${incomplete ? ' · 历史读取中或尚未读全' : ''}；${ordering}${coverage}${journal.loading ? ' · 正在读取固定 journal 前缀' : ''}${journal.error ? ` · ${journal.error}` : ''}`
    const selected = appliedSeq === null ? undefined : journal.entries[appliedSeq - 1]
    fact.hidden = selected === undefined
    fact.replaceChildren()
    if (selected) {
      const summary = document.createElement('summary')
      summary.textContent = `共享事实 #${selected.seq} · ${selected.fact.kind}`
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
