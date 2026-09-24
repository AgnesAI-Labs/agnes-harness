import {
  buildRuntimeTarget,
  encodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import { adaptRuntimeStaleFrame } from '../src/runtime-target-artifact.js'

function artifact(): RuntimeTargetArtifact {
  return encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: [],
      resourceRevision: 'b'.repeat(64),
      compositeRevision: 'c'.repeat(64),
      resources: { mcp: [], skills: {} },
    }),
  )
}

describe('worker runtime target artifact adapter', () => {
  it('accepts only the complete artifact frame and returns immutable verified values', () => {
    const input = {
      type: 'runtime.stale',
      artifact: structuredClone(artifact()) as {
        encoding: 'base64'
        canonicalBase64: string
        digest: string
        identity: { treeHash: string; resourceRevision: string; compositeRevision: string }
      },
    }
    const delivery = adaptRuntimeStaleFrame(input)

    input.artifact.identity.compositeRevision = 'd'.repeat(64)
    input.artifact.canonicalBase64 = 'e30='

    expect(delivery.artifact).toEqual(artifact())
    expect(delivery.target.resource.target).toEqual(delivery.artifact.identity)
    expect(Object.isFrozen(delivery)).toBe(true)
    expect(Object.isFrozen(delivery.artifact.identity)).toBe(true)
  })

  it.each([
    { type: 'runtime.stale', target: artifact() },
    { type: 'runtime.stale', artifact: artifact(), tree: {} },
    { type: 'runtime.stale', resourceRevision: 'b'.repeat(64) },
    { type: 'tree.stale', artifact: artifact() },
  ])('rejects incomplete, split, lookup-based, or legacy delivery %#', (frame) => {
    expect(() => adaptRuntimeStaleFrame(frame)).toThrow(/E_RUNTIME_STALE_FRAME/)
  })

  it('rejects a schema-valid envelope whose digest or embedded identity is forged', () => {
    const valid = artifact()
    expect(() =>
      adaptRuntimeStaleFrame({
        type: 'runtime.stale',
        artifact: { ...valid, digest: `sha256-${'0'.repeat(64)}` },
      }),
    ).toThrow(/E_RUNTIME_TARGET_DIGEST/)
    expect(() =>
      adaptRuntimeStaleFrame({
        type: 'runtime.stale',
        artifact: {
          ...valid,
          identity: { ...valid.identity, compositeRevision: 'd'.repeat(64) },
        },
      }),
    ).toThrow(/E_RUNTIME_TARGET_IDENTITY/)
  })
})
