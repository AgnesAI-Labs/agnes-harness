import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAghWorkflowCalls, workflowRunCompleted } from './workflow-reuse.js'

// The rows below are a trimmed part of the first evaluation's first-session ledger of a workflow task
// (paths made generic): three `workflow` calls, every one answered TOOL_OUTCOME_UNKNOWN because the tool
// failed after the run had finished (its closing surface was refused in an unattended session).
//   - call 1 and call 3: the run record ends `completed` with every member `completed`
//   - call 2: a resume that named a run the tool did not know; no run record exists for the call
const text = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real', 'wf-unknown-outcome.off-s1.jsonl'),
  'utf8',
)
const rows = (jsonl: string): Record<string, unknown>[] =>
  jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

const results = rows(text).filter((r) => r.type === 'tool/result')

describe('a workflow call that ended with an unknown outcome', () => {
  it('is the situation recorded: every call was answered TOOL_OUTCOME_UNKNOWN', () => {
    expect(results).toHaveLength(3)
    for (const r of results) expect((r.data as { code: string }).code).toBe('TOOL_OUTCOME_UNKNOWN')
  })

  it('counts as a finished run when the run record ends completed with every member completed', () => {
    const parsed = parseAghWorkflowCalls(text)
    // Two of the three calls ran; the resume of an unknown run did not.
    expect(parsed.completed).toHaveLength(2)
    expect(parsed.calls).toHaveLength(2)
    expect(workflowRunCompleted(rows(text))).toBe(true)
  })

  it('does not count a call that has no run record', () => {
    const only = rows(text).filter((r) => {
      const d = r.data as { toolUseId?: string }
      return d.toolUseId === 't21-26edf615b970f6663eb294da4f025bf8'
    })
    expect(only.map((r) => r.type).sort()).toEqual(['tool/call', 'tool/result'])
    expect(parseAghWorkflowCalls(only.map((r) => JSON.stringify(r)).join('\n'))).toEqual({
      calls: [],
      completed: [],
    })
    expect(workflowRunCompleted(only)).toBe(false)
  })

  it('does not count a run whose record ended interrupted, or left a member unfinished', () => {
    const edit = (change: (run: { status: string; stages: { members: { status: string }[] }[] }) => void) =>
      rows(text).map((r) => {
        if (r.type !== 'x/agnes/workflow/run') return r
        const copy = structuredClone(r) as { data: Parameters<typeof change>[0] }
        change(copy.data)
        return copy
      })
    const interrupted = edit((run) => {
      run.status = 'interrupted'
    })
    expect(workflowRunCompleted(interrupted)).toBe(false)
    const unfinished = edit((run) => {
      const last = run.stages.at(-1)?.members.at(-1)
      if (last) last.status = 'running'
    })
    expect(workflowRunCompleted(unfinished)).toBe(false)
  })
})
