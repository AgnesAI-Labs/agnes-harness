import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkServiceDef, checkToolDef } from '@agnes/extension-api'
import { driveLoop, scriptedDecisions } from '@agnes/plugin-runtime/testkit'
import { validateProjectionCapability } from '@agnes/protocol'
import { main, qualityReadService, qualityWorkflow } from '../bundled-plugins/skill-quality/index.mjs'
import {
  candidateReceipt,
  emptyState,
  parseEvidence,
  projection,
  qualityView,
} from '../bundled-plugins/skill-quality/src/model.mjs'
import { createTools } from '../bundled-plugins/skill-quality/src/tools.mjs'
import { AuthoringCandidates } from '../src/authoring-candidates.js'
import { emptyLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'

const hash = (letter) => `sha256-${letter.repeat(64)}`
const id = `candidate-${'1'.repeat(32)}`
const imported = () =>
  JSON.parse(
    readFileSync(new URL('../bundled-plugins/skill-quality/src/fixtures/eval.json', import.meta.url), 'utf8'),
  )
function fixture() {
  let candidate = {
    candidateId: id,
    candidateHash: hash('a'),
    baseHash: null,
    packageId: 'synthetic-skill',
    state: 'draft',
    origin: { sessionKey: 'source-session' },
    tests: null,
    reviewer: null,
  }
  const store = new Map(),
    events = [],
    requests = []
  const controller = new AbortController()
  const ctx = {
    session: { key: 'session-a', depth: 0 },
    signal: controller.signal,
    store: {
      get: (key) => structuredClone(store.get(key)),
      set: (key, value) => store.set(key, structuredClone(value)),
    },
    pluginManage: {
      async request(input) {
        requests.push(input)
        if (input.action === 'candidate.test') {
          candidate.state = 'tested'
          candidate.tests = { hash: candidate.candidateHash, state: 'passed', count: 1, runner: 'node-test' }
        }
        if (input.action === 'candidate.submit') {
          if (candidate.state === 'rejected') throw new Error('Rejected by human')
          candidate.state = 'review'
        }
        return structuredClone(candidate)
      },
    },
  }
  const tools = createTools({
    eventLog: {
      async append(name, data) {
        events.push({ name, data: structuredClone(data) })
      },
    },
  })
  const invoke = (name, args) => tools.find((tool) => tool.name === name).execute(args, ctx)
  const attach = (args = {}) =>
    invoke('skill_quality_import', { candidateId: id, evidenceJson: JSON.stringify(imported()), ...args })
  return {
    ctx,
    tools,
    invoke,
    attach,
    requests,
    events,
    store,
    controller,
    setCandidate(value) {
      candidate = { ...candidate, ...value }
    },
    getCandidate: () => structuredClone(candidate),
  }
}
export function registerQualityTests(test) {
  test('manual eval evidence keeps examples, environment and provenance separate from Host tests and human review', async () => {
    const f = fixture()
    for (const tool of f.tools) assert.equal(checkToolDef(tool, { prefix: 'skill_quality_' }).ok, true)
    assert.equal(checkServiceDef(qualityReadService).ok, true)
    const result = await f.attach({ currentInstalledHash: null })
    assert.equal(result.structured.freshness, 'observed')
    assert.deepEqual(result.structured.counts, { passed: 1, failed: 1, skipped: 0, executed: 2 })
    assert.equal(result.structured.evidence.environment.seed, 7)
    assert.equal(result.structured.candidate.sourceSession, 'source-session')
    assert.equal(result.structured.candidate.hostTests, null)
    assert.equal(result.structured.candidate.humanReviewer, null)
    assert.equal(result.structured.verified, false)
    assert.equal(result.structured.authority, 'eval-import')
    assert.equal(result.structured.evidence.cases[1].actual.includes('fake effect'), true)
    const self = imported()
    self.kind = 'self-assessment'
    assert.equal(
      (await f.attach({ evidenceJson: JSON.stringify(self) })).structured.authority,
      'self-assessment',
    )
    assert.deepEqual(
      f.requests.map((row) => row.action),
      ['candidate.show', 'candidate.show'],
    )
  })
  test('candidate edits, candidate base changes and current installed observations invalidate old evidence; missing state is unknown', async () => {
    const f = fixture()
    assert.equal((await f.attach()).structured.freshness, 'unknown')
    assert.equal((await f.attach({ currentInstalledHash: hash('d') })).structured.freshness, 'stale')
    f.setCandidate({ candidateHash: hash('d') })
    const read = await f.invoke('skill_quality_candidate', { action: 'read', candidateId: id })
    assert.equal(read.structured.quality.freshness, 'stale')
    assert.deepEqual(read.structured.quality.reasons, ['candidate-changed'])
    f.setCandidate({ candidateHash: hash('a'), baseHash: hash('d') })
    assert.equal((await f.attach()).structured.reasons.includes('base-changed'), true)
    f.setCandidate({ baseHash: null })
    await f.attach({ currentInstalledHash: null })
    assert.equal(
      (await f.invoke('skill_quality_candidate', { action: 'read', candidateId: id })).structured.quality
        .freshness,
      'unknown',
    )
  })
  test('rejects forged human/test authority, zero execution, duplicates and invalid or oversized evidence before candidate access', async () => {
    const f = fixture()
    const mutations = [
      (v) => {
        v.reviewer = 'owner'
      },
      (v) => {
        v.tests = { state: 'passed' }
      },
      (v) => {
        v.cases[0].executed = 0
      },
      (v) => {
        v.cases = []
      },
      (v) => {
        v.cases.forEach((row) => {
          row.status = 'skipped'
          row.executed = 0
        })
      },
      (v) => {
        v.cases[1].id = v.cases[0].id
      },
      (v) => {
        v.environment.model = 'secret'
      },
      (v) => {
        v.candidateHash = 'invalid'
      },
      (v) => {
        v.cases[1].actual = 'x'.repeat(50000)
      },
    ]
    for (const mutate of mutations) {
      const value = imported()
      mutate(value)
      assert.throws(() => parseEvidence(JSON.stringify(value)))
      assert.equal((await f.attach({ evidenceJson: JSON.stringify(value) })).isError, true)
    }
    assert.equal((await f.attach({ evidenceJson: '{bad' })).isError, true)
    assert.equal(f.requests.length, 0)
    assert.equal(f.store.size, 0)
  })
  test('Host test failure/rejected submit cannot publish or enable; cancellation/refusal leaves earlier evidence intact', async () => {
    const f = fixture()
    await f.attach()
    f.setCandidate({ state: 'rejected' })
    const denied = await f.invoke('skill_quality_candidate', {
      action: 'submit',
      candidateId: id,
      expectedHash: hash('a'),
    })
    assert.equal(denied.isError, true)
    assert.equal(f.getCandidate().state, 'rejected')
    assert.equal(
      (await f.invoke('skill_quality_candidate', { action: 'approve', candidateId: id })).isError,
      true,
    )
    f.setCandidate({
      state: 'failed',
      tests: { hash: hash('a'), state: 'failed', count: 1, runner: 'node-test' },
    })
    assert.equal(
      (await f.invoke('skill_quality_candidate', { action: 'read', candidateId: id })).structured.candidate
        .hostTests.state,
      'failed',
    )
    f.ctx.pluginManage.request = async () => {
      throw new Error('/private/secret/path')
    }
    const before = structuredClone([...f.store])
    const failed = await f.invoke('skill_quality_candidate', { action: 'read', candidateId: id })
    assert.equal(failed.isError, true)
    assert.equal(JSON.stringify(failed).includes('/private'), false)
    f.controller.abort(new Error('Stopped'))
    await assert.rejects(f.attach(), /Stopped/)
    assert.deepEqual([...f.store], before)
    assert.equal(
      f.requests.some((row) => /approve|install|enable/.test(row.action)),
      false,
    )
  })
  test('query requires read authorization for the exact selected session and survives reopening without leaking another session', async () => {
    const f = fixture()
    await f.attach()
    const requested = []
    const ctx = {
      store: f.ctx.store,
      signal: f.ctx.signal,
      sessionAccess: {
        async requireRead(sessionId) {
          requested.push(sessionId)
          if (sessionId !== 'session-a') throw new Error('denied')
        },
      },
    }
    assert.equal((await qualityReadService.handler({ sessionId: 'session-a' }, ctx)).records.length, 1)
    await assert.rejects(qualityReadService.handler({ sessionId: 'session-b' }, ctx), /denied/)
    assert.deepEqual(requested, ['session-a', 'session-b'])
    await assert.rejects(
      qualityReadService.handler({ sessionId: 'session-a' }, { ...ctx, sessionAccess: undefined }),
      /UNAVAILABLE/,
    )
    const p = projection('plugin/quality')
    let state = emptyState()
    for (const event of f.events)
      state = p.apply(state, {
        type: `x/plugin/quality/${event.name}`,
        origin: 'ext:plugin/quality',
        data: event.data,
      })
    assert.equal(
      p.view(state).records[0].importedDigest,
      (await qualityReadService.handler({ sessionId: 'session-a' }, ctx)).records[0].importedDigest,
    )
    assert.deepEqual(
      p.apply(state, { type: 'x/plugin/quality/quality.recorded', origin: 'ext:other', data: null }),
      state,
    )
    assert.equal(candidateReceipt(f.getCandidate()).candidateId, id)
    assert.equal(qualityView(state.records[0]).verified, false)
  })
  test('workflow submits only after actual Host test success and confirmation; failure never advances to submission', async () => {
    for (const [pass, choice] of [
      [true, 'Proceed'],
      [false, 'Proceed'],
      [true, 'Cancel'],
    ]) {
      const f = fixture()
      const calls = []
      const tools = {
        async execute(call) {
          calls.push(call.args?.action ?? call.name)
          if (call.args?.action === 'test' && !pass)
            return { isError: true, content: [{ type: 'text', text: 'synthetic test failed' }] }
          return f.invoke(call.name, call.args)
        },
        async batch() {
          throw new Error('No batch')
        },
      }
      const decisions = scriptedDecisions()
      const port = {
        ...decisions.port,
        async request(spec) {
          const handle = await decisions.port.request(spec)
          decisions.answer(spec.key, choice)
          return handle
        },
      }
      let result = await driveLoop(qualityWorkflow.createFactory({ candidateId: id }), {
        inputs: [{ content: [{ type: 'text', text: 'Review synthetic candidate' }] }],
        tools,
        decisions: port,
        replies: Array.from({ length: 4 }, () => [
          { type: 'text_delta', delta: 'Synthetic fixed step.' },
          { type: 'done', reason: 'stop' },
        ]),
        maxSteps: 30,
      })
      assert.equal(calls.includes('submit'), false)
      if (pass) {
        assert.equal(result.steps.at(-1).outcome, 'parked')
        result = await driveLoop(qualityWorkflow.createFactory({ candidateId: id }), {
          checkpoint: result.checkpoint,
          turnOpen: true,
          tools,
          decisions: port,
          replies: [
            [
              { type: 'text_delta', delta: 'Synthetic confirmed submit.' },
              { type: 'done', reason: 'stop' },
            ],
          ],
          maxSteps: 30,
        })
        assert.equal(calls.includes('submit'), choice === 'Proceed')
        assert.equal(result.finished[0], choice === 'Proceed' ? 'completed' : 'error')
      } else {
        assert.equal(result.finished[0], 'error')
      }
    }
  })
  test('imported passing scores cannot override durable human rejection or a failing upgrade runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-quality-offline-'))
    const profile = join(root, 'profiles', 'test')
    mkdirSync(profile, { recursive: true })
    writeLock(profile, {
      ...emptyLock('test', '0.0.0'),
      resolvedProfileHash: hash('0'),
      policySnapshot: { capabilityCeiling: [], workspacePackages: 'require-project-trust' },
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((key) => [
          key,
          { provider: 'local' },
        ]),
      ),
    })
    const manager = createPackageManager({
      dataDir: join(root, 'data'),
      agnesVersion: '0.0.0',
      references: async () => [],
    })
    let pass = true,
      command = 0
    const candidates = new AuthoringCandidates(manager, async () => ({
      state: pass ? 'passed' : 'failed',
      count: 1,
      runner: 'node-test',
      output: 'offline fake runner',
    }))
    const origin = {
      sessionKey: 'session-a',
      toolUseId: 'fixture',
      turn: 1,
      packageId: '@agnes/skill-quality',
      snapshotId: 'synthetic',
      rowId: 'ext:skill-quality/main',
    }
    const files = (revision) => [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'quality-synthetic-skill',
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          agnes: {
            kinds: ['skills'],
            contributions: [
              { kind: 'skill', id: 'quality-synthetic-skill/main', path: './skills/review/SKILL.md' },
            ],
          },
        }),
      },
      {
        path: 'skills/review/SKILL.md',
        content: `---\nname: review\ndescription: Synthetic offline review\n---\nRevision ${revision}`,
      },
      { path: 'test/skill.test.mjs', content: '// synthetic external runner fixture' },
    ]
    const f = fixture()
    f.ctx.pluginManage.request = async (request) => {
      const args = [profile, request.candidateId, 'owner']
      switch (request.action) {
        case 'candidate.create':
          return candidates.create(profile, request.files, 'owner', `create-${++command}`, origin)
        case 'candidate.show':
          return candidates.show(...args)
        case 'candidate.test':
          return candidates.test(...args, request.expectedHash, f.ctx.signal)
        case 'candidate.submit':
          return candidates.submit(...args, request.expectedHash)
        default:
          throw new Error('Unsupported fixture operation')
      }
    }
    const invoke = (action, candidate) =>
      f.invoke('skill_quality_candidate', {
        action,
        candidateId: candidate.candidateId,
        expectedHash: candidate.candidateHash,
      })
    const draft = async (revision) =>
      (await f.invoke('skill_quality_candidate', { action: 'create', files: files(revision) })).structured
        .candidate
    try {
      let candidate = await draft('reject')
      await invoke('test', candidate)
      const review = (await invoke('submit', candidate)).structured.candidate
      const actual = candidates.show(profile, review.candidateId, 'owner')
      await candidates.decide(
        profile,
        actual.candidateId,
        'owner',
        actual.candidateHash,
        actual.reviewHash,
        false,
        async () => {
          throw new Error('Rejected candidate must not publish')
        },
      )
      const evidence = imported()
      evidence.candidateHash = actual.candidateHash
      evidence.cases = [evidence.cases[0]]
      const importedScore = await f.invoke('skill_quality_import', {
        candidateId: actual.candidateId,
        evidenceJson: JSON.stringify(evidence),
        currentInstalledHash: null,
      })
      assert.equal(importedScore.structured.counts.passed, 1)
      assert.equal(importedScore.structured.candidate.state, 'rejected')
      assert.equal((await invoke('submit', candidate)).isError, true)
      assert.equal((await manager.inventory(profile)).packages.length, 0)
      candidate = await draft('installed')
      await invoke('test', candidate)
      await invoke('submit', candidate)
      const approved = candidates.show(profile, candidate.candidateId, 'owner')
      await candidates.decide(
        profile,
        approved.candidateId,
        'owner',
        approved.candidateHash,
        approved.reviewHash,
        true,
        (source) => manager.install(profile, source, { expectedIntegrity: approved.candidateHash }),
      )
      const installed = (await manager.inventory(profile)).packages[0].entry.integrity
      candidate = await draft('broken-upgrade')
      pass = false
      assert.equal((await invoke('test', candidate)).isError, true)
      assert.equal((await invoke('submit', candidate)).isError, true)
      assert.equal((await manager.inventory(profile)).packages[0].entry.integrity, installed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('refuses owner-store quota overflow before appending evidence and preserves earlier records', async () => {
    const f = fixture()
    const evidence = imported()
    evidence.cases = Array.from({ length: 20 }, (_, index) => ({
      id: `case-${index}`,
      status: 'passed',
      executed: 1,
      expected: 'e'.repeat(900),
      actual: 'a'.repeat(900),
    }))
    assert.equal((await f.attach({ evidenceJson: JSON.stringify(evidence) })).isError, undefined)
    const before = structuredClone([...f.store])
    const candidateId = `candidate-${'2'.repeat(32)}`
    f.setCandidate({ candidateId })
    const output = await f.invoke('skill_quality_import', {
      candidateId,
      evidenceJson: JSON.stringify(evidence),
    })
    assert.equal(output.isError, true)
    assert.equal(f.events.length, 1)
    assert.deepEqual([...f.store], before)
  })
  test('backend registrations dispose cleanly', () => {
    const { name, inputEventTypes, maxStateBytes } = projection('plugin/test')
    assert.equal(validateProjectionCapability({ name, inputEventTypes, maxStateBytes }).ok, true)
    const registry = new Set()
    const register = (entry) => {
      registry.add(entry)
      return () => registry.delete(entry)
    }
    const stop = main.apply({
      services: { register },
      projections: { register },
      tools: { register },
      self: { extId: 'plugin/test' },
      eventLog: {},
    })
    assert.equal(registry.size, 4)
    stop()
    assert.equal(registry.size, 0)
  })
}
