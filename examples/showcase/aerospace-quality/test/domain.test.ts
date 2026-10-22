import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolContext } from '@agnes/extension-api'
import { createPluginTestHost } from '@agnes/host/author-testkit'
import { createTestHost } from '@agnes/host/testkit'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { sqlitePersistenceProvider } from '@agnes/host-infrastructure/adapters/storage-provider'
import { afterEach, expect, it } from 'vitest'
import { briefing } from '../src/briefing.js'
import { coverage, decide, draft, impact, investigate, persist, read } from '../src/domain.js'
import { main } from '../src/index.js'
import { report } from '../src/reports.js'
import { seed } from '../src/seed.js'
import { sign } from '../src/signature.js'

const packageDir = fileURLToPath(new URL('../', import.meta.url))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const skills = { register: () => () => {} }
it('Host tools and profile services share durable state; restart preserves drafts; stale, malformed and unauthorized decisions refuse', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'agh-aero-store-'))
  roots.push(storeDir)
  let host = await createPluginTestHost(main, {
    packageDir,
    storeDir,
    services: { skills },
    context: {
      skillInstall: {
        request: async () => {
          throw { message: 'SKILL_INSTALL_REJECTED' }
        },
      },
    },
  })
  try {
    const initial = (await host.invokeProfileService('aero.snapshot', {})) as any
    expect(initial.requirements).toHaveLength(39)
    const refusedInstall = await host.invoke('aero_skill_candidate', {
      action: 'status',
      proposalId: 'skill-install-synthetic',
    })
    expect(refusedInstall.isError).toBe(true)
    expect(JSON.stringify(refusedInstall.content)).toContain('SKILL_INSTALL_REJECTED')
    expect(initial.campaigns.flatMap((c: any) => c.samples).length).toBe(484)
    expect(initial.campaigns[4].samples).toEqual([])
    const diagnosis = await host.invoke('aero_investigate', { anomalyId: 'AN-027' })
    expect(diagnosis.isError).not.toBe(true)
    expect((diagnosis.structured as any).data.exceedances).toHaveLength(5)
    expect((diagnosis.structured as any).data.change.id).toBe('ECR-014')
    const proposed = await host.invoke('aero_mrb_draft', {
      ncrId: 'NCR-018',
      disposition: 'rework',
      rationale:
        'Reject L2609-B pending failure analysis; rework PVD-011/012/013 to the controlled drawing and re-verify.',
      expectedRevision: 1,
    })
    expect(proposed.isError, JSON.stringify(proposed)).not.toBe(true)
    const snapshot = (await host.invokeProfileService('aero.snapshot', {})) as any
    expect(snapshot.revision).toBe(2)
    expect(snapshot.ncrs.find((row: any) => row.id === 'NCR-018')).toMatchObject({
      status: 'review',
      disposition: 'rework',
      approvals: [],
      rationale:
        'Reject L2609-B pending failure analysis; rework PVD-011/012/013 to the controlled drawing and re-verify.',
    })
    expect(snapshot.anomaly.anomalyId).toBe('AN-027')
    expect(snapshot.anomaly.peakA).toBe(initial.anomaly.peakA)
    expect(
      (
        await host.invoke('aero_mrb_draft', {
          ncrId: 'NCR-018',
          disposition: 'scrap',
          rationale: 'A stale draft must not replace the already reviewed evidence.',
          expectedRevision: 1,
        })
      ).isError,
    ).toBe(true)
    expect(
      (await host.invoke('aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 2 })).isError,
    ).toBe(true)
    await expect(
      host.invokeProfileService('aero.decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 2 }),
    ).rejects.toThrow('Host human approval')
    await expect(
      host.invoke('aero_mrb_draft', {
        ncrId: 'NCR-018',
        disposition: 'launch',
        rationale: 'Invalid disposition should fail schema validation.',
        expectedRevision: 2,
      }),
    ).rejects.toThrow('Invalid arguments')
    await expect(host.invoke('aero_trace', { owner: 'another-profile' })).rejects.toThrow('Invalid arguments')
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    await expect(host.invoke('aero_trace', {}, cancelled.signal)).rejects.toThrow('cancelled')
    await host.dispose()
    host = await createPluginTestHost(main, { packageDir, storeDir, services: { skills } })
    expect(((await host.invokeProfileService('aero.snapshot', {})) as any).ncrs[17]).toEqual(
      snapshot.ncrs[17],
    )
    expect(((await host.invokeProfileService('aero.snapshot', {})) as any).audit).toHaveLength(1)
  } finally {
    await host.dispose()
  }
  expect(host.tools.size).toBe(0)
})
it('approved domain decisions hold hardware, invalidate verification, enforce double-five closure and use the reviewed rule on the next analysis', () => {
  const memory = new Map<string, any>()
  const store = {
    get: (k: string) => structuredClone(memory.get(k)),
    set: (k: string, v: any) => {
      memory.set(k, structuredClone(v))
    },
    delete: (k: string) => {
      memory.delete(k)
    },
    scan: () => ({ rows: [] }),
    transaction: <T>(work: () => T) => {
      const before = new Map(memory)
      try {
        return work()
      } catch (e) {
        memory.clear()
        for (const [k, v] of before) memory.set(k, v)
        throw e
      }
    },
  }
  for (const [disposition, status] of [
    ['use-as-is', 'concession-hold'],
    ['repair', 'repair-hold'],
    ['scrap', 'scrap-authorized'],
    ['return-to-supplier', 'return-authorized'],
  ] as const) {
    memory.clear()
    const fixture = seed()
    fixture.ncrs[17]!.status = 'review'
    fixture.ncrs[17]!.disposition = disposition
    fixture.ncrs[17]!.rationale = 'Reviewed disposition; implementation and release remain pending.'
    persist(store, fixture)
    decide(
      store,
      { kind: 'mrb', id: 'NCR-018', expectedRevision: 1 },
      {
        requestId: 'human-review',
        subjectRevision: 'synthetic',
        answeredBy: { id: 'human', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
      },
    )
    expect(read(store).parts[0]!.status).toBe(status)
  }
  memory.clear()
  const s = seed()
  s.ncrs[17]!.status = 'review'
  s.ncrs[17]!.disposition = 'rework'
  s.ncrs[17]!.rationale = 'Quarantine lot and restore original drawing; verify before release.'
  persist(store, s)
  const approved = {
    requestId: 'host-approval-synthetic',
    subjectRevision: 'synthetic',
    answeredBy: { id: 'human', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
  }
  expect(() => decide(store, { kind: 'zeroing', id: 'ZR-001', expectedRevision: 1 }, approved)).toThrow(
    'Double-five evidence incomplete',
  )
  expect(read(store).revision).toBe(1)
  decide(store, { kind: 'mrb', id: 'NCR-018', expectedRevision: 1 }, approved)
  expect(read(store).parts[0]!.status).toBe('rework-hold')
  expect(read(store).ncrs[17]!.status).toBe('dispositioned')
  expect(read(store).requirements.find((r) => r.id === 'CMP-003')!.verified).toBe(false)
  expect(read(store).requirements.find((r) => r.id === 'SYS-001')!.verified).toBe(false)
  expect(impact(read(store), 'ECR-016').requirements).not.toContain('SUB-006')
  const candidate = read(store)
  candidate.rule.status = 'review'
  persist(store, candidate)
  expect(impact(read(store), 'ECR-016').screeningRequired).toBe(false)
  decide(store, { kind: 'rule', id: 'TVAC-LOT-001', expectedRevision: 2 }, approved)
  expect(impact(read(store), 'ECR-016')).toMatchObject({ screeningRequired: true, ruleVersion: 1 })
  decide(store, { kind: 'configuration', id: 'ECR-016', expectedRevision: 3 }, approved)
  expect(read(store).tests.find((r) => r.id === 'VT-033')!.status).toBe('pending')
  expect(read(store).baselines[3]!.status).toBe('verification-hold')
  expect(read(store).audit.map((e) => e.approval)).toEqual([
    approved.requestId,
    approved.requestId,
    approved.requestId,
  ])
  expect(() =>
    decide(store, { kind: 'configuration', id: 'ECR-016', expectedRevision: 4 }, approved),
  ).toThrow('not under review')
  const complete = read(store)
  for (const criterion of complete.zeroing[0]!.criteria) {
    criterion.accepted = true
    criterion.evidence = [`SYNTHETIC-REVIEWED-${criterion.id}`]
  }
  persist(store, complete)
  const automatic = {
    ...approved,
    requestId: 'host-auto-closure',
    signedMeaning: 'I confirm the complete reviewed evidence and approve quality closure.',
    confirmationMode: 'auto-confirmed under full access',
  }
  expect(() => decide(store, { kind: 'zeroing', id: 'ZR-001', expectedRevision: 4 }, automatic)).toThrow(
    'Host human approval',
  )
  decide(
    store,
    { kind: 'zeroing', id: 'ZR-001', expectedRevision: 4 },
    {
      ...automatic,
      admission: { verify: async () => {}, assertActive() {} },
    },
  )
  expect(read(store).zeroing[0]).toMatchObject({
    status: 'closed',
    closure: {
      decisionId: 'host-auto-closure',
      signer: 'human',
      confirmationMode: 'auto-confirmed under full access',
      meaning: automatic.signedMeaning,
      reviewedRevision: 4,
    },
  })
  for (const locale of ['en', 'zh-CN'] as const) {
    const rendered = report(read(store), 'zeroing', locale)
    const auto =
      locale === 'en'
        ? 'Auto-confirmed under full access (principal human)'
        : '完全访问下自动确认（主体 human）'
    const manual = locale === 'en' ? 'Signed by human' : '已由真人签署: human'
    expect(rendered.markdown).toContain(auto)
    expect(rendered.html).toContain(auto)
    expect(rendered.markdown).toContain(manual) // MRB/configuration retain their own manual proofs.
    const unknown = read(store)
    for (const entry of unknown.audit) delete entry.confirmationMode
    unknown.zeroing[0]!.closure!.confirmationMode = 'unknown'
    const missing = report(unknown, 'zeroing', locale)
    expect(missing.markdown).toContain(
      locale === 'en' ? 'Confirmation mode not recorded (principal human)' : '确认方式未记录（主体 human）',
    )
    expect(missing.markdown).not.toContain(auto)
    expect(missing.markdown).not.toContain(manual)
  }
})
it('traceability exposes orphan/design/untested gaps and reports preserve uncertainty, evidence and safe HTML', () => {
  const s = seed(),
    rows = coverage(s)
  expect(rows.find((r) => r.id === 'CMP-032')!.orphan).toBe(true)
  expect(rows.find((r) => r.id === 'CMP-030')!.gap).toBe('untested')
  expect(rows.find((r) => r.id === 'CMP-031')!.gap).toBe('missing-design')
  expect(investigate(s).hypothesis.en).toContain('Hypothesis only')
  expect(investigate(s).units.pressure).toBe('Pa')
  expect(investigate(s).zeroingSummary[0]?.accepted).toEqual(expect.arrayContaining(['T1', 'M1', 'M2']))
  expect(investigate(s).zeroingSummary[0]?.accepted).toHaveLength(3)
  s.ncrs[17]!.rationale = '<script>alert(1)</script>'
  for (const locale of ['zh-CN', 'en'] as const) {
    const surface = briefing(s, locale)
    expect(surface.data.telemetry.every((point) => typeof point.minute === 'string')).toBe(true)
    expect(surface.data.telemetry.map((point) => point.current)).toContain(2.227)
    const r = report(s, 'zeroing', locale)
    expect(r.markdown).toContain('NCR-017')
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.markdown).toMatch(/草案|DRAFT/)
    expect(r.markdown).toContain('T5')
    expect(r.markdown).toContain('M5')
  }
})

it('retains manual signatures under standard/workspace-write and auto-confirms for the human under full access', async () => {
  const { createAuthorTestkit } = await import('@agnes/host/author-testkit')
  for (const base of ['standard', 'workspace-write', 'full-access']) {
    const ordinaryReviews: string[] = []
    const kit = await createAuthorTestkit({
      plugin: main,
      packageId: '@test/aerospace-signature',
      version: '1.0.0',
      capabilities: { store: true },
      preset: 'standard',
      permission: base === 'standard' ? 'default' : base,
      presets: {
        'permission-full-access': {
          name: 'permission-full-access',
          providers: { 'tool-policy': { provider: 'full-access' } },
        },
      },
      approval: async (request) => {
        ordinaryReviews.push(request.requestId)
        return {
          verdict: 'allowed-once',
          answeredBy: { id: 'human.permission', role: 'reviewer', org: 'test', deptPath: [], attrs: {} },
        }
      },
    })
    try {
      const s = await kit.openSession()
      if (base === 'full-access')
        expect((await s.facts()).find((event) => event.type === 'session/start')?.data).toMatchObject({
          permission: 'full-access',
        })
      const draft = await s.invoke('aero_mrb_draft', {
        ncrId: 'NCR-018',
        disposition: 'rework',
        rationale: 'Quarantine L2609-B; restore drawing and re-verify.',
        expectedRevision: 1,
      })
      expect(draft.isError).not.toBe(true)
      if (base === 'full-access') {
        const result = await s.invoke('aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 2 })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        expect(result.structured).toMatchObject({
          data: {
            signature: { signer: 'u', confirmationMode: 'auto-confirmed under full access' },
            audit: { signer: 'u', confirmationMode: 'auto-confirmed under full access' },
          },
        })
        expect((await s.invoke('aero_rule_propose', { expectedRevision: 3 })).isError).not.toBe(true)
        for (const [kind, id, expectedRevision] of [
          ['rule', 'TVAC-LOT-001', 4],
          ['configuration', 'ECR-016', 5],
        ] as const) {
          const signed = await s.invoke('aero_decide', { kind, id, expectedRevision })
          expect(signed.isError, JSON.stringify(signed)).not.toBe(true)
          expect(signed.structured).toMatchObject({
            data: { signature: { signer: 'u', confirmationMode: 'auto-confirmed under full access' } },
          })
        }
        // Full access cannot manufacture the seven missing closure evidence criteria.
        expect(
          (await s.invoke('aero_decide', { kind: 'zeroing', id: 'ZR-001', expectedRevision: 6 })).isError,
        ).toBe(true)
        const signatures = (await s.decisions()).filter((d) => d.request.spec.purpose === 'business.confirm')
        expect(signatures).toHaveLength(4)
        expect(
          signatures.every(
            (d) =>
              d.result?.reason === 'answered' &&
              d.result.code === 'full-access' &&
              d.result.response.value === d.request.spec.presentation?.en?.responseValue &&
              d.consumption,
          ),
        ).toBe(true)
        expect(ordinaryReviews).toEqual([])
        expect(signatures[0]).toMatchObject({
          result: { code: 'full-access', answeredBy: { id: 'u' } },
          consumption: { operationId: expect.any(String) },
        })
        continue
      }
      for (const [role, option, success, badValue] of [
        ['system', 'allowed-once', false, undefined],
        ['reviewer', 'rejected', false, undefined],
        ['reviewer', 'allowed-once', false, null],
        ['reviewer', 'allowed-once', false, 'altered signature meaning'],
        ['reviewer', 'allowed-once', true, undefined],
      ] as const) {
        const pending = s.invoke('aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 2 })
        let question: Awaited<ReturnType<typeof s.decisions>>[number] | undefined
        await expect
          .poll(async () => {
            question = (await s.decisions()).find(
              (value) =>
                value.request.spec.purpose === 'business.confirm' && !value.result && !value.invalidation,
            )
            return !!question
          })
          .toBe(true)
        const snapshot = question!
        expect(snapshot.request.spec.subject).toMatchObject({ input: expect.stringContaining('NCR-018') })
        const view = snapshot.request.spec.presentation?.['zh-CN']
        expect(view?.fields.find((f) => f.label === '签名含义')?.value).toBe(view?.responseValue)
        expect(view?.title).toBe('人工质量签署')
        if (badValue !== undefined) {
          await expect(
            s.answerDecision(
              {
                handle: snapshot.handle,
                revision: snapshot.revision,
                commandId: `invalid:${snapshot.handle.id}`,
                response: { option, value: badValue },
              },
              { id: 'signer.reviewer', role, org: 'test', deptPath: [], attrs: {} },
            ),
          ).rejects.toThrow('RESPONSE_SCHEMA')
        }
        await s.answerDecision(
          {
            handle: snapshot.handle,
            revision: snapshot.revision,
            commandId: `review:${snapshot.handle.id}`,
            response: {
              option: badValue === undefined ? option : 'rejected',
              value: snapshot.request.spec.presentation?.['zh-CN']?.responseValue ?? null,
            },
          },
          { id: `signer.${role}`, role, org: 'test', deptPath: [], attrs: {} },
        )
        const result = await pending
        expect(!result.isError, JSON.stringify(result)).toBe(success)
        const state = (await s.invoke('aero_quality', { view: 'dashboard' })).structured as {
          revision: number
        }
        expect(state.revision).toBe(success ? 3 : 2)
        if (success)
          expect(result.structured).toMatchObject({
            data: {
              signature: { meaning: view?.responseValue },
              audit: { signatureMeaning: view?.responseValue },
            },
          })
      }
      expect(ordinaryReviews.length > 0).toBe(base !== 'full-access')
    } finally {
      await kit.dispose()
    }
  }
})

it.each(['epoch', 'deadline'] as const)(
  'nested business transaction rolls back after inner success loses %s, including after SQLite reopen',
  async (loss) => {
    const home = await mkdtemp(join(tmpdir(), 'agh-aerospace-quality-nested-'))
    const dbDir = join(home, 'business')
    await mkdir(dbDir)
    const { host } = await createTestHost({
      dataDir: home,
      allowed: ['standard', 'nested-review'],
      presets: {
        'nested-review': { name: 'nested-review', extends: 'standard', approval: { pending_ttl_ms: 1000 } },
        'permission-full-access': {
          name: 'permission-full-access',
          providers: { 'tool-policy': { provider: 'full-access' } },
        },
      },
    })
    let persistence = await sqlitePersistenceProvider.open({ dataDir: dbDir })
    const storeOf = () => {
      if (!persistence.metadata) throw new Error('Missing SQLite fixture metadata')
      return ownedStore(
        persistence.metadata.namespace('@fixture/aerospace-quality-nested', 'quality'),
        () => {},
        true,
      )
    }
    try {
      const store = storeOf()
      draft(store, {
        ncrId: 'NCR-018',
        disposition: 'rework',
        rationale: 'Synthetic reviewed rework pending verification.',
        expectedRevision: 1,
      })
      const before = read(store)
      const session = await host.createSession({
        cwd: home,
        preset: 'nested-review',
        permission: 'full-access',
      })
      let now = Date.now()
      Object.assign(session.d, { clock: () => now })
      const decisions = session.decisions.port({
        owner: '@fixture/aerospace-quality-nested',
        sourcePackage: '@fixture/aerospace-quality-nested',
        packageVersion: '1',
        operationId: 'signed-write',
        alive() {},
      })
      const input = { kind: 'mrb' as const, id: 'NCR-018', expectedRevision: 2 }
      const approval = await sign(
        {
          signal: new AbortController().signal,
          session: { key: session.key, toolUseId: 'signed-write' },
          decisions,
        } as unknown as ToolContext,
        { ...input, record: before.ncrs.find((row) => row.id === input.id) },
        {
          en: 'I approve this MRB disposition for implementation; hardware remains on hold pending verification.',
          'zh-CN': '我批准实施本 MRB 处置；硬件保持隔离，等待复验。',
        },
        input.id,
      )
      const admission = approval.admission
      if (!admission) throw new Error('Missing real Core signature admission')
      const proof = (await session.decisions.list()).find((row) => row.handle.id === approval.requestId)
      if (!proof?.request.expiresAt) throw new Error('Missing business deadline')
      const expiresAt = proof.request.expiresAt
      expect(proof.result).toMatchObject({ code: 'full-access', answeredBy: { id: session.d.actor.id } })
      expect(proof.consumption).not.toBeNull()
      expect(approval.confirmationMode).toBe('auto-confirmed under full access')
      let refused = false
      let innerSucceeded = false
      try {
        store.transaction(() => {
          decide(store, input, approval)
          expect(read(store).revision).toBe(before.revision + 1)
          innerSucceeded = true
          if (loss === 'epoch') session.revokeAutomaticPermissions()
          else now = Date.parse(expiresAt)
        })
      } catch {
        refused = true
      }
      expect(session.d.log.leaseRemainingMs()).toBeGreaterThan(0)
      await persistence.close()
      persistence = await sqlitePersistenceProvider.open({ dataDir: dbDir })
      const reopened = read(storeOf())
      expect.soft(innerSucceeded).toBe(true)
      expect.soft(refused).toBe(true)
      expect.soft(reopened.revision).toBe(before.revision)
      expect
        .soft(reopened.ncrs.find((row) => row.id === input.id))
        .toEqual(before.ncrs.find((row) => row.id === input.id))
      expect.soft(reopened.audit).toEqual(before.audit)
      // Root cleanup must leave subsequent admission-free transactions usable.
      const ordinary = storeOf()
      ordinary.transaction(() => ordinary.set('ordinary-after-rollback', true))
      expect(ordinary.get('ordinary-after-rollback')).toBe(true)
      expect(
        (await session.decisions.list()).find((row) => row.handle.id === approval.requestId)?.consumption,
      ).not.toBeNull()
    } finally {
      await persistence.close()
      await host.close()
      await rm(home, { recursive: true, force: true })
    }
  },
)
