import assert from 'node:assert/strict'
import type { EventEnvelope, SessionJobsReadResult, UITimeline } from '@agnes/protocol'

/** The Windows runbook's POSIX-only diagnostic must refuse after authorization, before execution. */
export function assertRunbookBackendRefusal(
  timeline: UITimeline,
  events: readonly EventEnvelope[],
  jobs: SessionJobsReadResult,
): void {
  assert.equal(timeline.turns.length, 1)
  assert.equal(timeline.turns[0]?.status, 'failed')
  assert.equal(timeline.turns[0]?.reason, 'error')
  assert.equal(timeline.turns[0]?.error?.code, 'WORKFLOW_STAGE_FAILED')
  const tools = timeline.nodes.filter((node) => node.kind === 'tool')
  assert.deepEqual(
    tools.map(({ name, status }) => ({ name, status })),
    [
      { name: 'fde_ops_read', status: 'completed' },
      { name: 'shell', status: 'failed' },
    ],
  )
  const shell = tools[1]
  assert.ok(shell)
  const diagnostic = {
    command: 'node -e \'process.stdout.write("synthetic-service: degraded")\'',
    background: true,
    timeoutMs: 1000,
  }
  assert.deepEqual(JSON.parse(shell.argsPreview ?? ''), diagnostic)
  const calls = events
    .filter((event) => event.type === 'tool/call')
    .map((event) => {
      const data = event.data as { toolUseId?: string; name?: string; args?: unknown }
      return { seq: event.seq, toolUseId: data.toolUseId, name: data.name, args: data.args }
    })
  assert.deepEqual(
    calls,
    tools.map((tool) => ({
      seq: tool.seq,
      toolUseId: tool.toolUseId,
      name: tool.name,
      args: tool.name === 'shell' ? diagnostic : {},
    })),
  )
  const results = events
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const data = event.data as { toolUseId?: string; isError?: boolean }
      return { seq: event.seq, toolUseId: data.toolUseId, failed: data.isError === true }
    })
  assert.deepEqual(
    results,
    tools.map((tool) => ({
      seq: tool.resultSeq,
      toolUseId: tool.toolUseId,
      failed: tool.name === 'shell',
    })),
  )
  const approvals = timeline.nodes
    .filter((node) => node.kind === 'approval')
    .filter((node) => node.toolUseId === shell.toolUseId)
  assert.equal(approvals.length, 1)
  assert.deepEqual(
    approvals[0] && {
      purpose: approvals[0].purpose,
      state: approvals[0].state,
      decision: {
        verdict: approvals[0].decision?.verdict,
        via: approvals[0].decision?.via,
      },
    },
    {
      purpose: 'tool.permission',
      state: 'decided',
      decision: { verdict: 'allowed-once', via: 'human' },
    },
  )
  const responses = events
    .filter((event) => event.type === 'x/core/tool-response')
    .map((event) => ({
      seq: event.seq,
      data: event.data as {
        version?: number
        toolUseId?: string
        result?: {
          isError?: boolean
          details?: Record<string, unknown>
          structured?: Record<string, unknown>
        }
      },
    }))
    .sort((left, right) => left.seq - right.seq)
  assert.deepEqual(
    responses.map(({ data }) => data.toolUseId),
    tools.map((tool) => tool.toolUseId),
  )
  assert.equal(responses[0]?.data.version, 1)
  assert.notEqual(responses[0]?.data.result?.isError, true)
  const response = responses[1]
  assert.ok(response)
  assert.equal(response.data.version, 1)
  assert.equal(response.data.result?.isError, true)
  assert.deepEqual(response.data.result?.details, { code: 'SHELL_JOB_BACKEND_UNAVAILABLE' })
  assert.equal(response.data.result?.structured, undefined)
  const authorized = events.some((event) => {
    if (event.type !== 'decision/state' || event.seq <= shell.seq || event.seq >= (shell.resultSeq ?? 0))
      return false
    const data = event.data as {
      request?: { spec?: { purpose?: string; subject?: { call?: { toolUseId?: string } } } }
      result?: {
        reason?: string
        response?: { option?: string }
        answeredBy?: { attrs?: { surface?: string } }
      }
    }
    return (
      data.request?.spec?.purpose === 'tool.permission' &&
      data.request.spec.subject?.call?.toolUseId === shell.toolUseId &&
      data.result?.reason === 'answered' &&
      data.result.response?.option === 'allowed-once' &&
      data.result.answeredBy?.attrs?.surface === 'approval'
    )
  })
  assert.equal(authorized, true, 'The same diagnostic needs a durable human allow-once before refusal')
  assert.deepEqual(jobs.jobs, [])
  assert.deepEqual(jobs.completions, [])
}
