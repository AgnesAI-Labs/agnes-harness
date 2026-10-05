import { createHash } from 'node:crypto'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import type { ModelWireSource } from './ports.js'

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const tally = (values: readonly string[]) => {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}
const equalCounts = (a: Map<string, number>, b: Map<string, number>) =>
  a.size === b.size && [...a].every(([key, count]) => b.get(key) === count)

function carried(source: ModelWireSource) {
  const images: string[] = []
  const texts = new Set<string>()
  for (const message of source.request.messages) {
    if (message.role !== 'user' && message.role !== 'tool_result') continue
    for (const block of message.content) {
      if (block.type === 'image') images.push(sha256(Buffer.from(block.data, 'base64')))
      else if (block.type === 'text') texts.add(sha256(block.text))
    }
  }
  return { images, texts }
}

/**
 * The request carries exactly the media the Host verified for the locked plans: same count, same plans,
 * the target features the plans were made for, no shared usage, and no image that was not planned.
 */
export function mediaConsumed(source: ModelWireSource): boolean {
  const plans = source.prepared.mediaPlans
  const media = source.media ?? []
  const request = carried(source)
  if (plans.length !== media.length) return false
  if (plans.length === 0) return request.images.length === 0
  if (new Set(media.map((entry) => entry.planKey)).size !== media.length) return false
  const usage = media.flatMap((entry) => entry.usageIds)
  if (new Set(usage).size !== usage.length) return false
  const wanted: string[] = []
  for (const [index, plan] of plans.entries()) {
    const entry = media[index]
    if (!entry || entry.planKey !== plan.key || entry.planDigest !== canonicalJsonDigest(plan as never))
      return false
    if (
      canonicalJsonDigest(plan.targetFeatures as never) !==
      canonicalJsonDigest(source.prepared.target.features as never)
    )
      return false
    for (const part of entry.parts) {
      if (part.kind === 'image') wanted.push(part.sha256)
      else if (!request.texts.has(part.sha256)) return false
    }
  }
  return wanted.length === request.images.length && equalCounts(tally(wanted), tally(request.images))
}
