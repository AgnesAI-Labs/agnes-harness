import { RuntimeMethodSchemaRefs, RuntimeSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { defineArtifactTool, runtimeAuthorSchemas } from '../../src/runtime/index.js'

describe('artifact author declaration inputs', () => {
  it('binds the official descriptor and prepares reserve-before-render and final publication', () => {
    let renders = 0
    const declaration = defineArtifactTool({
      id: 'document',
      description: 'A document',
      input: runtimeAuthorSchemas.StandardToolOutput,
      render() {
        renders++
        return { title: 'Ready', mediaType: 'text/plain', bytes: new Uint8Array() }
      },
    })
    expect(renders).toBe(0)
    expect(declaration.publication.contentSchema.ref).toEqual(RuntimeSchemaRefs.ArtifactContentDescriptor)
    expect(declaration.publication.reserve).toEqual(RuntimeMethodSchemaRefs['agh.artifacts'].reserve)
    expect(Object.isFrozen(declaration.publication)).toBe(true)
    const reserve = declaration.publication.prepareReserve({
      publicationId: 'publication',
      artifactId: null,
      expectedLatestVersion: null,
      ownerActionRef: { existingActionId: 'action' },
      title: null,
      mediaType: null,
    })
    expect(reserve.schema).toEqual(RuntimeSchemaRefs.ArtifactContentDescriptor)
    expect(reserve.kind).toBe('agh.artifacts/content-descriptor@1')
    expect(validateRuntime('ArtifactsReserveRequest', reserve).ok).toBe(true)
    const next = declaration.publication.prepareReserve({
      publicationId: 'next',
      artifactId: 'existing',
      expectedLatestVersion: 1,
      ownerActionRef: { existingActionId: 'action' },
      title: null,
      mediaType: null,
    })
    expect(next.artifactId).toBe('existing')
  })

  it('keeps publication builders pure and rejects caller schema replacement or MIME laundering', () => {
    const declaration = defineArtifactTool({
      id: 'document',
      description: 'Document',
      input: runtimeAuthorSchemas.StandardToolOutput,
      render: () => ({ title: 'Ready', mediaType: 'text/plain', bytes: new Uint8Array() }),
    })
    const input = {
      publicationId: 'publication',
      artifactId: null,
      expectedLatestVersion: null,
      title: null,
      mediaType: null,
      ownerActionRef: { existingActionId: 'action' },
    }
    expect(() =>
      Reflect.apply(declaration.publication.prepareReserve, undefined, [
        { ...input, schema: RuntimeSchemaRefs.StandardToolOutput },
      ]),
    ).toThrow(/locked descriptor/)
    expect(() =>
      Reflect.apply(declaration.publication.prepareReserve, undefined, [
        { ...input, artifactId: 'existing' },
      ]),
    ).toThrow(/reservation/)
    const blob = {
      authorityId: 'blob',
      blobId: 'content',
      digest: 'a'.repeat(64),
      bytes: 3,
      mediaType: 'text/plain',
      pinId: 'pin',
    }
    const final = {
      publicationId: 'publication',
      expectedRevision: 1,
      source: { kind: 'blob' as const, blob },
      title: 'Ready',
      mediaType: 'text/plain',
    }
    expect(declaration.publication.preparePublish(final)).toEqual(final)
    expect(() =>
      declaration.publication.preparePublish({ ...final, mediaType: 'application/octet-stream' }),
    ).toThrow(/does not match/)
    expect(() =>
      Reflect.apply(declaration.publication.preparePublish, undefined, [{ ...final, title: null }]),
    ).toThrow(/publication/)
    const descriptor = declaration.publication.contentSchema.encode({
      title: 'Ready',
      mediaType: 'text/plain',
      bytes: 3,
      digest: blob.digest,
    })
    expect(descriptor.ok).toBe(true)
    expect(
      declaration.publication.contentSchema.parse({
        title: 'Ready',
        mediaType: 'text/plain',
        bytes: -0,
        digest: blob.digest,
      }).ok,
    ).toBe(false)
  })
})
