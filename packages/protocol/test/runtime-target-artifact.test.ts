import { describe, expect, it } from 'vitest'
import { RuntimeTargetArtifact } from '../gen/ts/worker.js'
import { MAX_FRAME_BYTES, MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH } from '../src/constants.js'
import { validateRuntimeStaleFrame, validateRuntimeTargetArtifact } from '../src/runtime-target-artifact.js'

const identity = {
  treeHash: '1633902c6cbba5e7770dbed172df754a25078bb76efe1f23474edc87f1a47655',
  resourceRevision: 'b'.repeat(64),
  compositeRevision: 'c'.repeat(64),
}

const artifact = {
  encoding: 'base64',
  canonicalBase64:
    'eyJyZXNvdXJjZSI6eyJyZXNvdXJjZXMiOnsibWNwIjpbXSwic2tpbGxzIjp7fX0sInJvd3MiOnsiZXh0OmFnbmVzL2hvb2tzLXJ1bm5lciI6bnVsbCwiZXh0OmFnbmVzL21jcC1jbGllbnQiOm51bGwsImV4dDphZ25lcy9wcml2YWN5IjpudWxsLCJleHQ6YWduZXMvc2tpbGxzIjpudWxsfSwidGFyZ2V0Ijp7ImNvbXBvc2l0ZVJldmlzaW9uIjoiY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYyIsInJlc291cmNlUmV2aXNpb24iOiJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwidHJlZUhhc2giOiIxNjMzOTAyYzZjYmJhNWU3NzcwZGJlZDE3MmRmNzU0YTI1MDc4YmI3NmVmZTFmMjM0NzRlZGM4N2YxYTQ3NjU1In19LCJ0cmVlIjp7Imhhc2giOiIxNjMzOTAyYzZjYmJhNWU3NzcwZGJlZDE3MmRmNzU0YTI1MDc4YmI3NmVmZTFmMjM0NzRlZGM4N2YxYTQ3NjU1Iiwicm93cyI6W119fQ==',
  digest: 'sha256-aa9488e5eeab7573bb7205041031454b338afb0c3376bd699aa5039ed3df4ec3',
  identity,
}

describe('runtime target artifact wire contract', () => {
  it('accepts one complete immutable artifact on runtime.stale', () => {
    expect(validateRuntimeTargetArtifact(artifact)).toEqual({ ok: true, value: artifact })
    expect(validateRuntimeStaleFrame({ type: 'runtime.stale', artifact })).toEqual({
      ok: true,
      value: { type: 'runtime.stale', artifact },
    })
  })

  it('keeps every schema-valid maximum artifact inside the JSONL frame ceiling', () => {
    const maximum = {
      ...artifact,
      canonicalBase64: 'A'.repeat(MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH),
    }
    const frame = { type: 'runtime.stale', artifact: maximum }

    const generatedArtifact = RuntimeTargetArtifact.$defs.RuntimeTargetArtifact as {
      properties: { canonicalBase64: { maxLength: number } }
    }
    expect(generatedArtifact.properties.canonicalBase64.maxLength).toBe(
      MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH,
    )
    expect(validateRuntimeTargetArtifact(maximum)).toEqual({ ok: true, value: maximum })
    expect(validateRuntimeStaleFrame(frame)).toEqual({ ok: true, value: frame })
    expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBe(MAX_FRAME_BYTES - 3)

    const oversized = {
      ...maximum,
      canonicalBase64: `${maximum.canonicalBase64}AAAA`,
    }
    expect(validateRuntimeTargetArtifact(oversized).ok).toBe(false)
    expect(Buffer.byteLength(JSON.stringify({ type: 'runtime.stale', artifact: oversized }), 'utf8')).toBe(
      MAX_FRAME_BYTES + 1,
    )
  })

  it.each([
    [{ ...artifact, encoding: 'utf8' }, 'encoding'],
    [{ ...artifact, canonicalBase64: 'e30' }, 'canonical base64 padding'],
    [{ ...artifact, canonicalBase64: 'e30===' }, 'canonical base64 padding length'],
    [{ ...artifact, canonicalBase64: 'e30_' }, 'standard base64 alphabet'],
    [{ ...artifact, canonicalBase64: '' }, 'non-empty canonical bytes'],
    [{ ...artifact, digest: `sha256-${'A'.repeat(64)}` }, 'lower-case sha256 digest'],
    [{ ...artifact, digest: `sha256-${'a'.repeat(63)}` }, 'sha256 digest length'],
    [{ ...artifact, digest: 'a'.repeat(64) }, 'sha256 digest prefix'],
    [{ ...artifact, identity: { ...identity, treeHash: 'short' } }, 'tree identity'],
    [{ ...artifact, identity: { ...identity, resourceRevision: 'short' } }, 'resource identity'],
    [{ ...artifact, identity: { ...identity, compositeRevision: 'short' } }, 'composite identity'],
    [{ ...artifact, identity: undefined }, 'required identity'],
    [{ ...artifact, extra: true }, 'closed artifact shape'],
  ])('rejects %s (%s)', (candidate, _reason) => {
    expect(validateRuntimeTargetArtifact(candidate).ok).toBe(false)
  })

  it.each([
    { type: 'runtime.stale' },
    { type: 'runtime.stale', target: artifact },
    { type: 'runtime.stale', artifact, tree: {} },
    { type: 'runtime.stale', artifact, resource: {} },
    { type: 'runtime.stale', artifact, resourceRevision: identity.resourceRevision },
    { type: 'runtime.tree_stale', artifact },
  ])('rejects split, lookup-based, or incomplete stale frame %#', (candidate) => {
    expect(validateRuntimeStaleFrame(candidate).ok).toBe(false)
  })
})
