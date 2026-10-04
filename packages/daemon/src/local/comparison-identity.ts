import { createHash } from 'node:crypto'

/** Stable before either lane creates a session; shared by allocation and durable admission. */
export function comparisonSessionKeys(principal: string, id: string): { left: string; right: string } {
  const physicalId = createHash('sha256').update(`${principal}\u0000${id}`).digest('hex')
  return { left: `agnes:comparison:${physicalId}:left`, right: `agnes:comparison:${physicalId}:right` }
}
