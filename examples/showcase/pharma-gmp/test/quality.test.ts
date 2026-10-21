import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolContext } from '@agnes/extension-api'
import { createAuthorTestkit, createPluginTestHost } from '@agnes/host/author-testkit'
import { createTestHost } from '@agnes/host/testkit'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { sqlitePersistenceProvider } from '@agnes/host-infrastructure/adapters/storage-provider'
import { expect, it } from 'vitest'
import { main } from '../src/index.js'
import { type Plant, SIGNATURE_MEANING } from '../src/model.js'
import { qualityPolicy } from '../src/policy.js'
import { dashboard, dossier, emStatus, findings, investigation } from '../src/quality.js'
import { change, read } from '../src/records.js'
import { report } from '../src/reports.js'
import { seed } from '../src/seed.js'
import { sign } from '../src/signature.js'

const packageDir = fileURLToPath(new URL('../', import.meta.url)),
  batch = 'B-2410-017'
it('review-role: the real pharma record and profile service cannot write using a role child decision port', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-role-pharma-'))
  const { host } = await createTestHost({ dataDir: home, disableSessionTitle: true })
  let plugin: Awaited<ReturnType<typeof createPluginTestHost>> | undefined
  try {
    const parent = await host.createSession({ key: 'parent', cwd: home })
    await parent.setYolo(true, parent.d.actor)
    const workspace = parent.commandSandboxPolicy?.()
    if (!workspace) throw new Error('fixture lacks workspace policy')
    const child = await host.createSession({
      key: 'child',
      cwd: home,
      roleDelegation: {
        role: { ref: '@fixture/pharma#reviewer', title: { en: 'Reviewer' } },
        parentKey: parent.key,
        actor: parent.d.actor,
        permission: 'workspace-write',
        tools: [],
        approvalPolicy: 'never',
        parentPolicy: 'default',
        generationLimit: 1,
        maxFanOut: 1,
        sandboxRequired: false,
        filesystem: workspace.policy,
      },
    })
    await child.setYolo(true, child.d.actor)
    await mkdir(join(home, 'domain-store'))
    plugin = await createPluginTestHost(main, {
      packageDir,
      storeDir: join(home, 'domain-store'),
      services: { skills: { register: () => () => {} }, providers: { register: () => () => {} } },
      context: { decisions: child.decisions.port(child.loopDecisionSource()) },
    })
    const before = await plugin.invokeProfileService('pharma.snapshot', {})
    const args = { action: 'investigate', batch, expectedRevision: 0 }
    const outcome = await plugin.invoke('pharma_record', args)
    expect(outcome.isError).toBe(true)
    expect(JSON.stringify(outcome)).toContain('hand this action back')
    await expect(plugin.invokeProfileService('pharma.change', args)).rejects.toThrow('approval proof')
    expect(await plugin.invokeProfileService('pharma.snapshot', {})).toEqual(before)
    expect((await child.decisions.list()).map((row) => row.result)).toEqual([
      expect.objectContaining({ reason: 'unavailable', code: 'delegated-approval-refused' }),
    ])
  } finally {
    await plugin?.dispose()
    await host.close()
    await rm(home, { recursive: true, force: true })
  }
})
it('models original OOS, independent signatures, alert-vs-action and retrospective equipment risk', async () => {
  for (const [args, effect] of [
    [{ kind: 'em', locale: 'zh-CN' }, 'allow'],
    [{ kind: 'dossier', locale: 'en' }, 'ask'],
    [{ kind: 'em', locale: 'en', batch: 'B-2410-017' }, 'ask'],
  ] as const)
    expect(
      await qualityPolicy.decide(
        {
          sessionKey: 'nightly',
          workspaceRoot: '/synthetic',
          cwd: '/synthetic',
          actor: { id: 'job:nightly', org: 'test', role: 'system', deptPath: [], attrs: {} },
          call: { id: 'nightly', name: 'pharma_report', args },
          policy: {
            isReadOnly: false,
            isDestructive: false,
            replay: 'never',
            requiresApproval: 'never',
            approvalScopes: [],
          },
          tainted: true,
          fullAccess: false,
          approvalMode: 'manual',
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ effect })
  expect(
    await qualityPolicy.decide(
      {
        sessionKey: 'test',
        workspaceRoot: '/synthetic',
        cwd: '/synthetic',
        actor: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
        call: { id: 'test', name: 'pharma_release', args: { expectedRevision: 0 } },
        policy: {
          isReadOnly: false,
          isDestructive: true,
          replay: 'never',
          requiresApproval: 'always',
          approvalScopes: [],
        },
        tainted: false,
        fullAccess: true,
        approvalMode: 'off',
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ effect: 'allow' })
  const p = seed(),
    evidence = investigation(p, batch)
  expect(p.batches).toHaveLength(36)
  expect(p.samples).toHaveLength(240)
  for (const d of p.deviations) {
    expect(d.opened >= p.batches.find((b) => b.id === d.batch)!.date).toBe(true)
    expect(d.actions.every((a) => a.due >= d.opened.slice(0, 10))).toBe(true)
  }
  expect(evidence.relatedBatches).toEqual(['B-2410-016', 'B-2410-018'])
  expect(evidence.findings.some((f) => f.code === 'CPP' && f.text.en.includes('3.4'))).toBe(true)
  expect(evidence.em.every((s) => emStatus(p, s) === 'alert')).toBe(true)
  expect(emStatus(p, { ...evidence.em[0]!, viable: 101 })).toBe('action')
  const actionEvent = p.samples.filter(
    (sample) => sample.room === 'C-201' && sample.at.startsWith('2024-10-19'),
  )
  expect(
    actionEvent.every(
      (sample) => sample.viable === 121 && sample.batch === 'B-2410-019' && emStatus(p, sample) === 'action',
    ),
  ).toBe(true)
  expect(emStatus(p, { ...evidence.em[0]!, viable: 50 })).toBe('control')
  expect(dossier(p, 'B-2410-021').rows.find((r) => r.key === 'em')?.pass).toBe(false)
  const initialRft = dashboard(p).rft
  const dryer = p.equipment.find((item) => item.id === 'DR-02')!
  dryer.qualification = 'qualified'
  dryer.calibrated = '2024-10-20'
  dryer.due = '2025-04-20'
  dryer.evidence.push(...['B-2410-016', batch, 'B-2410-018'].map((id) => `RETROSPECTIVE:${id}:SIM-IMPACT`))
  expect(dashboard(p).rft).toBe(initialRft)
  const b = p.batches.find((b) => b.id === batch)!
  expect(b.steps[0]!.cpp[0]!.value).toBe(0.12)
  b.steps[0]!.verifier = { ...b.steps[0]!.operator }
  expect(findings(p, batch).some((f) => f.code === 'ALCOA')).toBe(true)
  b.qc[0]!.value = 94
  expect(dossier(p, batch).rows.find((r) => r.key === 'qc')?.pass).toBe(false)
  for (const kind of ['apqr', 'deviations', 'em', 'dossier'] as const) {
    const document = report(p, kind, batch, 'en')
    expect(document.markdown).toContain('Synthetic')
    expect(document.html).toContain('@media print')
    expect(document.html).not.toContain('<pre>')
    expect(document.html).toContain('<table>')
    expect(document.html).not.toContain('|---|')
  }
  p.deviations[0]!.cause = '<script>unsafe()</script>'
  const safe = report(p, 'dossier', batch, 'zh-CN').html
  expect(safe).not.toContain('<script>')
  expect(safe).toContain('&lt;script&gt;unsafe()&lt;/script&gt;')
  const certificate = p.batches.find((row) => row.certificate)?.certificate
  if (!certificate) throw new Error('Missing synthetic certificate')
  b.certificate = { ...certificate, signer: 'release.principal' }
  p.audit.push({ ...p.audit[0]!, record: batch, actor: 'record.principal', approval: 'record-proof' })
  for (const mode of ['manual', 'auto-confirmed under full access', undefined, 'unknown']) {
    if (mode === undefined) {
      delete b.certificate.confirmationMode
      delete p.audit.at(-1)!.confirmationMode
    } else {
      b.certificate.confirmationMode = mode
      p.audit.at(-1)!.confirmationMode = mode
    }
    for (const locale of ['en', 'zh-CN'] as const) {
      const document = report(p, 'dossier', batch, locale)
      for (const principal of ['release.principal', 'record.principal']) {
        const label =
          mode === 'manual'
            ? locale === 'en'
              ? `Signed by ${principal}`
              : `已由真人签署: ${principal}`
            : mode === 'auto-confirmed under full access'
              ? locale === 'en'
                ? `Auto-confirmed under full access (principal ${principal})`
                : `完全访问下自动确认（主体 ${principal}）`
              : locale === 'en'
                ? `Confirmation mode not recorded (principal ${principal})`
                : `确认方式未记录（主体 ${principal}）`
        expect(document.markdown).toContain(label)
        expect(document.html).toContain(label)
        if (mode !== 'manual') expect(document.markdown).not.toContain(`Signed by ${principal}`)
        if (mode !== 'manual') expect(document.markdown).not.toContain(`已由真人签署: ${principal}`)
      }
    }
  }
})
it('shares service/tool state, persists across Host restart, and refuses missing proof, stale writes and cancellation', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'agh-pharma-store-'))
  const fixtureOptions = {
    packageDir,
    storeDir,
    services: { skills: { register: () => () => {} }, providers: { register: () => () => {} } },
    context: {
      decisions: {
        request: async () => ({ id: 'fixture-human-approval', sessionId: 'test' }),
        wait: async () => ({
          status: 'resolved' as const,
          snapshot: {
            result: {
              reason: 'answered',
              at: '2026-10-20T00:00:00Z',
              response: { option: 'allowed-once', value: '我确认本合成质量记录。' },
              answeredBy: { id: 'fixture-human', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
            },
          },
        }),
      } as unknown as import('@agnes/extension-api').DecisionPort,
      approval: {
        requestId: 'fixture-human-approval',
        subjectRevision: 'fixture-revision',
        answeredBy: { id: 'fixture-human', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
      },
    },
  }
  let host = await createPluginTestHost(main, fixtureOptions)
  try {
    const initial = (await host.invokeProfileService('pharma.snapshot', {})) as { plant: Plant }
    expect(initial.plant.revision).toBe(0)
    const args = { action: 'investigate', batch, expectedRevision: 0 }
    const changed = (await host.invoke('pharma_record', args)).structured as { revision: number }
    expect(changed.revision).toBe(1)
    const inspected = await host.invoke('pharma_inspect', { batch })
    expect(inspected.isError).not.toBe(true)
    const state = (await host.invokeProfileService('pharma.snapshot', {})) as { plant: Plant }
    expect(state.plant.deviations[0]!.stage).toBe('investigation')
    expect(state.plant.audit.at(-1)!.approval).toBe('fixture-human-approval')
    expect(state.plant.audit.at(-1)?.signatureMeaning).toBe('我确认本合成质量记录。')
    await expect(host.invokeProfileService('pharma.change', args)).rejects.toThrow('approval proof')
    expect((await host.invoke('pharma_record', args)).isError).toBe(true)
    expect(
      (await host.invoke('pharma_release', { batch, expectedRevision: 1, meaning: SIGNATURE_MEANING }))
        .isError,
    ).toBe(true)
    await expect(
      host.invokeProfileService('pharma.release', { batch, expectedRevision: 1, meaning: SIGNATURE_MEANING }),
    ).rejects.toThrow('approval proof')
    await expect(host.invoke('pharma_inspect', { batch, owner: 'other' })).rejects.toThrow(
      'Invalid arguments',
    )
    const cancelled = new AbortController()
    cancelled.abort(new Error('Stop review'))
    await expect(host.invoke('pharma_inspect', { batch }, cancelled.signal)).rejects.toThrow('Stop review')
    await host.dispose()
    host = await createPluginTestHost(main, fixtureOptions)
    expect(await host.invokeProfileService('pharma.snapshot', {})).toEqual(state)
    expect((await host.invoke('pharma_dossier', { batch })).structured).toMatchObject({
      revision: 1,
      ready: false,
    })
  } finally {
    await host.dispose()
    await rm(storeDir, { recursive: true, force: true })
  }
  const unavailable = await createPluginTestHost(main, {
    packageDir,
    services: { skills: { register: () => () => {} }, providers: { register: () => () => {} } },
  })
  try {
    expect((await unavailable.invoke('pharma_inspect', { batch })).isError).toBe(true)
  } finally {
    await unavailable.dispose()
  }
})
it('requires real Core human approval; preserves original OOS through CAPA/retest and binds the certificate to the actual signer', async () => {
  for (const base of ['standard', 'workspace-write', 'full-access'])
    for (const verdict of (base === 'full-access' ? ['allowed-once'] : ['rejected', 'allowed-once']) as (
      | 'rejected'
      | 'allowed-once'
    )[]) {
      const ordinaryReviews: string[] = []
      const kit = await createAuthorTestkit({
        plugin: main,
        packageId: '@test/quality-application',
        version: '1.0.0',
        capabilities: { store: true },
        preset: base,
        presets: {
          'workspace-write': { name: 'workspace-write', extends: 'standard' },
          'full-access': {
            name: 'full-access',
            extends: 'standard',
          },
          'permission-full-access': {
            name: 'permission-full-access',
            providers: { 'tool-policy': { provider: 'full-access' } },
          },
        },
        approval: async (request) => {
          ordinaryReviews.push(request.requestId)
          return {
            verdict: 'allowed-once',
            answeredBy: { id: 'human.qa', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
          }
        },
      })
      try {
        const s = await kit.openSession()
        if (base === 'full-access')
          expect((await s.facts()).find((event) => event.type === 'session/start')?.data).toMatchObject({
            permission: 'full-access',
          })
        const invoke: typeof s.invoke = async (name, args, signal) => {
          const controller = new AbortController()
          const responding = (async () => {
            while (!controller.signal.aborted) {
              for (const snapshot of await s.decisions()) {
                if (
                  snapshot.request.spec.purpose !== 'business.confirm' ||
                  snapshot.result ||
                  snapshot.invalidation
                )
                  continue
                expect(base).not.toBe('full-access')
                expect(snapshot.request.spec.options).toEqual(['allowed-once', 'rejected'])
                const view = snapshot.request.spec.presentation?.['zh-CN']
                expect(view?.fields.find((f) => f.label === '签名含义')?.value).toBe(view?.responseValue)
                expect(view?.title).toBe('人工质量签署')
                await s.answerDecision(
                  {
                    handle: snapshot.handle,
                    revision: snapshot.revision,
                    commandId: `human:${snapshot.handle.id}`,
                    response: {
                      option: verdict,
                      value: snapshot.request.spec.presentation?.['zh-CN']?.responseValue ?? null,
                    },
                  },
                  { id: 'human.qa', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
                )
              }
              await new Promise((done) => setTimeout(done, 5))
            }
          })()
          try {
            return await s.invoke(name, args, signal)
          } finally {
            controller.abort()
            await responding
          }
        }
        const blocked = await invoke('pharma_release', {
          batch,
          expectedRevision: 0,
          meaning: SIGNATURE_MEANING,
        })
        expect(blocked.isError).toBe(true)
        expect(ordinaryReviews.length > 0).toBe(base !== 'full-access')
        if (verdict === 'rejected') {
          const refused = await invoke('pharma_record', { action: 'investigate', batch, expectedRevision: 0 })
          expect(refused.isError).toBe(true)
          expect((await invoke('pharma_dossier', { batch })).structured).toMatchObject({
            revision: 0,
            ready: false,
          })
          await s.assertApproval('rejected')
          continue
        }
        let revision = 0
        for (const action of ['investigate', 'advance', 'advance', 'advance', 'review'] as const) {
          const changed = await invoke('pharma_record', {
            action,
            batch,
            expectedRevision: revision,
            ...(action === 'advance'
              ? {
                  evidence:
                    revision === 1
                      ? 'SIM-CAL: reviewed as-found calibration; EM assessment still pending at this revision'
                      : `SIM-EV-${revision}: reviewed synthetic reprocessing, cleaning and three-batch evidence`,
                }
              : {}),
          })
          expect(changed.isError, JSON.stringify(changed)).not.toBe(true)
          expect(changed.structured).toMatchObject({
            signature: {
              signer: base === 'full-access' ? 'u' : 'human.qa',
              purpose: 'business.confirm',
              reviewedRevision: revision,
              confirmationMode: base === 'full-access' ? 'auto-confirmed under full access' : 'manual',
            },
          })
          revision++
        }
        const ready = await invoke('pharma_dossier', { batch })
        expect(ready.structured).toMatchObject({
          ready: true,
          revision: 5,
          signatureMeaning: SIGNATURE_MEANING,
          evidence: {
            recordApprovals: expect.arrayContaining([
              expect.objectContaining({
                action: 'review',
                reviewedRevision: 4,
                recordedBy: base === 'full-access' ? 'u' : 'human.qa',
                confirmationMode: base === 'full-access' ? 'auto-confirmed under full access' : 'manual',
              }),
            ]),
            deviations: expect.arrayContaining([
              expect.objectContaining({
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    id: 'CAPA-017-3',
                    evidence: expect.stringContaining('EM-ASSESSMENT:'),
                  }),
                ]),
              }),
            ]),
          },
        })
        expect(ready.structured).toMatchObject({
          blockers: [],
          findings: expect.arrayContaining([expect.objectContaining({ code: 'CPP' })]),
          evidence: {
            deviations: expect.arrayContaining([expect.objectContaining({ stage: 'closed' })]),
            retests: expect.arrayContaining([
              expect.objectContaining({ value: 1.9, at: '2024-10-20T12:00:00Z' }),
            ]),
            equipment: expect.arrayContaining([
              expect.objectContaining({
                id: 'DR-02',
                qualification: 'qualified',
                evidence: expect.arrayContaining([
                  expect.stringContaining('historical r1→r2'),
                  expect.stringContaining('SUBSEQUENT-EM-ASSESSMENT [r3]'),
                ]),
              }),
            ]),
            em: expect.arrayContaining([expect.objectContaining({ disposition: 'assessed' })]),
          },
        })
        const signedDossier = ready.structured as {
          evidence: { recordApprovals: unknown[]; deviations: { cause: string; why: string[] }[] }
        }
        expect(signedDossier.evidence.recordApprovals).toHaveLength(5)
        expect(signedDossier.evidence.deviations[0]?.cause).not.toContain('pending')
        expect(signedDossier.evidence.deviations[0]?.why.join(' ')).not.toContain('suspected')
        const stale = await invoke('pharma_release', {
          batch,
          expectedRevision: 4,
          meaning: SIGNATURE_MEANING,
        })
        expect(stale.isError).toBe(true)
        const wrong = await invoke('pharma_release', { batch, expectedRevision: 5, meaning: 'approve' })
        expect(wrong.isError).toBe(true)
        const released = await invoke('pharma_release', {
          batch,
          expectedRevision: 5,
          meaning: SIGNATURE_MEANING,
        })
        expect(released.isError, JSON.stringify(released)).not.toBe(true)
        expect(released.structured).toMatchObject({
          revision: 6,
          dossier: {
            certificate: {
              signer: base === 'full-access' ? 'u' : 'human.qa',
              confirmationMode: base === 'full-access' ? 'auto-confirmed under full access' : 'manual',
              dossierRevision: 5,
              meaning:
                base === 'full-access'
                  ? 'I approve this batch for release after reviewing the complete quality dossier.'
                  : '我已审核完整质量档案，批准本批放行。',
            },
          },
        })
        expect((await invoke('pharma_inspect', { batch })).structured).toMatchObject({
          findings: expect.arrayContaining([
            expect.objectContaining({
              code: 'CPP',
              text: expect.objectContaining({ en: expect.stringContaining('3.4') }),
            }),
          ]),
        })
        expect(
          (await invoke('pharma_release', { batch, expectedRevision: 6, meaning: SIGNATURE_MEANING }))
            .isError,
        ).toBe(true)
        await s.assertApproval('allowed-once')
        const signatures = (await s.decisions()).filter((d) => d.request.spec.purpose === 'business.confirm')
        expect(signatures).toHaveLength(6)
        expect(signatures.every((d) => d.consumption && !d.invalidation)).toBe(true)
        if (base === 'full-access')
          expect(
            signatures.every(
              (d) =>
                d.result?.reason === 'answered' &&
                d.result.code === 'full-access' &&
                d.result.answeredBy.role !== 'system',
            ),
          ).toBe(true)
        expect((await s.facts()).some((e) => e.type === 'decision/state')).toBe(true)
      } finally {
        await kit.dispose()
      }
    }
}, 60000)

it.each(['epoch', 'deadline'] as const)(
  'nested business transaction rolls back after inner success loses %s, including after SQLite reopen',
  async (loss) => {
    const home = await mkdtemp(join(tmpdir(), 'agh-pharma-gmp-nested-'))
    const dbDir = join(home, 'business')
    await mkdir(dbDir)
    const { host } = await createTestHost({
      dataDir: home,
      allowed: ['standard', 'full-access'],
      presets: {
        'full-access': { name: 'full-access', extends: 'standard', approval: { pending_ttl_ms: 1000 } },
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
        persistence.metadata.namespace('@fixture/pharma-gmp-nested', 'quality'),
        () => {},
        true,
      )
    }
    try {
      const store = storeOf()

      const before = read(store)
      const session = await host.createSession({ cwd: home, preset: 'full-access' })
      let now = Date.now()
      Object.assign(session.d, { clock: () => now })
      const decisions = session.decisions.port({
        owner: '@fixture/pharma-gmp-nested',
        sourcePackage: '@fixture/pharma-gmp-nested',
        packageVersion: '1',
        operationId: 'signed-write',
        alive() {},
      })
      const input = { action: 'investigate' as const, batch, expectedRevision: 0 }
      const approval = await sign(
        {
          signal: new AbortController().signal,
          session: { key: session.key, toolUseId: 'signed-write' },
          decisions,
        } as unknown as ToolContext,
        { ...input, currentDossier: dossier(before, batch) },
        { en: 'I attest to this synthetic quality record.', 'zh-CN': '我确认本合成质量记录。' },
        batch,
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
          change(store, input, {
            actor: approval.answeredBy.id,
            session: session.key,
            approval: { ...approval, admission },
          })
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
      expect.soft(reopened.deviations).toEqual(before.deviations)
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
