import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTreeSnapshot } from '../src/convergence.js'
import type { PluginRow } from '../src/plugin-row.js'
import {
  buildRuntimeTarget,
  decodeCanonicalRuntimeTargetBytes,
  decodeRuntimeTargetArtifact,
  decodeRuntimeTargetBytes,
  encodeRuntimeTargetArtifact,
  RESOURCE_OWNED_ROW_IDS,
  type ResourceOwnedRowId,
  type RuntimeTargetArtifact,
} from '../src/runtime-target.js'

function row(id: string, overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id,
    plugin: `@example/${id}`,
    config: { enabled: true },
    inject: Object.freeze([]),
    disabled: false,
    isolate: Object.freeze({}),
    provides: Object.freeze([]),
    runtime: 'in-process',
    mountIdentity: `identity:${id}` as PluginRow['mountIdentity'],
    mountRevision: 'mount-1',
    entryRevision: 'entry-1',
    extrasRevision: 'extras-1',
    ...overrides,
  }
}

function build(rows: readonly PluginRow[] = [row('ext:example/ordinary')]) {
  return buildRuntimeTarget({
    rows,
    resourceRevision: '1'.repeat(64),
    compositeRevision: 'a'.repeat(64),
    resources: {
      mcp: [{ id: 'server-a', enabled: true }],
      skills: { roots: [{ id: 'workspace', skills: ['one'] }] },
    },
  })
}

function replaceBase64(artifact: RuntimeTargetArtifact, transform: (value: unknown) => unknown) {
  const parsed = JSON.parse(Buffer.from(artifact.canonicalBase64, 'base64').toString('utf8')) as unknown
  const changed = transform(parsed)
  return {
    ...artifact,
    canonicalBase64: Buffer.from(JSON.stringify(changed), 'utf8').toString('base64'),
  }
}

describe('Task 8 runtime target builder', () => {
  it('splits the closed resource-owned ids into nullable slots', () => {
    const resources = RESOURCE_OWNED_ROW_IDS.map((id) => row(id))
    const target = build([row('ext:example/ordinary'), ...resources])

    expect(target.tree.rows.map(({ id }) => id)).toEqual(['ext:example/ordinary'])
    expect(Object.keys(target.resource.rows)).toEqual([...RESOURCE_OWNED_ROW_IDS].sort())
    for (const id of RESOURCE_OWNED_ROW_IDS) expect(target.resource.rows[id]?.id).toBe(id)
    expect(target.resource.target.treeHash).toBe(target.tree.hash)
    expect(Object.isFrozen(target)).toBe(true)
    expect(Object.isFrozen(target.resource.rows)).toBe(true)
  })

  it.each(RESOURCE_OWNED_ROW_IDS)('%s is null when absent and retained when disabled', (id) => {
    const absent = build([])
    expect(absent.resource.rows[id]).toBeNull()

    const disabled = build([row(id, { disabled: true })])
    expect(disabled.resource.rows[id]).toMatchObject({ id, disabled: true })
    expect(disabled.tree.rows).toEqual([])
    expect(encodeRuntimeTargetArtifact(absent).digest).not.toBe(encodeRuntimeTargetArtifact(disabled).digest)
  })

  it.each(RESOURCE_OWNED_ROW_IDS)(
    '%s changes the artifact for enable, config, plugin and snapshot updates',
    (id) => {
      const variants = [
        row(id, { disabled: true }),
        row(id),
        row(id, { config: { enabled: false } }),
        row(id, { plugin: '@example/replacement' }),
        row(id, { mountIdentity: 'identity:new-snapshot' as PluginRow['mountIdentity'] }),
      ].map((resourceRow) =>
        encodeRuntimeTargetArtifact(
          buildRuntimeTarget({
            rows: [resourceRow],
            resourceRevision: '1'.repeat(64),
            compositeRevision: 'a'.repeat(64),
            resources: { mcp: [], skills: {} },
          }),
        ),
      )

      expect(new Set(variants.map(({ digest }) => digest))).toHaveLength(variants.length)
    },
  )

  it('changes identity and artifact bytes when either resource revision changes', () => {
    const first = encodeRuntimeTargetArtifact(build())
    const resourceChanged = encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows: [row('ext:example/ordinary')],
        resourceRevision: '2'.repeat(64),
        compositeRevision: 'a'.repeat(64),
        resources: {
          mcp: [{ id: 'server-a', enabled: true }],
          skills: { roots: [{ id: 'workspace', skills: ['one'] }] },
        },
      }),
    )
    const compositeChanged = encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows: [row('ext:example/ordinary')],
        resourceRevision: '1'.repeat(64),
        compositeRevision: 'b'.repeat(64),
        resources: {
          mcp: [{ id: 'server-a', enabled: true }],
          skills: { roots: [{ id: 'workspace', skills: ['one'] }] },
        },
      }),
    )

    expect(resourceChanged.identity.resourceRevision).toBe('2'.repeat(64))
    expect(compositeChanged.identity.compositeRevision).toBe('b'.repeat(64))
    expect(new Set([first.digest, resourceChanged.digest, compositeChanged.digest])).toHaveLength(3)
  })

  it('rejects duplicate ownership and ordinary snapshots containing a resource id', () => {
    const id: ResourceOwnedRowId = 'ext:agnes/skills'
    expect(() => build([row(id), row(id)])).toThrow(/duplicate row id/)
    expect(() => createTreeSnapshot([row(id)])).toThrow(/E_RESOURCE_OWNED_ROW/)
  })

  it('keeps resource-only changes out of the ordinary tree hash', () => {
    const first = build([row('ext:example/ordinary'), row('ext:agnes/skills', { disabled: true })])
    const second = build([
      row('ext:example/ordinary'),
      row('ext:agnes/skills', { disabled: false, config: { policy: 'new' } }),
    ])

    expect(first.tree.hash).toBe(second.tree.hash)
    expect(encodeRuntimeTargetArtifact(first).digest).not.toBe(encodeRuntimeTargetArtifact(second).digest)
  })

  it('copies and deeply freezes every input', () => {
    const ordinaryConfig = { nested: { enabled: true } }
    const resources = {
      mcp: [{ id: 'one', enabled: true }],
      skills: { roots: [{ names: ['alpha'] }] },
    }
    const target = buildRuntimeTarget({
      rows: [row('ext:example/ordinary', { config: ordinaryConfig })],
      resourceRevision: '1'.repeat(64),
      compositeRevision: 'a'.repeat(64),
      resources,
    })

    ordinaryConfig.nested.enabled = false
    const firstServer = resources.mcp[0]
    const firstRoot = resources.skills.roots[0]
    if (!firstServer || !firstRoot) throw new Error('expected mutation fixtures')
    firstServer.id = 'mutated'
    firstRoot.names.push('beta')

    expect(target.tree.rows[0]?.config).toEqual({ nested: { enabled: true } })
    expect(target.resource.resources.mcp).toEqual([{ enabled: true, id: 'one' }])
    expect(target.resource.resources.skills).toEqual({ roots: [{ names: ['alpha'] }] })
    expect(Object.isFrozen((target.resource.resources.mcp as object[])[0])).toBe(true)
  })

  it('canonicalizes inject and provides as Unicode code-point string sets', () => {
    const canonical = encodeRuntimeTargetArtifact(
      build([
        row('ext:example/ordinary', {
          inject: ['a', 'z', '\u{10000}', '\u{1f600}'],
          provides: ['alpha', 'omega', '\u{10000}', '\u{1f600}'],
        }),
      ]),
    )
    const permuted = encodeRuntimeTargetArtifact(
      build([
        row('ext:example/ordinary', {
          inject: ['\u{1f600}', 'z', 'a', '\u{10000}', 'a'],
          provides: ['omega', '\u{1f600}', 'alpha', '\u{10000}', 'omega'],
        }),
      ]),
    )

    expect(permuted).toEqual(canonical)
    const decoded = decodeRuntimeTargetArtifact(permuted)
    expect(decoded.tree.rows[0]?.inject).toEqual(['a', 'z', '\u{10000}', '\u{1f600}'])
    expect(decoded.tree.rows[0]?.provides).toEqual(['alpha', 'omega', '\u{10000}', '\u{1f600}'])
  })

  it('accepts the existing array-shaped MCP bootstrap without retaining it', () => {
    const mcp = [{ definition: { serverId: 'one' }, desired: 'enabled' }]
    const target = buildRuntimeTarget({
      rows: [],
      resourceRevision: '1'.repeat(64),
      compositeRevision: 'a'.repeat(64),
      resources: { mcp, skills: { roots: [] } },
    })

    const first = mcp[0]
    if (!first) throw new Error('expected MCP fixture')
    first.definition.serverId = 'mutated'
    expect(target.resource.resources.mcp).toEqual([{ definition: { serverId: 'one' }, desired: 'enabled' }])
  })

  it('rejects resource bootstrap container shapes that do not match the worker snapshot', () => {
    const revisions = {
      resourceRevision: '1'.repeat(64),
      compositeRevision: 'a'.repeat(64),
    }
    expect(() => buildRuntimeTarget({ rows: [], ...revisions, resources: { mcp: {}, skills: {} } })).toThrow(
      /resources\.mcp must be an array/,
    )
    expect(() => buildRuntimeTarget({ rows: [], ...revisions, resources: { mcp: [], skills: [] } })).toThrow(
      /resources\.skills must be an object/,
    )
  })
})

describe('Task 8 canonical artifact codec', () => {
  it('round-trips canonical bytes and returns fresh deeply frozen values', () => {
    const target = build([
      row('ext:example/ordinary'),
      row('ext:agnes/mcp-client', { config: { order: ['b', 'a'] } }),
    ])
    const artifact = encodeRuntimeTargetArtifact(target)
    const first = decodeRuntimeTargetArtifact(artifact)
    const second = decodeRuntimeTargetArtifact(structuredClone(artifact))
    const firstBytes = decodeRuntimeTargetBytes(artifact)
    const secondBytes = decodeRuntimeTargetBytes(artifact)

    expect(artifact.encoding).toBe('base64')
    expect(artifact.digest).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(artifact.identity).toEqual(target.resource.target)
    expect(first).toEqual(target)
    expect(first).not.toBe(second)
    expect(first.tree).not.toBe(second.tree)
    expect(Object.isFrozen(first.resource.resources)).toBe(true)
    expect(firstBytes).not.toBe(secondBytes)
    expect(firstBytes).toEqual(secondBytes)

    firstBytes[0] = 0
    expect(decodeRuntimeTargetBytes(artifact)).toEqual(secondBytes)
  })

  it('decodes the exact canonical target bytes without an artifact envelope', () => {
    const artifact = encodeRuntimeTargetArtifact(build())
    const bytes = Buffer.from(artifact.canonicalBase64, 'base64')

    expect(decodeCanonicalRuntimeTargetBytes(bytes)).toEqual(build())
    const pretty = Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')), null, 2), 'utf8')
    expect(() => decodeCanonicalRuntimeTargetBytes(pretty)).toThrow(/E_RUNTIME_TARGET_CANONICAL/)
  })

  it('does not let output mutation alter an artifact or a later decode', () => {
    const artifact = encodeRuntimeTargetArtifact(build())
    const before = structuredClone(artifact)
    expect(() => {
      ;(artifact.identity as { treeHash: string }).treeHash = 'forged'
    }).toThrow()
    const decoded = decodeRuntimeTargetArtifact(artifact)
    expect(artifact).toEqual(before)
    expect(decoded.resource.target).toEqual(before.identity)
  })

  it('rejects forged digest, forged outer identity and non-canonical base64', () => {
    const artifact = encodeRuntimeTargetArtifact(build())
    expect(() => decodeRuntimeTargetArtifact({ ...artifact, digest: `sha256-${'0'.repeat(64)}` })).toThrow(
      /E_RUNTIME_TARGET_DIGEST/,
    )
    expect(() =>
      decodeRuntimeTargetArtifact({
        ...artifact,
        identity: { ...artifact.identity, compositeRevision: 'f'.repeat(64) },
      }),
    ).toThrow(/E_RUNTIME_TARGET_IDENTITY/)
    expect(() =>
      decodeRuntimeTargetArtifact({ ...artifact, canonicalBase64: `${artifact.canonicalBase64}\n` }),
    ).toThrow(/E_RUNTIME_TARGET_BASE64/)
    expect(() =>
      decodeRuntimeTargetArtifact({
        ...artifact,
        canonicalBase64: 'A'.repeat(16_777_220),
      }),
    ).toThrow(/E_RUNTIME_TARGET_BASE64/)
  })

  it('accepts the largest wire-deliverable base64 length and rejects one more quartet', () => {
    const original = encodeRuntimeTargetArtifact(build())
    const maximum = 'A'.repeat(16_776_788)

    expect(() => decodeRuntimeTargetArtifact({ ...original, canonicalBase64: maximum })).toThrow(
      /E_RUNTIME_TARGET_DIGEST/,
    )
    expect(() => decodeRuntimeTargetArtifact({ ...original, canonicalBase64: `${maximum}AAAA` })).toThrow(
      /E_RUNTIME_TARGET_BASE64/,
    )
  })

  it('rejects canonical bytes whose embedded identity, tree hash or shape is forged', () => {
    const artifact = encodeRuntimeTargetArtifact(build())
    const cases = [
      replaceBase64(artifact, (value) => {
        const target = value as { resource: { target: { compositeRevision: string } } }
        target.resource.target.compositeRevision = 'f'.repeat(64)
        return target
      }),
      replaceBase64(artifact, (value) => {
        const target = value as { tree: { hash: string } }
        target.tree.hash = '0'.repeat(64)
        return target
      }),
      replaceBase64(artifact, (value) => ({ ...(value as object), unexpected: true })),
    ]
    for (const changed of cases) {
      const bytes = Buffer.from(changed.canonicalBase64, 'base64')
      const withDigest = {
        ...changed,
        digest: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
      }
      expect(() => decodeRuntimeTargetArtifact(withDigest)).toThrow(/E_(?:RUNTIME_TARGET|TREE_HASH)/)
    }
  })

  it('rejects semantically valid but non-canonical JSON bytes', () => {
    const artifact = encodeRuntimeTargetArtifact(build())
    const parsed = JSON.parse(Buffer.from(artifact.canonicalBase64, 'base64').toString('utf8'))
    const bytes = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8')
    const forged = {
      ...artifact,
      canonicalBase64: bytes.toString('base64'),
      digest: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
    }
    expect(() => decodeRuntimeTargetArtifact(forged)).toThrow(/E_RUNTIME_TARGET_CANONICAL/)
  })

  it.each(['short', 'A'.repeat(64)])('rejects an invalid identity revision: %s', (revision) => {
    expect(() =>
      buildRuntimeTarget({
        rows: [],
        resourceRevision: revision,
        compositeRevision: 'a'.repeat(64),
        resources: { mcp: [], skills: {} },
      }),
    ).toThrow(/E_RUNTIME_TARGET_IDENTITY/)
  })
})
