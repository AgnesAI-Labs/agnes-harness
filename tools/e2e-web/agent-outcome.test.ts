import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EventEnvelope, SessionJobsReadResult, UITimeline } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { ShellJobs } from '../../packages/base/extensions/jobs/src/registry.js'
import { runShellJob } from '../../packages/base/extensions/jobs/src/shell.js'
import { presets as basePresets, sandboxWorkspaceProbe } from '../../packages/base/src/index.js'
import { fakeToolContext } from '../../packages/base/testkit/tool-context.js'
import { presets as codePresets } from '../../packages/code/src/index.js'
import { testFsPolicy } from '../../packages/core/testkit/index.js'
import { resolvePreset } from '../../packages/host-common/src/presets/resolve.js'
import { normalizeSandboxStaticConfig } from '../../packages/host-common/src/workspace-policy.js'
import { createSandboxSeam } from '../../packages/host-infrastructure/src/sandbox-seam.js'
import { assertRunbookBackendRefusal } from './agent-outcome.js'

// Minimal durable facts from the Windows failure; no machine paths, credentials or captured prompts.
const evidence = () => ({
  timeline: {
    turns: [{ status: 'failed', reason: 'error', error: { code: 'WORKFLOW_STAGE_FAILED' } }],
    nodes: [
      { kind: 'tool', name: 'fde_ops_read', status: 'completed', toolUseId: 'read', seq: 19, resultSeq: 22 },
      {
        kind: 'tool',
        name: 'shell',
        status: 'failed',
        toolUseId: 'diagnostic',
        seq: 49,
        resultSeq: 55,
        argsPreview: JSON.stringify({
          command: 'node -e \'process.stdout.write("synthetic-service: degraded")\'',
          background: true,
          timeoutMs: 1000,
        }),
      },
      {
        kind: 'approval',
        purpose: 'tool.permission',
        toolUseId: 'diagnostic',
        state: 'decided',
        decision: { verdict: 'allowed-once', via: 'human' },
      },
    ],
  },
  events: [
    {
      seq: 52,
      type: 'decision/state',
      data: {
        request: { spec: { purpose: 'tool.permission', subject: { call: { toolUseId: 'diagnostic' } } } },
        result: {
          reason: 'answered',
          response: { option: 'allowed-once' },
          answeredBy: { attrs: { surface: 'approval' } },
        },
      },
    },
    {
      seq: 56,
      type: 'x/core/tool-response',
      data: {
        version: 1,
        toolUseId: 'diagnostic',
        result: { isError: true, details: { code: 'SHELL_JOB_BACKEND_UNAVAILABLE' } },
      },
    },
    { seq: 19, type: 'tool/call', data: { toolUseId: 'read', name: 'fde_ops_read', args: {} } },
    {
      seq: 49,
      type: 'tool/call',
      data: {
        toolUseId: 'diagnostic',
        name: 'shell',
        args: {
          command: 'node -e \'process.stdout.write("synthetic-service: degraded")\'',
          background: true,
          timeoutMs: 1000,
        },
      },
    },
    { seq: 22, type: 'tool/result', data: { toolUseId: 'read', isError: false } },
    { seq: 55, type: 'tool/result', data: { toolUseId: 'diagnostic', isError: true } },
    { seq: 23, type: 'x/core/tool-response', data: { version: 1, toolUseId: 'read', result: {} } },
  ],
  jobs: { jobs: [], completions: [] },
})
const check = (value: ReturnType<typeof evidence>) =>
  assertRunbookBackendRefusal(
    value.timeline as unknown as UITimeline,
    value.events as unknown as EventEnvelope[],
    value.jobs as SessionJobsReadResult,
  )

it('accepts only the authorized runbook backend refusal and rejects missing or contradictory evidence', () => {
  expect(() => check(evidence())).not.toThrow()
  for (const mutate of [
    (e: ReturnType<typeof evidence>) => {
      e.timeline.turns[0]!.status = 'completed'
    },
    (e: ReturnType<typeof evidence>) => {
      e.timeline.turns[0]!.error.code = 'OTHER_ERROR'
    },
    (e: ReturnType<typeof evidence>) => {
      e.events.splice(1, 1)
    },
    (e: ReturnType<typeof evidence>) => {
      e.events[1]!.data.result!.details!.code = 'SHELL_JOB_FAILED'
    },
    (e: ReturnType<typeof evidence>) => {
      e.events[0]!.data.result!.response!.option = 'rejected'
    },
    (e: ReturnType<typeof evidence>) => {
      e.events[0]!.data.request!.spec.subject.call.toolUseId = 'other-call'
    },
    (e: ReturnType<typeof evidence>) => {
      e.timeline.nodes[2]!.decision!.via = 'policy'
    },
    (e: ReturnType<typeof evidence>) => {
      e.timeline.nodes[1]!.name = 'fde_ops_restart'
    },
    (e: ReturnType<typeof evidence>) => {
      e.events[1]!.data.result!.details = { code: 'SHELL_JOB_BACKEND_UNAVAILABLE', jobId: 'started' } as {
        code: string
      }
    },
    (e: ReturnType<typeof evidence>) => {
      ;(e.jobs.jobs as unknown[]).push({ id: 'started' })
    },
    (e: ReturnType<typeof evidence>) => {
      ;(e.jobs.completions as unknown[]).push({ id: 'finished' })
    },
  ]) {
    const changed = evidence()
    mutate(changed)
    expect(() => check(changed)).toThrow()
  }
})

it('rejects a restart recorded in the ledger even when its timeline projection omits it', () => {
  const changed = evidence()
  changed.events.push({
    seq: 57,
    type: 'tool/call',
    data: { toolUseId: 'hidden-restart', name: 'fde_ops_restart', args: {} },
  })
  expect(() => check(changed)).toThrow()
})

it('rejects a receipt attached to a supposedly unavailable diagnostic backend', () => {
  const changed = evidence()
  Object.assign(changed.events[1]?.data.result ?? {}, { structured: { receipt: 'restart acknowledged' } })
  expect(() => check(changed)).toThrow()
})

it('the shipped runbook refuses Windows jobs before reaching the raw process port', async () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../examples/fde/ops-runbook/package.json', import.meta.url), 'utf8'),
  )
  const preset = resolvePreset('ops-runbook', {
    ...basePresets,
    ...codePresets,
    ...manifest.agnes.bundles['ops-runbook'].presets,
  })
  const config = normalizeSandboxStaticConfig(preset.doc)
  const policy = testFsPolicy(resolve('/work/proj'))
  const ctx = fakeToolContext({ cwd: policy.workspaceRoot })
  let rawStarts = 0
  const backend = await sandboxWorkspaceProbe({
    ...config,
    platform: 'win32',
    shell: 'powershell',
    options: { cwd: ctx.cwd, allowPaths: [ctx.cwd], denyPaths: [] },
    probeExec: async () => {
      throw new Error('Windows cannot probe a POSIX backend')
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const seam = await createSandboxSeam().forWorkspace({
    root: ctx.cwd,
    policy,
    readiness: { ready: async () => backend },
    shell: 'powershell',
    execBackend: backend.execBackend,
    enforcement: backend.enforcement,
    exec: async () => {
      rawStarts++
      throw new Error('raw exec must not run')
    },
    openProcess: async () => {
      rawStarts++
      throw new Error('raw process must not open')
    },
    binding: () => ({ policyDigest: policy.digest }),
  })
  const jobs = new ShellJobs()
  try {
    const result = await runShellJob(
      jobs,
      {
        command: 'node -e \'process.stdout.write("synthetic-service: degraded")\'',
        background: true,
        timeoutMs: 1000,
      },
      { ...ctx, platform: { ...ctx.platform, shell: 'powershell' }, sandbox: seam },
    )
    expect(result).toMatchObject({ isError: true, details: { code: 'SHELL_JOB_BACKEND_UNAVAILABLE' } })
    expect(result.details).not.toHaveProperty('jobId')
    expect(jobs.list(ctx)).toEqual([])
    expect(jobs.completions(ctx)).toEqual([])
    expect(rawStarts).toBe(0)
  } finally {
    await jobs.dispose()
  }
})
