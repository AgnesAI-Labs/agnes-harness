import { trackExternalChild } from '@agnes/core-child-control/child/directory'
import type { EventInput } from '@agnes/core-common/types'
import type { ChildExecutionState } from '@agnes/extension-api'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { childCompletionInput, deliverChildStateNotice } from '../src/child/completion-notice.js'
import { renderTruthBase } from '../src/child/recap-formatter.js'
import { generateHybridRecap } from '../src/child/recap-narrative.js'
import { buildRecapFactSnapshot } from '../src/child/recap-snapshot.js'
import {
  guardParentRecapReply,
  guardSessionRecapExit,
  validateRecapOutput,
} from '../src/child/recap-validator.js'
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
    expect(renderTruthBase(snapshot)).toContain('No write records (failed/not generated)')
    expect(renderTruthBase(snapshot, 'zh-CN')).toContain('没有写入记录（任务失败，未生成）')
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
      'Partially completed / Waiting approval 1',
      'requestId=pending',
      'toolName=write',
      'subagent_collect(first)',
    ])
      expect(truth).toContain(expected)
    expect(renderTruthBase(snapshot, 'zh-CN')).toContain('部分完成 / 等待审批 1 项')
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
    expect(renderTruthBase(snapshot)).toContain('**All completed (2/2 completed)**')
    expect(renderTruthBase(snapshot)).toContain('### Pending approvals and blockers\nNone.')
    expect(renderTruthBase(snapshot, 'zh-CN')).toContain('**全部完成（已完成 2/2）**')
    expect(renderTruthBase(snapshot, 'zh-CN')).toContain('### 待审批与阻塞项\n无。')
  })

  it('allows ordinary replies that quote child IDs in logs/translations while catching direct false status claims (#08)', async () => {
    const b = await batch()
    await b.task('root/alpha', 'paused')
    const triggerSeq = await b.append(
      b.parent.key,
      'user/message',
      { content: [{ type: 'text', text: 'What does this log line mean?' }] },
      { origin: 'user' },
    )
    const allowedReplies = [
      'In the log for `root/alpha`, the line "All steps completed." means the build finished successfully.',
      '日志里提到 `root/alpha` 时，后面的 "All steps completed." 意思是所有步骤已完成。',
      'I checked root/alpha earlier. All steps completed.',
      'For root/alpha, the quoted status "completed" translates to 已完成.',
      "In root/alpha's output, the HTTP parser failed to decode the response.",
      'If root/alpha is completed, we can merge the branch.',
      'When root/alpha is completed, run the release checks.',
      'Assume root/alpha is completed for this exercise.',
      'Assuming root/alpha is completed, estimate the remaining work.',
      'Suppose root/alpha is completed.',
      'Check whether root/alpha is completed before deploying.',
      'Verify if root/alpha is completed.',
      'Confirm whether root/alpha is completed.',
      'Please confirm if root/alpha is completed.',
      'Is root/alpha completed?',
      '如果 root/alpha 已完成，请继续下一步。',
      '假设 root/alpha 已完成，下一步如何处理。',
      '假定 root/alpha 已完成。',
      '请检查 root/alpha 是否已完成。',
      '请确认 root/alpha 是否已完成。',
      'root/alpha 完成了吗？',
      '- Verify that root/alpha is completed.',
      '* Verify that root/alpha is completed.',
      '+ Confirm that root/alpha is completed.',
      '1. Verify that root/alpha is completed.',
      '- **Verify** that root/alpha is completed.',
      '> Verify that root/alpha is completed.',
      'Run the checks to confirm that root/alpha is completed.',
      'Execute tests to verify that root/alpha is completed.',
      '- Run the checks to confirm that root/alpha is completed.',
      'Please run the checks to confirm that root/alpha is completed.',
      'Use subagent_recap to verify that root/alpha is completed.',
      'Inspect the ledger to confirm that root/alpha is completed.',
      '运行检查以确认 root/alpha 是否完成。',
      '运行检查以确认 root/alpha 已完成。',
      '执行测试以验证 root/alpha 已完成。',
      '- 请核查 root/alpha 是否已完成。',
      `root/alpha ${'is now already currently '.repeat(120)} pending completed`,
    ]
    for (const reply of allowedReplies) {
      const guarded = await guardSessionRecapExit(b.parent, reply, triggerSeq, 'ordinary')
      expect(guarded.event).toBeUndefined()
      expect(guarded.text).toBe(reply)
    }
    for (const badReply of [
      'root/alpha is completed.',
      '`root/alpha` completed.',
      'root/alpha 已完成。',
      'root/alpha: done',
      'I confirm that root/alpha is completed.',
      'I can confirm that root/alpha is completed.',
      'We verified that root/alpha is completed.',
      'We confirmed that root/alpha is completed.',
      'Confirmed that root/alpha is completed.',
      '- I confirm that root/alpha is completed.',
      'I am happy to confirm that root/alpha is completed.',
      'The team is proud to confirm that root/alpha is completed.',
      'Management is happy to confirm that root/alpha is completed.',
      'QA confirmed that root/alpha is completed.',
      'Our engineers ran tests to confirm that root/alpha is completed.',
      '我确认 root/alpha 已完成。',
      '我可以确认 root/alpha 已完成。',
      '已确认 root/alpha 已完成。',
      '团队确认 root/alpha 已完成。',
      '管理层很自豪地确认 root/alpha 已完成。',
    ]) {
      const guarded = await guardSessionRecapExit(b.parent, badReply, triggerSeq, 'ordinary')
      expect(guarded.event).toBeDefined()
      expect(guarded.text).toContain('Runtime ledger facts')
    }
  })

  it('rejects inflated or mismatched completion counts across zero, complete and partial batches (#09)', async () => {
    // Zero tasks
    const empty = await batch()
    const emptySnap = await empty.snapshot()
    for (const bad of [
      'All tasks completed.',
      '全部完成',
      '1 of 1 tasks completed.',
      '0 of 2 tasks completed.',
      'Completed 20 of 20 tasks.',
      '20 tasks completed.',
      '20 subtasks finished.',
      '已完成 20 个任务',
      '共完成 20 项',
    ]) {
      expect(validateRecapOutput(bad, emptySnap).violations.map((v) => v.code)).toContain(
        'FALSE_COMPLETION_CLAIM',
      )
    }
    expect(validateRecapOutput('No child tasks are recorded.', emptySnap).valid).toBe(true)
    expect(validateRecapOutput('0 of 0 tasks completed.', emptySnap).valid).toBe(true)
    expect(validateRecapOutput('0 tasks completed.', emptySnap).valid).toBe(true)

    // Empty tree explicit recap request keeps recap scope and intercepts fabricated counts
    const emptyTrigger = await empty.append(
      empty.parent.key,
      'user/message',
      { content: [{ type: 'text', text: 'Are all subtasks completed?' }] },
      { origin: 'user' },
    )
    const emptyGuarded = await guardSessionRecapExit(empty.parent, '20 of 20 tasks completed.', emptyTrigger)
    expect(emptyGuarded.event).toBeDefined()
    expect(emptyGuarded.text).toContain('No child tasks')
    const emptyAllGuarded = await guardSessionRecapExit(empty.parent, 'All tasks completed.', emptyTrigger)
    expect(emptyAllGuarded.event).toBeDefined()
    expect(emptyAllGuarded.text).toContain('No child tasks')
    const emptyHonest = await guardSessionRecapExit(
      empty.parent,
      'No child tasks are recorded.',
      emptyTrigger,
    )
    expect(emptyHonest.event).toBeUndefined()

    // All completed (1/1)
    const done = await batch()
    await done.task('only', 'completed')
    const doneSnap = await done.snapshot()
    for (const bad of [
      '20 of 20 tasks completed.',
      'Completed 20 of 20 tasks.',
      '20 tasks completed.',
      '20 subtasks finished.',
      '已完成 2/2 项子任务。',
      '已完成 20 个任务',
      '共完成 20 项',
      '1 of 5 tasks completed.',
    ]) {
      expect(validateRecapOutput(bad, doneSnap).violations.map((v) => v.code)).toContain(
        'FALSE_COMPLETION_CLAIM',
      )
    }
    for (const ok of [
      '1 of 1 tasks completed.',
      'Completed 1 of 1 tasks.',
      '1 task completed.',
      '已完成 1 个任务',
      '共完成 1 项',
      'All tasks completed.',
    ]) {
      expect(validateRecapOutput(ok, doneSnap).valid).toBe(true)
    }

    // Partial completion (1/2)
    const partial = await batch()
    await partial.task('one', 'completed')
    await partial.task('two', 'paused')
    const partialSnap = await partial.snapshot()
    for (const bad of [
      'two paused. 2 of 2 tasks completed.',
      'two paused. Completed 2 of 2 tasks.',
      'two paused. Completed: 20 of 20 tasks.',
      'two paused. **Completed**: 20 of 20 tasks.',
      'two paused. Completed - 20/20 tasks.',
      'two paused. Tasks completed: 20 of 20.',
      'two paused. Completed: 20 tasks.',
      'two paused. Completed: 20.',
      'two paused. Completed: 20. Next sentence.',
      'two paused. Tasks completed: 20.',
      'two paused. 2 tasks completed.',
      'two paused. 1 of 3 tasks completed.',
      'two paused. 已完成 3/3',
      'two paused. 已完成：20/20',
      'two paused. 已完成子任务：20/20',
      'two paused. 已完成：20。',
      'two paused. 已完成：20.',
      'two paused. 已完成 2 个任务',
      'two paused. 已完成：20 个任务',
      'two paused. 共完成 2 项',
      'two paused.\n| Metric | Count |\n| --- | --- |\n| Tasks completed | 20/20 |',
      'two paused.\n| Metric | Count | Example task |\n| --- | --- | --- |\n| Tasks completed | 20/20 | one |',
      'two paused.\n| Example task | Metric | Count |\n| --- | --- | --- |\n| one | Tasks completed | 20/20 |',
      'two paused.\n| 指标 | 数值 | 示例任务 |\n| --- | --- | --- |\n| 已完成任务 | 20/20 | one |',
      'two paused.\n| Metric | Count |\n| --- | --- |\n| Completed tasks | 20 of 20 |',
      'two paused.\n| 指标 | 数值 |\n| --- | --- |\n| 已完成任务 | 20/20 |',
      'two paused.\n| 指标 | 数值 |\n| --- | --- |\n| 已完成 | 20 |',
      'two paused.\n| Tasks completed | Pending |\n| --- | --- |\n| 20/20 | 0 |',
    ]) {
      expect(validateRecapOutput(bad, partialSnap).violations.map((v) => v.code)).toContain(
        'FALSE_COMPLETION_CLAIM',
      )
    }
    expect(validateRecapOutput('1 of 2 tasks completed. one completed. two paused.', partialSnap).valid).toBe(
      true,
    )
    expect(validateRecapOutput('Completed 1 of 2 tasks. one completed. two paused.', partialSnap).valid).toBe(
      true,
    )
    expect(
      validateRecapOutput('Completed: 1 of 2 tasks. one completed. two paused.', partialSnap).valid,
    ).toBe(true)
    expect(validateRecapOutput('one completed. two paused. Completed: 1.', partialSnap).valid).toBe(true)
    expect(validateRecapOutput('one completed. two paused. Completed: 20.5s.', partialSnap).valid).toBe(true)
    expect(validateRecapOutput('one completed. two paused. Completed: 1.5 MB.', partialSnap).valid).toBe(true)
    expect(
      validateRecapOutput(
        'one completed. two paused. Test suite results:\n| Test suite | Completed | Total |\n| --- | --- | --- |\n| Unit tests | 20 | 20 |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(
      validateRecapOutput(
        'one completed. two paused.\n| Suite | Completed | Total |\n| --- | --- | --- |\n| Integration checks | 12 | 12 |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(
      validateRecapOutput(
        'one 已完成，two 已暂停。测试结果：\n| 测试套件 | 已完成 | 总数 |\n| --- | --- | --- |\n| 单元测试 | 20 | 20 |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(
      validateRecapOutput(
        'one completed. two paused.\n| Metric | Count | Example task |\n| --- | --- | --- |\n| Tasks completed | 1/2 | one |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(
      validateRecapOutput(
        'one completed. two paused.\n| Task | Status | Completed |\n| --- | --- | --- |\n| one | completed | 5 |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(
      validateRecapOutput(
        'one completed. two paused.\n| Metric | Count |\n| --- | --- |\n| Tasks completed | 1/2 |\n| Completed tasks | 1 of 2 |\n| Tests passed | 20/20 |\n| Completed | 20.5s |\n| Completed | 1.5 MB |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(
      validateRecapOutput(
        'one 已完成，two 已暂停。\n| 指标 | 数值 |\n| --- | --- |\n| 已完成任务 | 1/2 |\n| 已完成 | 1 |\n| 测试通过 | 20/20 |',
        partialSnap,
      ).valid,
    ).toBe(true)
    expect(validateRecapOutput('1 task completed. one completed. two paused.', partialSnap).valid).toBe(true)
    expect(validateRecapOutput('共完成 1 项。one 已完成，two 已暂停。', partialSnap).valid).toBe(true)
    expect(validateRecapOutput('已完成：1/2 项子任务。one 已完成，two 已暂停。', partialSnap).valid).toBe(
      true,
    )
    expect(validateRecapOutput('one completed 3/3 tests. two paused.', partialSnap).valid).toBe(true)
    expect(
      validateRecapOutput('Completed: 20 of 20 tests. one completed. two paused.', partialSnap).valid,
    ).toBe(true)
    expect(
      validateRecapOutput('Tests completed: 20 of 20. one completed. two paused.', partialSnap).valid,
    ).toBe(true)
    expect(validateRecapOutput('已完成 3 项测试。one 已完成，two 已暂停。', partialSnap).valid).toBe(true)
    expect(validateRecapOutput('已完成：20 项测试。one 已完成，two 已暂停。', partialSnap).valid).toBe(true)
  })

  it('includes external grandchildren under verified local owners and disambiguates ID collisions (#13)', async () => {
    const b = await batch()
    await b.task('child-a', 'idle')
    const removeRootExt = trackExternalChild(b.parent.key, {
      listing: { id: 'shared-ext', providerId: 'acp', status: 'completed', continuable: false },
    })
    const removeGrandchild = trackExternalChild('child-a', {
      listing: { id: 'shared-ext', providerId: 'acp', status: 'running', continuable: false },
    })
    const removeUnrelated = trackExternalChild('unrelated-session', {
      listing: { id: 'foreign-ext', providerId: 'acp', status: 'running', continuable: false },
    })
    const removeP = trackExternalChild(b.parent.key, {
      listing: { id: 'x', providerId: 'p', status: 'completed', continuable: false },
    })
    const removeQ = trackExternalChild('child-a', {
      listing: { id: 'x', providerId: 'q', status: 'paused', continuable: false },
    })
    const removeR = trackExternalChild(b.parent.key, {
      listing: { id: 'p:x', providerId: 'r', status: 'running', continuable: false },
    })
    try {
      const snapshot = await b.snapshot()
      expect(snapshot.hasIncompleteWork).toBe(true)
      expect(snapshot.counts).toMatchObject({ total: 6, completed: 2, running: 2, paused: 1 })
      expect(snapshot.subtasks.map((t) => t.taskId)).not.toContain('foreign-ext')
      expect(snapshot.subtasks.filter((t) => t.status === 'running')).toHaveLength(2)
      expect(new Set(snapshot.subtasks.map((t) => t.taskId)).size).toBe(6)
      // Ambiguous qualified key `p:x` collides with provider=p,id=x and provider=r,id=p:x and must throw
      await expect(buildRecapFactSnapshot(b.parent, { childKey: 'p:x' })).rejects.toMatchObject({
        code: 'E_CHILD_AMBIGUOUS',
      })
      // Unambiguous disambiguated IDs resolve to the exact single external child
      const rOnly = await buildRecapFactSnapshot(b.parent, { childKey: 'r:p:x' })
      expect(rOnly.subtasks).toHaveLength(1)
      expect(rOnly.subtasks[0]).toMatchObject({ taskId: 'r:p:x', status: 'running' })
      const pOnly = await buildRecapFactSnapshot(b.parent, { childKey: `${b.parent.key}::p:x` })
      expect(pOnly.subtasks).toHaveLength(1)
      expect(pOnly.subtasks[0]).toMatchObject({ taskId: `${b.parent.key}::p:x`, status: 'completed' })
      const truth = renderTruthBase(snapshot)
      expect(truth).toContain('Partially completed')
      expect(truth).not.toContain('All completed')
      expect(truth).not.toContain('foreign-ext')
    } finally {
      removeRootExt()
      removeGrandchild()
      removeUnrelated()
      removeP()
      removeQ()
      removeR()
    }
  })

  it('distinguishes verified, non-file directory, ENOENT missing, unverifiable stat failure and no-write artifacts (#21)', async () => {
    const b = await batch()
    await b.task('ok-task', 'completed')
    await b.write('ok-task', 'ok.txt')
    await b.task('dir-task', 'completed')
    await b.write('dir-task', 'out-dir')
    await b.task('missing-task', 'completed')
    await b.write('missing-task', 'gone.txt')
    await b.task('enotdir-task', 'completed')
    await b.write('enotdir-task', 'not-a-dir/out.txt')
    await b.task('eio-task', 'completed')
    await b.write('eio-task', 'ready.txt')
    await b.task('eacces-task', 'completed')
    await b.write('eacces-task', 'secret.txt')
    await b.task('empty-task', 'completed')

    const snapshot = await buildRecapFactSnapshot(b.parent, {
      stat: async (abs) => {
        if (abs === '/w/ok.txt') return { kind: 'file' }
        if (abs === '/w/out-dir') return { kind: 'directory' }
        if (abs === '/w/gone.txt') throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        if (abs === '/w/not-a-dir/out.txt')
          throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
        if (abs === '/w/ready.txt') throw Object.assign(new Error('io error'), { code: 'EIO' })
        if (abs === '/w/secret.txt') throw Object.assign(new Error('denied'), { code: 'EACCES' })
        throw new Error('ENOENT')
      },
    })
    expect(snapshot.allowedArtifactPaths).toEqual(['ok.txt'])
    expect(validateRecapOutput('eio-task wrote ready.txt', snapshot).violations.map((v) => v.code)).toContain(
      'FABRICATED_ARTIFACT',
    )
    const enTruth = renderTruthBase(snapshot, 'en')
    expect(enTruth).toContain('[ok-task] (—) -> ok.txt')
    expect(enTruth).toContain('[dir-task] (—) Recorded artifact path(s) are directories or non-regular files')
    expect(enTruth).not.toContain('[dir-task] (—) Recorded artifacts currently missing')
    expect(enTruth).toContain('[missing-task] (—) Recorded artifacts currently missing')
    expect(enTruth.split('\n').find((line) => line.includes('[missing-task]'))).toContain('ENOENT')
    const enEnotdirLine = enTruth.split('\n').find((line) => line.includes('[enotdir-task]'))
    expect(enEnotdirLine).toContain('Recorded artifacts currently missing')
    expect(enEnotdirLine).toContain('ENOTDIR')
    expect(enEnotdirLine).not.toContain('ENOENT')
    expect(enTruth).toContain('[eio-task] (—) Artifacts could not be verified')
    expect(enTruth).toContain('EIO')
    expect(enTruth).toContain('[eacces-task] (—) Artifacts could not be verified')
    expect(enTruth).toContain('EACCES')
    expect(enTruth).toContain('[empty-task] (—) No write records')

    const zhTruth = renderTruthBase(snapshot, 'zh-CN')
    expect(zhTruth).toContain('[dir-task] (—) 已记录路径为目录或非普通文件')
    expect(zhTruth).toContain('[missing-task] (—) 产物当前不存在')
    const zhEnotdirLine = zhTruth.split('\n').find((line) => line.includes('[enotdir-task]'))
    expect(zhEnotdirLine).toContain('产物当前不存在')
    expect(zhEnotdirLine).toContain('ENOTDIR')
    expect(zhEnotdirLine).not.toContain('ENOENT')
    expect(zhTruth).toContain('[eio-task] (—) 无法复核产物')
    expect(zhTruth).toContain('[empty-task] (—) 没有写入记录')

    // Missing workspaceInvocation (stat unavailable) also reports unverifiable rather than not generated
    const saved = b.parent.d.workspaceInvocation
    ;(b.parent.d as { workspaceInvocation?: unknown }).workspaceInvocation = undefined
    try {
      const noStatSnap = await buildRecapFactSnapshot(b.parent)
      expect(noStatSnap.allowedArtifactPaths).toEqual([])
      expect(renderTruthBase(noStatSnap, 'zh-CN')).toContain('[eio-task] (—) 无法复核产物')
      expect(renderTruthBase(noStatSnap, 'en')).toContain('STAT_UNAVAILABLE')
    } finally {
      ;(b.parent.d as { workspaceInvocation?: unknown }).workspaceInvocation = saved
    }
  })

  it('excludes bare, parenthesized and balanced-paren reference URLs while rejecting claimed URLs and local paths (#22)', async () => {
    const b = await batch()
    await b.task('doc-child', 'completed')
    const snapshot = await b.snapshot()
    for (const valid of [
      'doc-child completed. See https://example.org/guide/setup.md for details.',
      'doc-child completed (reference: https://example.org/guide/setup.md).',
      'doc-child completed. Reference [setup guide](https://example.org/guide/setup.md).',
      'doc-child completed. See https://example.org/ref(v2)/guide.md for details.',
      'doc-child completed (see https://example.org/ref(v2)/guide.md).',
      'doc-child completed. Reference [v2 guide](https://example.org/ref(v2)/guide.md).',
      'doc-child completed. Contact mailto:ops@example.org for access.',
    ]) {
      expect(validateRecapOutput(valid, snapshot)).toEqual({ valid: true, violations: [] })
    }
    for (const invalid of [
      'doc-child completed. Created https://example.org/guide/setup.md',
      'doc-child completed. Created https://example.org/ref(v2)/guide.md',
      'doc-child completed. See https://example.org/ref(v2)/guide.md and local/missing.md',
      'doc-child completed (https://example.org/ref(v2)/guide.md) /tmp/fake.md',
      'doc-child completed. See guide/setup.md',
      'doc-child completed. See /tmp/setup.md',
      'doc-child completed. See [setup](guide/setup.md)',
    ]) {
      expect(validateRecapOutput(invalid, snapshot).violations.map((v) => v.code)).toContain(
        'FABRICATED_ARTIFACT',
      )
    }
  })

  it('scopes single-task recap snapshot, formatter and exit guard without letting tool narrowing override full-tree intent (#23)', async () => {
    const b = await batch()
    await b.task('root/alpha', 'completed')
    await b.task('root/beta', 'waiting_approval')

    const full = await b.snapshot()
    expect(validateRecapOutput('root/alpha completed.', full).violations).toContainEqual({
      code: 'MISSING_INCOMPLETE_ITEM',
      detail: 'root/beta',
    })

    const scoped = await buildRecapFactSnapshot(b.parent, { childKey: 'root/alpha' })
    expect(scoped.subtasks.map((t) => t.taskId)).toEqual(['root/alpha'])
    expect(scoped.hasIncompleteWork).toBe(false)
    expect(validateRecapOutput('root/alpha completed.', scoped)).toEqual({ valid: true, violations: [] })
    expect(renderTruthBase(scoped)).toContain('Scope: root/alpha')
    expect(renderTruthBase(scoped)).not.toContain('root/beta')

    // User asks for full-tree recap, model only calls subagent_recap({ childKey: 'root/alpha' }):
    // final validation MUST remain full-tree and reject "All subtasks completed."!
    const fullTreeTrigger = await b.append(
      b.parent.key,
      'user/message',
      { content: [{ type: 'text', text: 'Are all subtasks completed?' }] },
      { origin: 'user' },
    )
    await b.append(
      b.parent.key,
      'tool/call',
      { name: 'subagent_recap', toolUseId: 'recap-1', args: { childKey: 'root/alpha' } },
      { origin: 'model' },
    )
    const fullTreeGuarded = await guardSessionRecapExit(b.parent, 'All subtasks completed.', fullTreeTrigger)
    expect(fullTreeGuarded.event).toBeDefined()
    expect(fullTreeGuarded.text).toContain('root/beta')
    expect(fullTreeGuarded.text).toContain('Partially completed')

    // Same single-child tool sequence across 3 prompt groups (EN & ZH):
    // 1. Pure full-tree, 2. Full-tree + documentation/links/blockers, 3. Negated full-tree + explicit single target.
    for (const [prompt, reply, expectedHeading] of [
      ['Summarize all subtasks.', 'All subtasks completed.', 'Partially completed'],
      ['汇总所有子任务', '全部完成。', '部分完成'],
      ['Please summarize all subtasks and list blockers.', 'All subtasks completed.', 'Partially completed'],
      ['汇总所有子任务并列出阻塞项', '全部完成。', '部分完成'],
      [
        'Summarize all subtasks and include links to their documentation.',
        'All subtasks completed.',
        'Partially completed',
      ],
      ['汇总所有子任务并附上文档链接', '全部完成。', '部分完成'],
    ] as const) {
      const seq = await b.append(
        b.parent.key,
        'user/message',
        { content: [{ type: 'text', text: prompt }] },
        { origin: 'user' },
      )
      await b.append(
        b.parent.key,
        'tool/call',
        { name: 'subagent_recap', toolUseId: `recap-${seq}`, args: { childKey: 'root/alpha' } },
        { origin: 'model' },
      )
      const guarded = await guardSessionRecapExit(b.parent, reply, seq)
      expect(guarded.event).toBeDefined()
      expect(guarded.text).toContain('root/beta')
      expect(guarded.text).toContain(expectedHeading)
    }

    for (const [prompt, reply, withTool] of [
      ['Do not summarize all subtasks. Only recap root/alpha.', 'root/alpha is completed.', true],
      ["Don't summarize all subtasks; only recap root/alpha.", 'root/alpha is completed.', true],
      ['Never recap all subtasks. Only recap root/alpha.', 'root/alpha is completed.', false],
      ['不要总结所有子任务，只回顾 root/alpha', 'root/alpha 已完成。', true],
      ['别汇总全部子任务，仅回顾 root/alpha', 'root/alpha 已完成。', true],
      ['勿回顾所有子任务，只总结 root/alpha', 'root/alpha 已完成。', false],
    ] as const) {
      const seq = await b.append(
        b.parent.key,
        'user/message',
        { content: [{ type: 'text', text: prompt }] },
        { origin: 'user' },
      )
      if (withTool) {
        await b.append(
          b.parent.key,
          'tool/call',
          { name: 'subagent_recap', toolUseId: `recap-neg-${seq}`, args: { childKey: 'root/alpha' } },
          { origin: 'model' },
        )
      }
      const guarded = await guardSessionRecapExit(b.parent, reply, seq)
      expect(guarded.event).toBeUndefined()
      expect(guarded.text).toBe(reply)
      expect(guarded.text).not.toContain('root/beta')
    }

    // Pure codebase/documentation and mechanism/how-to questions remain ordinary scope,
    // and ledger-visible tool calls never override full-tree intent or excluded-sibling single-task scope.
    const scopedLog = await batch()
    try {
      await scopedLog.task('root/alpha', 'completed')
      await scopedLog.task('root/beta', 'waiting_approval')
      let logTurn = 0
      const appendParentTurn = async (prompt: string, toolChildKey?: string) => {
        const promptRes = await scopedLog.parent.d.log.append([
          scopedLog.parent.ev(
            'user/message',
            { kind: 'prompt', content: [{ type: 'text', text: prompt }] },
            { origin: 'principal' },
          ),
        ])
        const seq = promptRes.firstSeq
        if (toolChildKey !== undefined) {
          const turn = ++logTurn
          const toolUseId = `recap-log-${turn}`
          await scopedLog.parent.d.log.append([
            scopedLog.parent.ev('turn/start', { turn, trigger: 'prompt' }),
            scopedLog.parent.ev('step/start', { turn, step: 1 }),
            scopedLog.parent.ev(
              'tool/call',
              {
                ordinal: 0,
                toolUseId,
                name: 'subagent_recap',
                args: toolChildKey ? { childKey: toolChildKey } : {},
              },
              { origin: 'model' },
            ),
            scopedLog.parent.ev(
              'tool/result',
              {
                toolUseId,
                content: [],
                isError: false,
                enforcement: { level: 'full', scope: [] },
                authz: { decisionId: 'n/a' },
              },
              { origin: 'tool:subagent_recap' },
            ),
            scopedLog.parent.ev('step/end', { turn, step: 1 }),
            scopedLog.parent.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
          ])
        }
        return seq
      }

      for (const [prompt, reply] of [
        [
          'Summarize all subtasks documentation in this codebase.',
          'All subtasks are documented in README.md.',
        ],
        ['How does the current implementation summarize all subtasks?', 'The CLI groups the rows by status.'],
        ['How does the documentation say to recap root/beta?', 'Use the Recap action in the child row.'],
        ['How does the documentation explain recapping root/beta?', 'Open the child row and click Recap.'],
        ['How do I recap root/beta?', 'Click Recap on the row.'],
        ['Where does the code summarize all subtasks?', 'See packages/core/src/child/recap-formatter.ts.'],
        ['Explain how to recap root/beta.', 'Invoke subagent_recap with its childKey.'],
        ['当前实现如何汇总所有子任务？', 'CLI 按状态分组展示子任务。'],
        ['怎么回顾 root/beta？', '点击该行的回顾按钮即可。'],
      ] as const) {
        const seq = await appendParentTurn(prompt)
        const guarded = await guardSessionRecapExit(scopedLog.parent, reply, seq)
        expect(guarded.event).toBeUndefined()
        expect(guarded.text).toBe(reply)
      }

      // Ledger-visible single-child tool call cannot narrow an explicit full-tree request (even with doc links).
      const linkedFullSeq = await appendParentTurn(
        'Summarize all subtasks and include links to their documentation.',
        'root/alpha',
      )
      const linkedTools = await scopedLog.parent.scan({
        type: 'tool/call',
        fromSeq: linkedFullSeq,
        toSeq: scopedLog.parent.lastSeq,
        lane: scopedLog.parent.lane,
      })
      expect(linkedTools.map((row) => (row.data as { args?: { childKey?: string } }).args?.childKey)).toEqual(
        ['root/alpha'],
      )
      const linkedFullGuarded = await guardSessionRecapExit(
        scopedLog.parent,
        'All subtasks completed.',
        linkedFullSeq,
      )
      expect(linkedFullGuarded.event).toBeDefined()
      expect(linkedFullGuarded.text).toContain('root/beta')

      // Explicitly excluded sibling stays out of single-task scope even when the model mistakenly called subagent_recap on it.
      for (const prompt of [
        'Only recap root/alpha.',
        'Only recap root/alpha instead of root/beta.',
        'Only recap root/alpha rather than root/beta.',
        'Only recap root/alpha excluding root/beta.',
        'Only recap root/alpha except root/beta.',
        'Only recap root/alpha, not root/beta.',
        '只回顾 root/alpha 而不是 root/beta',
        '只回顾 root/alpha 排除 root/beta',
        '只回顾 root/alpha 不要 root/beta',
      ]) {
        const seq = await appendParentTurn(prompt, 'root/beta')
        const observedTools = await scopedLog.parent.scan({
          type: 'tool/call',
          fromSeq: seq,
          toSeq: scopedLog.parent.lastSeq,
          lane: scopedLog.parent.lane,
        })
        expect(
          observedTools.map((row) => (row.data as { args?: { childKey?: string } }).args?.childKey),
        ).toEqual(['root/beta'])
        const okScoped = await guardSessionRecapExit(scopedLog.parent, 'All subtasks completed.', seq)
        expect(okScoped.event).toBeUndefined()
        expect(okScoped.text).toBe('All subtasks completed.')
        const badScoped = await guardSessionRecapExit(scopedLog.parent, 'root/alpha failed.', seq)
        expect(badScoped.event).toBeDefined()
        expect(badScoped.text).toContain('root/alpha')
        expect(badScoped.text).not.toContain('root/beta')
      }
    } finally {
      await scopedLog.parent.close()
    }

    // Explicit ambiguous single-child target never falls back to a full-tree recap or leaks unrelated siblings.
    const releaseAmbiguous = [
      trackExternalChild(b.parent.key, {
        listing: { id: 'x', providerId: 'p', status: 'completed', continuable: false },
      }),
      trackExternalChild('root/beta', {
        listing: { id: 'x', providerId: 'q', status: 'paused', continuable: false },
      }),
      trackExternalChild(b.parent.key, {
        listing: { id: 'p:x', providerId: 'z', status: 'running', continuable: false },
      }),
    ]
    try {
      const enAmbigSeq = await b.append(
        b.parent.key,
        'user/message',
        {
          content: [
            {
              type: 'text',
              text: 'Use subagent_recap with childKey "p:x" to summarize the verified results and current status of this subagent.',
            },
          ],
        },
        { origin: 'user' },
      )
      const enAmbig = await guardSessionRecapExit(b.parent, 'All subtasks completed.', enAmbigSeq)
      expect(enAmbig.event).toBeDefined()
      expect(enAmbig.text).toContain('E_CHILD_AMBIGUOUS')
      expect(enAmbig.text).toContain('p:x')
      expect(enAmbig.text).toContain(`${b.parent.key}::p:x`)
      expect(enAmbig.text).toContain('z:p:x')
      expect(enAmbig.text).not.toContain('root/alpha')
      expect(enAmbig.text).not.toContain('root/beta')

      const zhAmbigSeq = await b.append(
        b.parent.key,
        'user/message',
        {
          content: [
            {
              type: 'text',
              text: '请调用 subagent_recap（参数 childKey: "p:x"），回顾该子代理的当前状态和已核实的结果。',
            },
          ],
        },
        { origin: 'user' },
      )
      const zhAmbig = await guardSessionRecapExit(b.parent, '全部完成。', zhAmbigSeq)
      expect(zhAmbig.event).toBeDefined()
      expect(zhAmbig.text).toContain('E_CHILD_AMBIGUOUS')
      expect(zhAmbig.text).toContain('存在歧义')
      expect(zhAmbig.text).not.toContain('root/alpha')
      expect(zhAmbig.text).not.toContain('root/beta')

      const optAmbig = await guardSessionRecapExit(
        b.parent,
        'All subtasks completed.',
        fullTreeTrigger,
        'recap',
        {
          childKey: 'p:x',
        },
      )
      expect(optAmbig.event).toBeDefined()
      expect(optAmbig.text).toContain('E_CHILD_AMBIGUOUS')
      expect(optAmbig.text).not.toContain('root/alpha')
      expect(optAmbig.text).not.toContain('root/beta')
    } finally {
      for (const release of releaseAmbiguous) release()
    }

    // Real English dictionary single-row prompt with quoted childKey & NO tool call
    const enQuotedBetaTrigger = await b.append(
      b.parent.key,
      'user/message',
      {
        content: [
          {
            type: 'text',
            text: 'Use subagent_recap with childKey "root/beta" to summarize the verified results and current status of this subagent.',
          },
        ],
      },
      { origin: 'user' },
    )
    const enBetaBad = await guardSessionRecapExit(b.parent, 'All tasks completed.', enQuotedBetaTrigger)
    expect(enBetaBad.event).toBeDefined()
    expect(enBetaBad.text).toContain('Scope: root/beta')
    expect(enBetaBad.text).not.toContain('root/alpha')

    const enQuotedAlphaTrigger = await b.append(
      b.parent.key,
      'user/message',
      {
        content: [
          {
            type: 'text',
            text: 'Use subagent_recap with childKey "root/alpha" to summarize the verified results and current status of this subagent.',
          },
        ],
      },
      { origin: 'user' },
    )
    const enAlphaOk = await guardSessionRecapExit(b.parent, 'root/alpha completed.', enQuotedAlphaTrigger)
    expect(enAlphaOk.event).toBeUndefined()
    expect(enAlphaOk.text).toBe('root/alpha completed.')

    // Unquoted subagent name prompt
    const triggerSeq = await b.append(
      b.parent.key,
      'user/message',
      {
        content: [
          {
            type: 'text',
            text: 'Use subagent_recap to summarize the verified results and current status of subagent root/alpha.',
          },
        ],
      },
      { origin: 'user' },
    )
    const ok = await guardSessionRecapExit(b.parent, 'root/alpha completed.', triggerSeq)
    expect(ok.event).toBeUndefined()
    expect(ok.text).toBe('root/alpha completed.')

    // False claim on scoped child still gets caught and replaced with scoped recap only
    const bad = await guardSessionRecapExit(b.parent, 'root/alpha failed.', triggerSeq)
    expect(bad.event).toBeDefined()
    expect(bad.text).toContain('root/alpha')
    expect(bad.text).not.toContain('root/beta')

    // Real Chinese dictionary single-row prompt with NO tool call
    const zhRealBetaTrigger = await b.append(
      b.parent.key,
      'user/message',
      {
        content: [
          {
            type: 'text',
            text: '请调用 subagent_recap（参数 childKey: "root/beta"），回顾该子代理的当前状态和已核实的结果。',
          },
        ],
      },
      { origin: 'user' },
    )
    const zhBetaBad = await guardSessionRecapExit(b.parent, '全部完成。', zhRealBetaTrigger)
    expect(zhBetaBad.event).toBeDefined()
    expect(zhBetaBad.text).toContain('范围：root/beta')
    expect(zhBetaBad.text).not.toContain('root/alpha')

    const zhTriggerSeq = await b.append(
      b.parent.key,
      'user/message',
      {
        content: [
          {
            type: 'text',
            text: '请调用 subagent_recap（参数 childKey: "root/alpha"），回顾该子代理的当前状态和已核实的结果。',
          },
        ],
      },
      { origin: 'user' },
    )
    const zhOk = await guardSessionRecapExit(b.parent, 'root/alpha 已完成。', zhTriggerSeq)
    expect(zhOk.event).toBeUndefined()
    expect(zhOk.text).toBe('root/alpha 已完成。')
  })

  it('renders clean localized Chinese and English deterministic recaps without mixed headings (#34)', async () => {
    const b = await batch()
    await b.task('worker-run', 'running')
    await b.task('worker-pause', 'paused')
    const snapshot = await b.snapshot()

    const enFallback = guardParentRecapReply('All done.', snapshot, 'en')
    expect(enFallback.replyText).toContain('## Executive summary')
    expect(enFallback.replyText).toContain('## Runtime ledger facts')
    expect(enFallback.replyText).toContain('### Verified artifacts')
    expect(enFallback.replyText).toContain('### Pending approvals and blockers')
    expect(enFallback.replyText).not.toMatch(/[\p{Script=Han}]/u)

    const zhFallback = guardParentRecapReply('全部完成。', snapshot, 'zh-CN')
    expect(zhFallback.replyText).toContain('## 执行摘要')
    expect(zhFallback.replyText).toContain('## 运行时账本事实')
    expect(zhFallback.replyText).toContain('### 已验证产物')
    expect(zhFallback.replyText).toContain('### 待审批与阻塞项')
    expect(zhFallback.replyText).toContain('运行中 1')
    expect(zhFallback.replyText).toContain('已暂停 1')
    // Localized Chinese table columns with canonical enums preserved alongside, and raw enums preserved in snapshot
    expect(zhFallback.replyText).toContain('| 运行中 (running) | 运行中 (running) |')
    expect(zhFallback.replyText).toContain('| 已暂停 (paused) | 已暂停 (paused) |')
    expect(zhFallback.replyText).toContain('可恢复 (resumable: true)')
    expect(snapshot.subtasks.find((t) => t.taskId === 'worker-run')).toMatchObject({
      status: 'running',
      executionState: 'running',
    })
    expect(snapshot.subtasks.find((t) => t.taskId === 'worker-pause')).toMatchObject({
      status: 'paused',
      executionState: 'paused',
    })
    // No mixed English headings or status counters
    expect(zhFallback.replyText).not.toContain('Running 1')
    expect(zhFallback.replyText).not.toContain('Verified artifacts')
    expect(zhFallback.replyText).not.toContain('Pending approvals and blockers')
    expect(validateRecapOutput(zhFallback.replyText, snapshot)).toEqual({ valid: true, violations: [] })
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
