import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuthorTestkit, createPluginTestHost } from '@agnes/host/author-testkit'
import { expect, it } from 'vitest'
import { main } from '../src/index.js'
import { type Plant, SIGNATURE_MEANING } from '../src/model.js'
import { qualityPolicy } from '../src/policy.js'
import { dossier, emStatus, findings, investigation } from '../src/quality.js'
import { report } from '../src/reports.js'
import { seed } from '../src/seed.js'

const packageDir = fileURLToPath(new URL('../', import.meta.url)),
  batch = 'B-2410-017'
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
  ).toMatchObject({ effect: 'ask', approval: { reviewerRequirement: 'human', grantConstraints: 'once' } })
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
  expect(emStatus(p, { ...evidence.em[0]!, viable: 50 })).toBe('control')
  expect(dossier(p, 'B-2410-021').rows.find((r) => r.key === 'em')?.pass).toBe(false)
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
  }
})
it('shares service/tool state, persists across Host restart, and refuses missing proof, stale writes and cancellation', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'agh-pharma-store-'))
  const fixtureOptions = {
    packageDir,
    storeDir,
    services: { skills: { register: () => () => {} }, providers: { register: () => () => {} } },
    context: {
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
  for (const verdict of ['rejected', 'allowed-once'] as const) {
    const kit = await createAuthorTestkit({
      plugin: main,
      packageId: '@test/quality-application',
      version: '1.0.0',
      capabilities: { store: true },
      preset: 'qa',
      presets: {
        qa: {
          name: 'qa',
          extends: 'standard',
          providers: { 'tool-policy': { provider: 'sableleaf-quality' } },
        },
      },
      approval: async () => ({
        verdict,
        answeredBy: { id: 'human.qa', org: 'test', role: 'reviewer', deptPath: [], attrs: {} },
      }),
    })
    try {
      const s = await kit.openSession()
      const blocked = await s.invoke('pharma_release', {
        batch,
        expectedRevision: 0,
        meaning: SIGNATURE_MEANING,
      })
      expect(blocked.isError).toBe(true)
      await s.assertApproval(verdict)
      if (verdict === 'rejected') {
        await s.assertRefused('pharma_release')
        expect(await s.effects()).toEqual([])
        continue
      }
      let revision = 0
      for (const action of ['investigate', 'advance', 'advance', 'advance', 'review'] as const) {
        const changed = await s.invoke('pharma_record', {
          action,
          batch,
          expectedRevision: revision,
          ...(action === 'advance'
            ? {
                evidence: `SIM-EV-${revision}: reviewed synthetic calibration, reprocessing, cleaning and three-batch evidence`,
              }
            : {}),
        })
        expect(changed.isError, JSON.stringify(changed)).not.toBe(true)
        revision++
      }
      const ready = await s.invoke('pharma_dossier', { batch })
      expect(ready.structured).toMatchObject({ ready: true, revision: 5 })
      expect(ready.structured).toMatchObject({
        blockers: [],
        findings: expect.arrayContaining([expect.objectContaining({ code: 'CPP' })]),
        evidence: {
          deviations: expect.arrayContaining([expect.objectContaining({ stage: 'closed' })]),
          retests: expect.arrayContaining([expect.objectContaining({ value: 1.9 })]),
          equipment: expect.arrayContaining([
            expect.objectContaining({ id: 'DR-02', qualification: 'qualified' }),
          ]),
          em: expect.arrayContaining([expect.objectContaining({ disposition: 'assessed' })]),
        },
      })
      const stale = await s.invoke('pharma_release', {
        batch,
        expectedRevision: 4,
        meaning: SIGNATURE_MEANING,
      })
      expect(stale.isError).toBe(true)
      const wrong = await s.invoke('pharma_release', { batch, expectedRevision: 5, meaning: 'approve' })
      expect(wrong.isError).toBe(true)
      const released = await s.invoke('pharma_release', {
        batch,
        expectedRevision: 5,
        meaning: SIGNATURE_MEANING,
      })
      expect(released.isError, JSON.stringify(released)).not.toBe(true)
      expect(released.structured).toMatchObject({
        revision: 6,
        dossier: { certificate: { signer: 'human.qa', dossierRevision: 5, meaning: SIGNATURE_MEANING } },
      })
      expect((await s.invoke('pharma_inspect', { batch })).structured).toMatchObject({
        findings: expect.arrayContaining([
          expect.objectContaining({
            code: 'CPP',
            text: expect.objectContaining({ en: expect.stringContaining('3.4') }),
          }),
        ]),
      })
      expect(
        (await s.invoke('pharma_release', { batch, expectedRevision: 6, meaning: SIGNATURE_MEANING }))
          .isError,
      ).toBe(true)
      await s.assertApproval('allowed-once')
      expect((await s.facts()).some((e) => e.type === 'decision/state')).toBe(true)
    } finally {
      await kit.dispose()
    }
  }
}, 60000)
