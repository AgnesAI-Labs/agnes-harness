/** The timeline density model only depends on positions, so callers retain their own bar metadata. */
export type TraceTimelineDensityBar = {
  key: string
  lane: string
  domainStart: number
  domainEnd: number
  targetId?: string
}

export type TraceTimelineDensityUnit<T extends TraceTimelineDensityBar> = {
  kind: 'bar' | 'cluster'
  key: string
  lane: T['lane']
  domainStart: number
  domainEnd: number
  count: number
  members: readonly T[]
}

export type TraceTimelineDensityOptions = {
  /** Maximum number of rendered units across all lanes. Defaults to 600. */
  maxUnits?: number
  /** Keep this bar individually addressable even when its lane is clustered. */
  selectedKey?: string
}

type IndexedBar<T extends TraceTimelineDensityBar> = { bar: T; index: number }
type Lane<T extends TraceTimelineDensityBar> = {
  name: T['lane']
  bars: IndexedBar<T>[]
  quota: number
}

function unit<T extends TraceTimelineDensityBar>(
  members: readonly T[],
  lane: T['lane'],
  key: string,
): TraceTimelineDensityUnit<T> {
  let domainStart = Number.POSITIVE_INFINITY
  let domainEnd = Number.NEGATIVE_INFINITY
  for (const bar of members) {
    domainStart = Math.min(domainStart, bar.domainStart)
    domainEnd = Math.max(domainEnd, bar.domainEnd)
  }
  return {
    kind: members.length === 1 ? 'bar' : 'cluster',
    key,
    lane,
    domainStart,
    domainEnd,
    count: members.length,
    members,
  }
}

function single<T extends TraceTimelineDensityBar>(bar: T): TraceTimelineDensityUnit<T> {
  return unit([bar], bar.lane, `bar:${encodeURIComponent(bar.key)}`)
}

/**
 * Group a dense timeline by lane and horizontal position. Each bar appears in exactly one unit.
 * A unit is directly renderable, and its members retain the original metadata for inspection.
 * There must be room for at least one unit per lane, plus a separately selected bar.
 */
export function buildTraceTimelineDensity<T extends TraceTimelineDensityBar>(
  bars: readonly T[],
  options: TraceTimelineDensityOptions = {},
): TraceTimelineDensityUnit<T>[] {
  const maxUnits = options.maxUnits ?? 600
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 1)
    throw new RangeError('maxUnits must be a positive integer')
  const keys = new Set<string>()
  let domainStart = Number.POSITIVE_INFINITY
  let domainEnd = Number.NEGATIVE_INFINITY
  for (const bar of bars) {
    if (keys.has(bar.key)) throw new Error(`duplicate timeline bar key: ${bar.key}`)
    keys.add(bar.key)
    if (
      !Number.isFinite(bar.domainStart) ||
      !Number.isFinite(bar.domainEnd) ||
      bar.domainEnd < bar.domainStart
    )
      throw new RangeError(`invalid timeline domain for ${bar.key}`)
    domainStart = Math.min(domainStart, bar.domainStart)
    domainEnd = Math.max(domainEnd, bar.domainEnd)
  }
  if (bars.length <= maxUnits) return bars.map(single)

  const selectedIndex =
    options.selectedKey === undefined ? -1 : bars.findIndex((bar) => bar.key === options.selectedKey)
  const selected = selectedIndex < 0 ? undefined : bars[selectedIndex]
  const byLane = new Map<T['lane'], Lane<T>>()
  for (const [index, bar] of bars.entries()) {
    if (index === selectedIndex) continue
    let lane = byLane.get(bar.lane)
    if (!lane) {
      lane = { name: bar.lane, bars: [], quota: 1 }
      byLane.set(bar.lane, lane)
    }
    lane.bars.push({ bar, index })
  }
  const lanes = [...byLane.values()]
  const available = maxUnits - (selected ? 1 : 0)
  if (lanes.length > available)
    throw new RangeError('maxUnits must allow each lane and the selected bar to remain visible')

  // Assign spare buckets where another bucket reduces the highest current density.
  for (let spare = available - lanes.length; spare > 0; spare--) {
    let fullest: Lane<T> | undefined
    for (const lane of lanes) {
      if (lane.quota >= lane.bars.length) continue
      if (!fullest || lane.bars.length / lane.quota > fullest.bars.length / fullest.quota) fullest = lane
    }
    if (!fullest) break
    fullest.quota++
  }

  const positioned: Array<{ firstIndex: number; unit: TraceTimelineDensityUnit<T> }> = []
  if (selected) positioned.push({ firstIndex: selectedIndex, unit: single(selected) })
  for (const lane of lanes) {
    const buckets = new Map<number, IndexedBar<T>[]>()
    for (const entry of lane.bars) {
      const midpoint = entry.bar.domainStart + (entry.bar.domainEnd - entry.bar.domainStart) / 2
      const fraction = domainEnd === domainStart ? 0 : (midpoint - domainStart) / (domainEnd - domainStart)
      const bucket = Math.min(lane.quota - 1, Math.max(0, Math.floor(fraction * lane.quota)))
      const members = buckets.get(bucket) ?? []
      members.push(entry)
      buckets.set(bucket, members)
    }
    for (const [bucket, entries] of buckets) {
      const first = entries[0]
      if (!first) continue
      const members = entries.map(({ bar }) => bar)
      const key =
        members.length === 1
          ? `bar:${encodeURIComponent(first.bar.key)}`
          : `cluster:${encodeURIComponent(lane.name)}:${bucket}`
      positioned.push({
        firstIndex: first.index,
        unit: unit(members, lane.name, key),
      })
    }
  }
  return positioned.sort((a, b) => a.firstIndex - b.firstIndex).map(({ unit: item }) => item)
}

/** Pick the closest original bar to the clicked domain coordinate, including point markers. */
export function pickTraceTimelineDensityMember<T extends TraceTimelineDensityBar>(
  item: TraceTimelineDensityUnit<T>,
  domainPosition: number,
): T {
  if (!Number.isFinite(domainPosition)) throw new RangeError('domainPosition must be finite')
  const first = item.members[0]
  if (!first) throw new RangeError('timeline density unit has no members')
  let nearest = first
  let nearestIntervalDistance = Number.POSITIVE_INFINITY
  let nearestCenterDistance = Number.POSITIVE_INFINITY
  for (const bar of item.members) {
    const intervalDistance =
      domainPosition < bar.domainStart
        ? bar.domainStart - domainPosition
        : domainPosition > bar.domainEnd
          ? domainPosition - bar.domainEnd
          : 0
    const midpoint = bar.domainStart + (bar.domainEnd - bar.domainStart) / 2
    const centerDistance = Math.abs(domainPosition - midpoint)
    if (
      intervalDistance < nearestIntervalDistance ||
      (intervalDistance === nearestIntervalDistance && centerDistance < nearestCenterDistance)
    ) {
      nearest = bar
      nearestIntervalDistance = intervalDistance
      nearestCenterDistance = centerDistance
    }
  }
  return nearest
}
