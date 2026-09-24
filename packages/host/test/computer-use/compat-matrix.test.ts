import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  evaluateComputerUseFixtureMatrix,
  fixtureMatrixSchema,
  inspectFixture,
  legacyCatalogFixtureSchema,
  legacyPermissionModeBehaviorFixtureSchema,
  lockedCatalogFixtureSchema,
  lockedDoctorFixtureSchema,
  lockedManifestFixtureSchema,
  lockedResultFixtureSchema,
  lockedSomFixtureSchema,
  readVerifiedFixture,
  semanticFixtureIssues,
  sha256,
} from './fixture-contract.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const matrixPath = join(root, 'packages/host/test/computer-use/fixtures/compatibility-matrix.json')
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as {
  entries: Array<
    | { id: string; contractEpoch: string; kind: string; status: 'missing'; blocker: string }
    | {
        id: string
        contractEpoch: string
        kind: string
        status: 'verified'
        fixturePath: string
        sha256: string
      }
  >
}

describe('computer-use locked fixture compatibility matrix', () => {
  it('is closed, unique, and truthful about captured and unavailable P0 fixtures', () => {
    expect(inspectFixture(fixtureMatrixSchema, matrix)).toEqual({ ok: true })
    expect(new Set(matrix.entries.map((entry) => entry.id)).size).toBe(matrix.entries.length)

    const locked = matrix.entries.filter((entry) => entry.contractEpoch === 'cua-driver-0.28.1')
    expect(locked.map((entry) => entry.kind).sort()).toEqual(
      ['catalog', 'doctor', 'manifest', 'result', 'som'].sort(),
    )
    expect(
      locked
        .filter((entry) => entry.status === 'verified')
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['catalog', 'doctor', 'manifest', 'result'].sort())
    expect(locked.filter((entry) => entry.status === 'missing')).toEqual([
      expect.objectContaining({ kind: 'som', blocker: expect.any(String) }),
    ])
  })

  it('keeps the P0 evidence gate closed while preserving verified legacy source evidence', () => {
    const decision = evaluateComputerUseFixtureMatrix(matrix, root)
    expect(decision.ready).toBe(false)
    expect(decision.verified).toEqual([
      'legacy-0.9-selected-catalog',
      'legacy-0.10-permission-mode-behavior',
      'locked-0.28.1-manifest',
      'locked-0.28.1-catalog',
      'locked-0.28.1-result',
      'locked-0.28.1-doctor',
    ])
    expect(decision.blockers).toHaveLength(1)
    expect(decision.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('fixture:locked-0.28.1-som:missing:')]),
    )
  })

  it.each([
    ['locked-0.28.1-manifest', lockedManifestFixtureSchema],
    ['locked-0.28.1-catalog', lockedCatalogFixtureSchema],
    ['locked-0.28.1-result', lockedResultFixtureSchema],
    ['locked-0.28.1-doctor', lockedDoctorFixtureSchema],
  ])('pins the sanitized Windows driver capture for %s', (id, schema) => {
    const entry = matrix.entries.find((item) => item.id === id)
    expect(entry?.status).toBe('verified')
    if (entry?.status !== 'verified') throw new Error(`${id} unexpectedly missing`)
    const fixture = readVerifiedFixture(root, entry.fixturePath, entry.sha256)
    expect(inspectFixture(schema, fixture)).toEqual({ ok: true })
    expect(semanticFixtureIssues(entry.kind, fixture)).toEqual([])
  })

  it('pins the exact sanitized Hermes 0.9 selected catalog by source commit and digest', () => {
    const entry = matrix.entries.find((item) => item.id === 'legacy-0.9-selected-catalog')
    expect(entry?.status).toBe('verified')
    if (entry?.status !== 'verified') throw new Error('legacy fixture unexpectedly missing')

    const fixture = readVerifiedFixture(root, entry.fixturePath, entry.sha256)
    expect(inspectFixture(legacyCatalogFixtureSchema, fixture)).toEqual({ ok: true })
    expect(semanticFixtureIssues(entry.kind, fixture)).toEqual([])
    expect(fixture).toMatchObject({
      format: 'normalized-selected-tools-list-v1',
      contract_epoch: 'cua-driver-0.9',
      observed_reported_version: '0.8.3',
      capability_version: '1',
      observed_tool_count: 49,
    })
    const tools = (fixture as { tools: Array<{ name: string; inputSchema: { properties: object } }> }).tools
    expect(tools).toHaveLength(12)
    expect(tools.find((tool) => tool.name === 'click')?.inputSchema.properties).toHaveProperty(
      'delivery_mode',
    )
    expect(tools.find((tool) => tool.name === 'type_text')?.inputSchema.properties).toHaveProperty(
      'delivery_mode',
    )
    expect(tools.find((tool) => tool.name === 'bring_to_front')?.inputSchema.properties).not.toHaveProperty(
      'delivery_mode',
    )
  })

  it('pins source-derived 0.10 permission behavior without representing driver or parser bytes', () => {
    const entry = matrix.entries.find((item) => item.id === 'legacy-0.10-permission-mode-behavior')
    expect(entry?.status).toBe('verified')
    if (entry?.status !== 'verified') throw new Error('legacy behavior fixture unexpectedly missing')

    const fixture = readVerifiedFixture(root, entry.fixturePath, entry.sha256)
    expect(inspectFixture(legacyPermissionModeBehaviorFixtureSchema, fixture)).toEqual({ ok: true })
    expect(semanticFixtureIssues(entry.kind, fixture)).toEqual([])
    expect(fixture).toEqual({
      format: 'normalized-hermes-permission-mode-behavior-v1',
      contract_epoch: 'cua-driver-0.10',
      evidence_kind: 'source-test-behavior',
      cases: [
        {
          id: 'ordinary-session',
          sessionApprovalBypass: false,
          gatewayApprovalBypass: false,
          expectedMode: 'standard',
        },
        {
          id: 'explicit-session-bypass',
          sessionApprovalBypass: true,
          gatewayApprovalBypass: false,
          expectedMode: 'unrestricted',
        },
        {
          id: 'gateway-session-key-bypass',
          sessionApprovalBypass: false,
          gatewayApprovalBypass: true,
          expectedMode: 'unrestricted',
        },
        {
          id: 'gateway-session-key-after-revoke',
          sessionApprovalBypass: false,
          gatewayApprovalBypass: false,
          expectedMode: 'standard',
        },
      ],
    })
  })

  it.each([
    ['manifest', lockedManifestFixtureSchema],
    ['catalog', lockedCatalogFixtureSchema],
    ['result', lockedResultFixtureSchema],
    ['som', lockedSomFixtureSchema],
    ['doctor', lockedDoctorFixtureSchema],
  ])('has a closed validator ready for a real %s capture', (_kind, schema) => {
    expect(inspectFixture(schema, {})).toMatchObject({ ok: false })
    expect(inspectFixture(schema, { unexpected: true })).toMatchObject({ ok: false })
  })

  it('rejects digest drift and repository escape before parsing fixture bytes', () => {
    const entry = matrix.entries.find((item) => item.id === 'legacy-0.9-selected-catalog')
    if (entry?.status !== 'verified') throw new Error('legacy fixture unexpectedly missing')
    expect(() => readVerifiedFixture(root, entry.fixturePath, '0'.repeat(64))).toThrow(
      'fixture digest mismatch',
    )
    expect(() => readVerifiedFixture(root, '../outside.json', entry.sha256)).toThrow(
      'fixture path escapes repository',
    )
  })

  it('rejects false completeness, duplicate tools/indexes, and sensitive captured state', () => {
    expect(
      semanticFixtureIssues('catalog', {
        observed_tool_count: 1,
        tools: [{ name: 'click' }, { name: 'click' }],
      }),
    ).toEqual([
      'fixture:catalog:duplicate-tool',
      'fixture:catalog:observed-count-underflow',
      'fixture:catalog:count-mismatch',
    ])
    expect(
      semanticFixtureIssues('som', {
        elements: [{ index: 1 }, { index: 1 }],
        leakedPath: '/Users/example/private.png',
      }),
    ).toEqual(expect.arrayContaining(['fixture:som:duplicate-index']))
    expect(semanticFixtureIssues('result', { authorization: 'Bearer secret' })).not.toEqual([])
    for (const captured of [
      { path: '/home/alice/private.txt' },
      { email: 'alice@corp.example' },
      { href: 'file:///home/alice/private.txt' },
      { accessToken: 'opaque' },
      { access_token: 'opaque' },
      { credential: 'opaque' },
      { session: 'opaque' },
    ])
      expect(semanticFixtureIssues('result', captured), JSON.stringify(captured)).not.toEqual([])
    expect(
      semanticFixtureIssues('result', {
        accessToken: '<redacted>',
        email: 'fixture@example.invalid',
      }),
    ).toEqual(['fixture:result:missing-structured-or-text-fallback'])
    expect(
      semanticFixtureIssues('result', {
        note: '/home/alice/private fixture@example.invalid',
      }),
    ).toEqual(expect.arrayContaining(['fixture:sensitive:posix-home:note', 'fixture:sensitive:email:note']))
    expect(
      semanticFixtureIssues('result', {
        endpoint: 'https://example.invalid/?accessToken=real-secret',
      }),
    ).toContain('fixture:sensitive:url:endpoint')
    expect(
      semanticFixtureIssues('result', {
        note: 'Bearer real-secret fixture@example.invalid',
      }),
    ).toEqual(
      expect.arrayContaining(['fixture:sensitive:credential-value:note', 'fixture:sensitive:email:note']),
    )
    expect(semanticFixtureIssues('result', { content: [{ type: 'image' }] })).toContain(
      'fixture:result:missing-structured-or-text-fallback',
    )
    expect(semanticFixtureIssues('doctor', { checks: [{ id: 'driver' }, { id: 'driver' }] })).toContain(
      'fixture:doctor:duplicate-check',
    )
  })

  it('does not accept a missing row with self-asserted fixture evidence', () => {
    const tampered = structuredClone(matrix) as { entries: Array<Record<string, unknown>> }
    const missing = tampered.entries.find((entry) => entry.status === 'missing')
    if (missing === undefined) throw new Error('expected a missing fixture row')
    missing.fixturePath = 'packages/host/test/computer-use/fixtures/fake.json'
    missing.sha256 = '0'.repeat(64)
    expect(inspectFixture(fixtureMatrixSchema, tampered)).toMatchObject({ ok: false })
  })

  it('fails closed on verified fixture digest drift', () => {
    const tampered = structuredClone(matrix) as {
      entries: Array<Record<string, unknown>>
    }
    const verified = tampered.entries.find((entry) => entry.id === 'legacy-0.9-selected-catalog')
    if (verified === undefined) throw new Error('expected a verified fixture row')
    verified.sha256 = '0'.repeat(64)
    const decision = evaluateComputerUseFixtureMatrix(tampered, root)
    expect(decision.ready).toBe(false)
    expect(decision.verified).not.toContain('legacy-0.9-selected-catalog')
    expect(decision.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('fixture digest mismatch')]),
    )
  })

  it('binds the legacy source fixture to its exact reviewed source identity', () => {
    const tampered = structuredClone(matrix) as { entries: Array<Record<string, unknown>> }
    const verified = tampered.entries.find((entry) => entry.id === 'legacy-0.9-selected-catalog')
    const provenance = verified?.provenance as Record<string, unknown> | undefined
    if (provenance === undefined) throw new Error('expected verified source provenance')
    provenance.commit = '0'.repeat(40)
    const decision = evaluateComputerUseFixtureMatrix(tampered, root)
    expect(decision.ready).toBe(false)
    expect(decision.verified).not.toContain('legacy-0.9-selected-catalog')
    expect(decision.blockers).toContain(
      'fixture:legacy-0.9-selected-catalog:provenance:source-identity-mismatch',
    )
  })

  it('rejects unknown ids, tuple aliases, and reused fixture/provenance identities', () => {
    const aliased = structuredClone(matrix) as { entries: Array<Record<string, unknown>> }
    const source = aliased.entries.find((entry) => entry.id === 'legacy-0.9-selected-catalog')
    if (source === undefined) throw new Error('expected legacy source')
    for (const entry of aliased.entries) {
      if (entry.status !== 'missing') continue
      delete entry.blocker
      Object.assign(entry, {
        status: 'verified',
        fixturePath: source.fixturePath,
        sha256: source.sha256,
        provenance: structuredClone(source.provenance),
      })
    }
    const legacyTen = aliased.entries[1]
    if (legacyTen === undefined) throw new Error('expected legacy 0.10 row')
    legacyTen.contractEpoch = 'cua-driver-0.9'
    aliased.entries.push({
      id: 'unknown-ready-alias',
      contractEpoch: 'cua-driver-0.9',
      kind: 'legacyCompatibility',
      status: 'missing',
      blocker: 'unknown rows never count toward readiness',
    })
    const decision = evaluateComputerUseFixtureMatrix(aliased, root)
    expect(decision.ready).toBe(false)
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        'matrix:tuple-mismatch:legacy-0.10-permission-mode-behavior',
        'matrix:unknown-id:unknown-ready-alias',
        expect.stringContaining('matrix:fixture-path-reused:'),
        expect.stringContaining('matrix:provenance-identity-reused:'),
        'fixture:locked-0.28.1-som:provenance:kind-mismatch',
      ]),
    )
  })

  it('does not permit 0.10 source behavior to impersonate a source fixture or driver capture', () => {
    const tampered = structuredClone(matrix) as { entries: Array<Record<string, unknown>> }
    const behavior = tampered.entries.find((entry) => entry.id === 'legacy-0.10-permission-mode-behavior')
    if (behavior === undefined) throw new Error('expected legacy behavior fixture')
    const provenance = behavior.provenance as Record<string, unknown> | undefined
    if (provenance === undefined) throw new Error('expected source behavior provenance')
    provenance.kind = 'source-fixture'

    const decision = evaluateComputerUseFixtureMatrix(tampered, root)
    expect(decision.ready).toBe(false)
    expect(decision.verified).not.toContain('legacy-0.10-permission-mode-behavior')
    expect(decision.blockers).toContain(
      'fixture:legacy-0.10-permission-mode-behavior:provenance:kind-mismatch',
    )
  })

  it('does not let a one-tool 0.28.1 catalog replace the captured names, count, or digest', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'agnes-cua-fixture-'))
    try {
      const fixturePath = 'packages/host/test/computer-use/fixtures/0.28.1/catalog.json'
      const absolutePath = join(temporaryRoot, fixturePath)
      mkdirSync(join(temporaryRoot, 'packages/host/test/computer-use/fixtures/0.28.1'), {
        recursive: true,
      })
      const oneTool = {
        format: 'normalized-tools-list-v1',
        source: {
          repository: 'https://github.com/trycua/cua',
          tag: 'cua-driver-rs-v0.28.1',
          commit: 'd8028a7943087ee258dc1b4d19dc12a7cd27669c',
        },
        capability_version: '1',
        observed_tool_count: 1,
        tools: [
          {
            name: 'self_asserted_tool',
            capabilities: [],
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      }
      const bytes = new TextEncoder().encode(JSON.stringify(oneTool))
      writeFileSync(absolutePath, bytes)
      const candidate = structuredClone(matrix) as { entries: Array<Record<string, unknown>> }
      const catalog = candidate.entries.find((entry) => entry.id === 'locked-0.28.1-catalog')
      if (catalog === undefined) throw new Error('expected locked catalog row')
      delete catalog.blocker
      Object.assign(catalog, {
        status: 'verified',
        fixturePath,
        sha256: sha256(bytes),
        provenance: {
          kind: 'driver-capture',
          repository: 'https://github.com/trycua/cua',
          tag: 'cua-driver-rs-v0.28.1',
          commit: 'd8028a7943087ee258dc1b4d19dc12a7cd27669c',
          platform: 'darwin',
          capturedAt: '2026-09-17T00:00:00Z',
          sanitization: 'negative test data, not evidence',
        },
      })

      const decision = evaluateComputerUseFixtureMatrix(candidate, temporaryRoot)
      expect(decision.ready).toBe(false)
      expect(decision.verified).not.toContain('locked-0.28.1-catalog')
      expect(decision.blockers).toEqual(
        expect.arrayContaining([
          'fixture:locked-0.28.1-catalog:trusted-digest-mismatch',
          'fixture:locked-0.28.1-catalog:trusted-catalog-binding-mismatch',
        ]),
      )
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })
})
