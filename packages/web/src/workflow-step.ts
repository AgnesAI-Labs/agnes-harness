import type { ProcessStepResult } from '@agnes/web-ui/conversation'

/**
 * The official workflow Loop records each stage's result as `<stage>:` followed by the stage's
 * data as one JSON object (packages/plugin-runtime/src/workflow/driver.ts). That record belongs in
 * the turn's activity as a step, not in the answer. Anything else — a reply that merely starts
 * with a word and a colon, or JSON that is not an object — stays prose.
 */
const STAGE_RECORD = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):\n(\{[\s\S]*\})\s*$/

export function workflowStepRecord(text: string): ProcessStepResult | undefined {
  const match = STAGE_RECORD.exec(text)
  if (!match?.[1] || !match[2]) return undefined
  try {
    const data: unknown = JSON.parse(match[2])
    return data && typeof data === 'object' && !Array.isArray(data)
      ? { name: match[1], data: data as Record<string, unknown> }
      : undefined
  } catch {
    return undefined
  }
}
