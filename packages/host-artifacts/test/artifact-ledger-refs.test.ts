import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_REF_EXTRACTOR_VERSION, extractArtifactRefs } from '../src/artifact-ledger-refs.js'

const digest = (character: string) => character.repeat(64)
const row = (type: string, data: unknown, extra: Record<string, string> = {}) => ({
  type,
  data: JSON.stringify(data),
  origin: 'user',
  trust: 'trusted',
  lane: 'main',
  ...extra,
})

describe('shared ledger artifact reference extraction', () => {
  it('collects nested artifact URIs and sha256 keys, ignoring other strings and uppercase digests', () => {
    const refs = extractArtifactRefs(
      row('user/message', {
        a: [{ b: { uri: `artifact://${digest('a')}` } }],
        sha256: digest('b'),
        other: { sha256: digest('C') },
        text: `see artifact://${digest('d')}`,
      }),
    )
    expect(refs.ledger).toEqual(new Set([digest('a'), digest('b')]))
    expect(refs.requestMedia).toEqual(new Set())
  })

  it('refuses rows nested deeper than the traversal bound', () => {
    let nested: unknown = { sha256: digest('a') }
    for (let depth = 0; depth < 31; depth += 1) nested = [nested]
    expect(() => extractArtifactRefs(row('user/message', nested))).not.toThrow()
    expect(() => extractArtifactRefs(row('user/message', [nested]))).toThrow('safe traversal depth')
  })

  it('reads request-media manifests only from request headers and refuses malformed ones', () => {
    const sha = digest('e')
    const manifest = { media: { manifest: [{ sha256: sha, artifactUri: `artifact://${sha}` }] } }
    expect(extractArtifactRefs(row('request/header', manifest)).requestMedia).toEqual(new Set([sha]))
    expect(extractArtifactRefs(row('user/message', manifest)).requestMedia).toEqual(new Set())
    expect(extractArtifactRefs(row('request/header', {})).requestMedia).toEqual(new Set())
    for (const bad of [
      { media: { manifest: {} } },
      { media: { manifest: [{ sha256: sha }] } },
      { media: { manifest: [{ sha256: 'x', artifactUri: 'artifact://x' }] } },
      { media: { manifest: [null] } },
    ])
      expect(() => extractArtifactRefs(row('request/header', bad))).toThrow('manifest')
    expect(() => extractArtifactRefs({ type: 'user/message', data: '{' })).toThrow()
  })

  it('marks only successful Computer Use image links as tool images and records turn lanes', () => {
    const sha = digest('f')
    const content = {
      isError: false,
      content: [
        { type: 'resource_link', uri: `artifact://${sha}`, mimeType: 'image/png' },
        { type: 'resource_link', uri: `artifact://${digest('1')}`, mimeType: 'text/plain' },
      ],
    }
    const cu = { origin: 'tool:computer_use', trust: 'untrusted' }
    expect(extractArtifactRefs(row('tool/result', content, cu)).toolImage).toEqual(new Set([sha]))
    expect(extractArtifactRefs(row('tool/result', content, cu)).ledger).toEqual(new Set([sha, digest('1')]))
    expect(
      extractArtifactRefs(row('tool/result', content, { origin: 'tool:other', trust: 'untrusted' })).toolImage
        .size,
    ).toBe(0)
    expect(extractArtifactRefs(row('tool/result', { ...content, isError: true }, cu)).toolImage.size).toBe(0)
    expect(extractArtifactRefs(row('tool/result', content, { ...cu, trust: 'trusted' })).toolImage.size).toBe(
      0,
    )
    expect(extractArtifactRefs(row('turn/start', {}, { lane: 'side' })).turn).toEqual({
      kind: 'start',
      lane: 'side',
    })
    expect(extractArtifactRefs(row('turn/end', {})).turn).toEqual({ kind: 'end', lane: 'main' })
    expect(extractArtifactRefs(row('user/message', {})).turn).toBeUndefined()
  })

  it('keeps its output on a pinned corpus unless the extractor version is bumped', () => {
    // The reference index trusts rows it extracted earlier. Any change to what the extractor
    // returns must bump ARTIFACT_REF_EXTRACTOR_VERSION (which rebuilds every index) and then
    // re-pin this digest together with the new version.
    const pinned = {
      version: '1',
      digest: '7b2c5c643f5fd9af5bd1d8e5bff2fef0e40060f8274b548054560128823aae7f',
    }
    const sha = (character: string) => character.repeat(64)
    let deep: unknown = { sha256: sha('9') }
    for (let depth = 0; depth < 31; depth += 1) deep = depth % 2 ? [deep] : { next: deep }
    const corpus = [
      row('user/message', { text: `artifact://${sha('a')}`, nested: [{ uri: `artifact://${sha('b')}` }] }),
      row('user/message', { sha256: sha('c'), other: { sha256: sha('D') }, uri: `artifact://${sha('E')}` }),
      row('user/message', deep),
      row('request/header', {
        media: { manifest: [{ sha256: sha('d'), artifactUri: `artifact://${sha('d')}` }] },
      }),
      row('request/header', { media: { manifest: [] }, sha256: sha('e') }),
      row('request/header', {}),
      row(
        'tool/result',
        {
          isError: false,
          content: [
            { type: 'resource_link', uri: `artifact://${sha('f')}`, mimeType: 'image/png' },
            { type: 'resource_link', uri: `artifact://${sha('1')}`, mimeType: 'image/jpeg' },
            { type: 'resource_link', uri: `artifact://${sha('2')}`, mimeType: 'image/gif' },
            { type: 'text', text: `artifact://${sha('3')}` },
            null,
            'artifact://x',
          ],
        },
        { origin: 'tool:computer_use', trust: 'untrusted' },
      ),
      row(
        'tool/result',
        {
          isError: true,
          content: [{ type: 'resource_link', uri: `artifact://${sha('4')}`, mimeType: 'image/png' }],
        },
        { origin: 'tool:computer_use', trust: 'untrusted' },
      ),
      row(
        'tool/result',
        {
          isError: false,
          content: [{ type: 'resource_link', uri: `artifact://${sha('5')}`, mimeType: 'image/png' }],
        },
        { origin: 'tool:other', trust: 'untrusted' },
      ),
      row('turn/start', {}, { lane: 'side' }),
      row('turn/end', {}, { lane: 'main' }),
    ]
    const output = corpus.map((entry) => {
      const refs = extractArtifactRefs(entry)
      return {
        ledger: [...refs.ledger].sort(),
        requestMedia: [...refs.requestMedia].sort(),
        toolImage: [...refs.toolImage].sort(),
        turn: refs.turn ?? null,
      }
    })
    const digest = createHash('sha256').update(JSON.stringify(output)).digest('hex')
    expect({ version: ARTIFACT_REF_EXTRACTOR_VERSION, digest }).toEqual(pinned)
  })
})
