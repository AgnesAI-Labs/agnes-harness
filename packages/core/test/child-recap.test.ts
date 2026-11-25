import { trackExternalChild } from '@agnes/core-child-control/child/directory'
import type { EventInput } from '@agnes/core-common/types'
import type { ChildExecutionState } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { childCompletionInput, deliverChildStateNotice } from '../src/child/completion-notice.js'
import { renderTruthBase } from '../src/child/recap-formatter.js'
import { generateHybridRecap } from '../src/child/recap-narrative.js'
import { buildRecapFactSnapshot } from '../src/child/recap-snapshot.js'
import { guardParentRecapReply, validateRecapOutput } from '../src/child/recap-validator.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

async function batch(provider = fakeProvider([])) {
  const { session: parent, storage } = await openSession({ provider })
  await storage.ensureRootScope(parent.key, 100_000_000n)
  let serial = 0
  async function append(key: string, type: string, data: unknown, extra?: Partial<EventInput>) {
    const event = parent.ev(type, data, extra)
    const result = await storage.commit(key, {
      expectedWriterRunId: parent.writerRunId,
      events: [{ ...event, ts: new Date(parent.d.clock()).toISOString(), id: `row-${++serial}` }],
    })
    return result.firstSeq
  }
  async function task(childKey: string, state: ChildExecutionState, boundarySeq = 0) {
    const result = await storage.createDelegatedChild({
      parentKey: parent.key,
      childKey,
      boundarySeq,
      rootTaskId: parent.key,
      runtimeOwnerSessionKey: parent.key,
      creationId: `${parent.key}:main:${childKey}`,
      kind: boundarySeq ? 'fork' : 'spawn',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 20,
      inputHash: childKey,
      inputText: `Work on ${childKey}`,
      cwd: '/w',
      actorId: 'u',
      isolation: 'shared',
      workspaceId: childKey,
      treeCapMicro: 100_000_000n,
      childCapMicro: null,
      writerRunId: parent.writerRunId,
    })
    if (result.status !== 'created') throw new Error(result.status)
    await storage.open(childKey, { writerRunId: parent.writerRunId, ttlMs: 60_000 })
    expect(await storage.casState(childKey, result.record.stateRevision, state)).toBe(true)
    return result.record
  }
  const message = (key: string, text: string) =>
    append(key, 'assistant/message', { content: [{ type: 'text', text }] }, { origin: 'model' })
  async function write(key: string, path: string, isError = false, name = 'write') {
    const toolUseId = `call-${serial}`
    const seq = await append(key, 'tool/call', { name, toolUseId, args: { path } }, { origin: 'model' })
    await append(
      key,
      'tool/result',
      { isError, toolUseId, content: [] },
      { origin: `tool:${name}`, sourceEventSeqs: [seq] },
    )
    return seq
  }
  const role = (key: string, ref: string) =>
    append(key, 'x/core/role-delegation', { role: { ref, title: { en: ref } } })
  const request = (key: string) => append(key, 'request/sent', { model: { route: 'route-A', id: 'model-B' } })
  const decision = (key: string, id: string, answered = false) =>
    append(
      key,
      'decision/state',
      {
        handle: { id },
        request: {
          spec: {
            subject: { call: { name: 'write' } },
            purpose: 'tool.permission',
            prompt: 'Review this file write',
          },
        },
        result: answered ? { reason: 'answered' } : null,
        consumption: null,
        invalidation: null,
      },
      { register: 'decision/state' },
    )
  return {
    parent,
    storage,
    task,
    message,
    write,
    append,
    role,
    request,
    decision,
    snapshot: () => buildRecapFactSnapshot(parent),
  }
}

describe('child recap', () => {
  it('attributes completed writes and edits to their owners, including basename collisions', async () => {
    const b = await batch()
    for (const [key, role, path] of [
      ['work-A', 'writer', 'a/summary.md'],
      ['work-B', 'editor', 'b/summary.md'],
    ] as const) {
      await b.task(key, 'completed')
      await b.role(key, role)
      await b.request(key)
      await b.write(key, path, false, role === 'editor' ? 'edit' : 'write')
      await b.message(key, 'Recorded changes')
    }
    const snapshot = await b.snapshot()
    expect(snapshot.hasIncompleteWork).toBe(false)
    expect(snapshot.counts).toEqual({
      total: 2,
      completed: 2,
      failed: 0,
      cancelled: 0,
      running: 0,
      waitingApproval: 0,
      paused: 0,
      disconnected: 0,
    })
    expect(snapshot.allowedArtifactPaths).toEqual(['a/summary.md', 'b/summary.md'])
    expect(snapshot.subtasks[0]).toMatchObject({
      taskId: 'work-A',
      label: 'Work on work-A',
      role: 'writer',
      status: 'completed',
      executionState: 'completed',
      requestCount: 1,
      summaryText: 'Recorded changes',
      updatedAt: b.parent.d.clock(),
      artifacts: [{ path: 'a/summary.md', verified: true, kind: 'file' }],
    })
    const truth = renderTruthBase(snapshot)
    expect(truth).toContain('[work-A] (writer) -> a/summary.md')
    expect(truth).toContain('[work-B] (editor) -> b/summary.md')
    const validate = (text: string) => validateRecapOutput(text, snapshot)
    expect(validate('See summary.md').violations).toContainEqual({
      code: 'AMBIGUOUS_SAME_NAME_ARTIFACT',
      detail: 'summary.md',
    })
    expect(validate('work-A wrote b/summary.md').valid).toBe(false)
    expect(validate('work-A wrote a/summary.md and work-B edited b/summary.md').valid).toBe(true)
    expect(validate('work-A linked [report](summary.md)').valid).toBe(false)
  })

  it('requires successful workspace writes and applies optional file verification', async () => {
    const b = await batch()
    await b.task('writer', 'completed')
    for (const path of ['present.md', 'missing.md', 'folder.md', '../outside.md'])
      await b.write('writer', path)
    await b.write('writer', 'denied.md', true)
    await b.write('writer', 'viewed.md', false, 'read')
    const patch = await b.append(
      'writer',
      'tool/call',
      { name: 'apply_patch', toolUseId: 'patch', args: {} },
      { origin: 'model' },
    )
    await b.append(
      'writer',
      'tool/result',
      {
        toolUseId: 'patch',
        content: [{ type: 'text', text: 'Success. Updated the following files:\nA new.txt\nD folder.md' }],
      },
      { origin: 'tool:apply_patch', sourceEventSeqs: [patch] },
    )
    const snapshot = await buildRecapFactSnapshot(b.parent, {
      stat: async (abs) => {
        if (abs === '/w/missing.md') throw new Error('ENOENT')
        return { kind: abs === '/w/present.md' || abs === '/w/new.txt' ? 'file' : 'directory' }
      },
    })
    expect(snapshot.allowedArtifactPaths).toEqual(['new.txt', 'present.md'])
    expect(snapshot.subtasks[0]?.artifacts).toEqual([
      { path: 'present.md', kind: 'file', verified: true },
      { path: 'new.txt', kind: 'patch', verified: true },
    ])
    expect(renderTruthBase(snapshot)).not.toContain('missing.md')
  })

  it('starts every fact after the fork boundary, including the source of a tool result', async () => {
    const b = await batch()
    const parentKey = b.parent.key
    await b.role(parentKey, 'ancestor-role')
    await b.request(parentKey)
    await b.message(parentKey, 'ancestor output')
    const call = await b.write(parentKey, 'ancestor.md')
    const boundary = call + 1
    await b.task('fork', 'running', boundary)
    await b.append(
      'fork',
      'tool/result',
      { toolUseId: 'unrelated', isError: false },
      { origin: 'tool:write', sourceEventSeqs: [call] },
    )
    await b.write('fork', 'child.md')
    const snapshot = await b.snapshot()
    expect(snapshot.allowedArtifactPaths).toEqual(['child.md'])
    expect(snapshot.subtasks[0]).toMatchObject({
      executionState: 'running',
      summaryText: '',
      requestCount: 0,
    })
    expect(snapshot.subtasks[0]?.role).toBeUndefined()
  })

  it('rejects unwritten destinations even when the failed child named them', async () => {
    const b = await batch()
    await b.task('draft', 'failed')
    await b.request('draft')
    await b.write('draft', 'never.md', true)
    await b.message('draft', 'Planned report.md')
    await b.append('draft', 'turn/end', { reason: 'error', error: { code: 'E_ADAPTER', message: 'offline' } })
    const snapshot = await b.snapshot()
    expect(snapshot.subtasks[0]).toMatchObject({
      artifacts: [],
      blockerReason: '[route-A/model-B] Failed: E_ADAPTER (offline)',
    })
    for (const text of [
      'See report.md',
      'See [report](out/no-extension)',
      'Created `RUNBOOK`',
      '[download]: INVENTED',
      'See `out/file with spaces.md`',
    ]) {
      expect(validateRecapOutput(`draft failed. ${text}`, snapshot).violations.map((v) => v.code)).toContain(
        'FABRICATED_ARTIFACT',
      )
    }
    expect(validateRecapOutput('draft failed. Expected report.md was not generated.', snapshot).valid).toBe(
      true,
    )
    expect(renderTruthBase(snapshot)).toContain('无已落盘产物（failed/未生成）')
  })

  it('retains only open decisions and reserves space for the complete batch warning', async () => {
    const b = await batch()
    const completed = await b.task('first', 'completed')
    await b.message('first', 'long result '.repeat(1000))
    await b.task('second', 'waiting_approval')
    await b.decision('second', 'old')
    await b.decision('second', 'old', true)
    await b.decision('second', 'pending')
    const snapshot = await b.snapshot()
    expect(snapshot).toMatchObject({ hasIncompleteWork: true, counts: { completed: 1, waitingApproval: 1 } })
    expect(snapshot.subtasks[1]?.approvalPending).toEqual({
      requestId: 'pending',
      toolName: 'write',
      summary: 'Review this file write',
    })
    const truth = renderTruthBase(snapshot)
    for (const expected of [
      '部分完成 / 等待审批',
      'requestId=pending',
      'toolName=write',
      'subagent_collect(first)',
    ])
      expect(truth).toContain(expected)
    const { system } = await childCompletionInput(b.parent, completed, 'completed')
    expect(system.summary.length).toBeLessThanOrEqual(2048)
    expect(system.summary).toMatch(
      /\[Batch State: completed=1\/2, waiting_approval=1, running=0, paused=0, disconnected=0, failed=0\]\nDO NOT report overall batch completion; unresolved subtasks remain\.$/,
    )
    expect(system.data).toMatchObject({
      batchState: { total: 2, completed: 1, waitingApproval: 1 },
      pendingApprovalsCount: 1,
    })
    const safe = 'second waiting_approval.'
    for (const claim of [
      '全部完成',
      '均已完成',
      '所有任务已完成',
      '全部已完成',
      'All tasks completed',
      'everything succeeded',
      'All done',
      '**All** tasks are **complete**',
      '2 of 2 tasks completed',
    ]) {
      expect(validateRecapOutput(`${safe}\n${claim}`, snapshot).violations.map((v) => v.code)).toContain(
        'FALSE_COMPLETION_CLAIM',
      )
    }
    expect(validateRecapOutput(`${safe}\nNot all tasks completed. 尚未全部完成。`, snapshot).valid).toBe(true)
    expect(validateRecapOutput(`${safe}\n两个子任务已全部结束（未全部完成）。`, snapshot).valid).toBe(true)
    expect(validateRecapOutput('first completed', snapshot).violations.map((v) => v.code)).toContain(
      'MISSING_INCOMPLETE_ITEM',
    )
    expect(validateRecapOutput('second completed', snapshot).violations.map((v) => v.code)).toContain(
      'STATUS_MISMATCH',
    )
  })

  it('reports mixed states, external provider listings and empty output with actual request counts', async () => {
    const b = await batch()
    for (const state of ['paused', 'idle', 'interrupted', 'cancelled', 'completed'] as const)
      await b.task(`local-${state}`, state)
    await b.request('local-paused')
    await b.request('local-paused')
    const remove = trackExternalChild(b.parent.key, {
      listing: { id: 'engine/worker', providerId: 'other', status: 'disconnected', continuable: false },
    })
    try {
      const snapshot = await b.snapshot()
      expect(snapshot.counts).toEqual({
        total: 6,
        completed: 1,
        paused: 1,
        disconnected: 1,
        cancelled: 1,
        waitingApproval: 0,
        failed: 0,
        running: 0,
      })
      expect(
        snapshot.subtasks
          .filter((x) => x.resumable)
          .map((x) => x.status)
          .sort(),
      ).toEqual(['idle', 'interrupted', 'paused'])
      const truth = renderTruthBase(snapshot)
      expect(truth).toContain('(no output) after 2 req')
      expect(truth).toContain('cancelled | cancelled | (no output) |')
      const missing = guardParentRecapReply(
        snapshot.subtasks
          .filter((x) => x.taskId !== 'engine/worker')
          .map((x) => `${x.taskId} ${x.status}`)
          .join('\n'),
        snapshot,
      )
      expect(missing.recapExitViolations).toEqual([
        { code: 'MISSING_INCOMPLETE_ITEM', detail: 'engine/worker' },
      ])
      expect(missing.replyText).toContain(truth)
    } finally {
      remove()
    }
  })

  it('dedupes a state transition across retries and permits a later recurrence', async () => {
    const b = await batch()
    const record = await b.task('worker', 'paused')
    await deliverChildStateNotice(b.parent, record, 'paused', 'checkpoint')
    await deliverChildStateNotice(b.parent, record, 'paused', 'retry')
    expect(await b.storage.casState('worker', record.stateRevision, 'running', { maxFanOut: 4 })).toBe(true)
    expect(await b.storage.casState('worker', record.stateRevision, 'paused')).toBe(true)
    await deliverChildStateNotice(b.parent, record, 'paused', 'next checkpoint')
    const inbox = b.parent.latest('inbox') as {
      items: { system: { type: string; data: { detail: string } } }[]
    }
    expect(
      inbox.items.filter((i) => i.system.type === 'child-state').map((i) => i.system.data.detail),
    ).toEqual(['checkpoint', 'next checkpoint'])
  })

  it('previews complete lines and falls back at both exits when a narrator invents facts', async () => {
    const b = await batch()
    await b.task('agent', 'paused')
    await b.message('agent', `First line\n${'x'.repeat(1500)}\nLast line`)
    const snapshot = await b.snapshot()
    const truth = renderTruthBase(snapshot)
    expect(truth).toContain('First line<br>… (3 lines, 1521 bytes) subagent_collect(agent)')
    const bad = 'All done. See fake.md'
    const hybrid = await generateHybridRecap(snapshot, async () => bad)
    expect(hybrid.narrativeSource).toBe('deterministic_fallback')
    expect(hybrid.markdown).not.toContain(bad)
    expect(hybrid.markdown).toBe(guardParentRecapReply(bad, snapshot).replyText)
    expect(hybrid.markdown.endsWith(truth)).toBe(true)
    const good = 'agent paused.'
    expect(await generateHybridRecap(snapshot, async () => good)).toMatchObject({
      narrativeSource: 'narrator',
      narrative: good,
    })
    expect(guardParentRecapReply(good, snapshot)).toEqual({ replyText: good, recapExitViolations: [] })
  })

  it('treats all-idle continuable children as settled and allows web URLs in natural summaries', async () => {
    const b = await batch()
    const first = await b.task('web-a', 'idle')
    await b.task('web-b', 'idle')
    const snapshot = await b.snapshot()
    expect(snapshot.hasIncompleteWork).toBe(false)
    const { system } = await childCompletionInput(b.parent, first, 'completed', { continuable: true })
    expect(system.summary).toMatch(
      /\[Batch State: completed=2\/2, waiting_approval=0, running=0, paused=0, disconnected=0, failed=0\]$/,
    )
    expect(system.summary).not.toContain('DO NOT report overall batch completion')
    const summary =
      '两个子智能体已全部完成检索。web-a 已完成查询 [Yahoo Finance](https://finance.yahoo.com/quote/NVDA) 与 example.com（NVDA.O），并引用错误 `no search provider/key is configured on this host` 与 盘前/盘中/盘后 状态。'
    expect(guardParentRecapReply(summary, snapshot)).toEqual({
      replyText: summary,
      recapExitViolations: [],
    })
    expect(renderTruthBase(snapshot)).toContain('**全部完成（已完成 2/2）**')
    expect(renderTruthBase(snapshot)).toContain('### Pending approvals and blockers\nNone.')
  })
})

it('replaces a fabricated final recap in the ledger and preserves a later ordinary reply', async () => {
  const normal = 'The example subtasks are completed in README.md.'
  const b = await batch(
    fakeProvider([
      toolTurn('subagent_recap', {}),
      textTurn('All subtasks completed. See fake.md.'),
      textTurn(normal),
      textTurn('All subtasks completed. See fake.md.'),
    ]),
  )
  const parent = b.parent
  try {
    await b.task('failed-child', 'failed')
    parent.d.registry.add(
      {
        name: 'subagent_recap',
        description: 'Read task evidence.',
        parameters: Type.Object({}, { additionalProperties: false }),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',
          requiresApproval: 'never',
        },
        execute: async () => ({ content: [{ type: 'text', text: 'failed-child failed' }] }),
      },
      { source: 'test', trust: 'builtin' },
    )
    const run = async (text: string) => {
      await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text }] })
      expect((await parent.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const [row] = await parent.scan({ type: 'assistant/message', order: 'desc', limit: 1 })
      return (row?.data as { content: { text: string }[] } | undefined)?.content[0]?.text
    }
    const recap = await run('What happened?')
    expect(recap).toContain('Runtime ledger facts')
    expect(recap).toContain('failed-child')
    expect(recap).not.toContain('fake.md')
    expect(await run('Summarize the subtask status vocabulary in this codebase.')).toBe(normal)
    const requestedRecap = await run('Are all the subtasks completed?')
    expect(requestedRecap).toContain('Runtime ledger facts')
    expect(requestedRecap).not.toContain('fake.md')
    expect(await parent.scan({ type: 'x/core/recap-exit-guard', limit: 3 })).toHaveLength(2)
  } finally {
    await parent.close()
  }
})
