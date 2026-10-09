type Point = {
  attributes: unknown[]
  startTimeUnixNano: string
  timeUnixNano: string
  asDouble?: number
  count?: string
  sum?: number
  bucketCounts?: string[]
}
type Metric = { name: string; unit: string } & Partial<
  Record<
    'sum' | 'histogram' | 'gauge',
    { dataPoints: Point[]; aggregationTemporality?: number; isMonotonic?: boolean }
  >
>

/** One data point per metric/attribute identity in a batch; delta intervals do not overlap. */
export function aggregateMetrics(values: unknown[], previous: Map<string, string>): Metric[] {
  const metrics = new Map<string, Metric>()
  const points = new Map<string, Point>()
  for (const input of values) {
    const metric = input as Metric
    const kind = metric.sum ? 'sum' : metric.histogram ? 'histogram' : 'gauge'
    const data = metric[kind]!
    const identity = JSON.stringify([metric.name, metric.unit, kind])
    let output = metrics.get(identity)
    if (!output) {
      output = { name: metric.name, unit: metric.unit, [kind]: { ...data, dataPoints: [] } }
      metrics.set(identity, output)
    }
    for (const point of data.dataPoints) {
      const key = JSON.stringify([identity, point.attributes])
      const found = points.get(key)
      if (!found) {
        const first = {
          ...point,
          ...(kind !== 'gauge' && previous.has(key) ? { startTimeUnixNano: previous.get(key)! } : {}),
        }
        points.set(key, first)
        output[kind]!.dataPoints.push(first)
      } else {
        found.timeUnixNano = point.timeUnixNano
        if (kind === 'sum') found.asDouble = (found.asDouble ?? 0) + (point.asDouble ?? 0)
        else if (kind === 'histogram') {
          found.count = String(BigInt(found.count ?? '0') + BigInt(point.count ?? '0'))
          found.sum = (found.sum ?? 0) + (point.sum ?? 0)
          found.bucketCounts = [found.count]
        } else found.asDouble = point.asDouble ?? 0
      }
    }
  }
  for (const [key, point] of points) {
    previous.set(key, point.timeUnixNano)
    if (previous.size > 1024) previous.delete(previous.keys().next().value!)
  }
  return [...metrics.values()]
}
