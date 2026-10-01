import { defineTool, runtimeAuthorSchemas, standardHookOperations } from '@agnes/extension-api/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateControlledHttpHeaders,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

describe('standard hook operation declarations', () => {
  it('uses official method identities and the bound default operation', () => {
    const operation = standardHookOperations.networkRequest
    expect(operation.contract).toBe('agh.network')
    expect(operation.logicalName).toBe('default')
    expect(operation.method).toBe('request')
    expect(operation.input.ref).toEqual(RuntimeMethodSchemaRefs['agh.network'].request.input)
    expect(operation.output.ref).toEqual(RuntimeMethodSchemaRefs['agh.network'].request.output)
    expect(Object.isFrozen(operation)).toBe(true)
    expect(operation.input.parse({}).ok).toBe(false)
    expect(operation.output.parse({}).ok).toBe(false)
    const headers = standardHookOperations.httpHeaders.encode({ accept: 'application/json' })
    if (!headers.ok) throw new Error('header encoding failed')
    const target = {
      targetId: 'service',
      scheme: 'https' as const,
      host: 'example.invalid',
      port: 443,
      path: '/',
    }
    const request = {
      target,
      method: 'GET' as const,
      headers: headers.value,
      bodyRef: null,
      redirect: { mode: 'deny' as const, maxHops: 0 },
      maxBytes: 1024,
    }
    const encoded = operation.input.encode(request)
    if (!encoded.ok || encoded.value.kind !== 'inline') throw new Error('request encoding failed')
    expect(encoded.value.schema).toEqual(operation.input.ref)
    expect(operation.input.parse({ ...request, maxBytes: -0 }).ok).toBe(false)
    const output = {
      status: 200,
      headersRef: headers.value,
      bodyRef: {
        authorityId: 'blobs',
        blobId: 'body',
        digest: canonicalJsonDigest(null),
        bytes: 0,
        mediaType: 'application/json',
        pinId: 'pin',
      },
      finalTarget: target,
      receipt: null,
    }
    const response = operation.output.encode(output)
    if (!response.ok || response.value.kind !== 'inline') throw new Error('response encoding failed')
    expect(response.value.schema).toEqual(operation.output.ref)
    expect(operation.output.parse({ ...output, status: -0 }).ok).toBe(false)
  })

  it('restricts request headers without narrowing the generic or response codecs', () => {
    const codec = standardHookOperations.httpHeaders
    expect(codec.ref).toEqual(RuntimeSchemaRefs.ControlledHttpHeaders)
    expect(codec.parse({ accept: 'application/json', 'x-request-id': 'request' }).ok).toBe(true)
    for (const name of ['content-length', 'location', 'retry-after']) {
      const value = { [name]: '1' }
      expect(runtimeAuthorSchemas.ControlledHttpHeaders.parse(value).ok).toBe(true)
      expect(validateControlledHttpHeaders('response', value).ok).toBe(true)
      expect(codec.parse(value).ok).toBe(false)
      expect(codec.encode(value).ok).toBe(false)
    }
    expect(validateControlledHttpHeaders('response', { accept: 'application/json' }).ok).toBe(false)
  })

  it('uses the shared codec brand and returns immutable canonical inline headers', () => {
    const codec = standardHookOperations.httpHeaders
    expect(
      defineTool({
        id: 'headers',
        description: 'Read request headers',
        execution: 'pure',
        input: codec,
        execute: () => ({ content: [] }),
      }),
    ).toBeDefined()
    expect(() =>
      defineTool({
        id: 'forged-headers',
        description: 'Read request headers',
        execution: 'pure',
        input: { ...codec },
        execute: () => ({ content: [] }),
      }),
    ).toThrow()
    const input = { accept: '中文' }
    const encoded = codec.encode(input)
    if (!encoded.ok || encoded.value.kind !== 'inline') throw new Error('header encoding failed')
    input.accept = 'changed'
    expect(encoded.value.schema).toEqual(RuntimeSchemaRefs.ControlledHttpHeaders)
    expect(encoded.value.value).toEqual({ accept: '中文' })
    expect(encoded.value.bytes).toBe(Buffer.byteLength('{"accept":"中文"}'))
    expect(encoded.value.digest).toBe(canonicalJsonDigest({ accept: '中文' }))
    expect(Object.isFrozen(encoded.value.value)).toBe(true)
  })

  it('rejects unsafe names, controls, accessors and UTF-8 overflow', () => {
    const codec = standardHookOperations.httpHeaders
    for (const value of [
      { Accept: 'text/plain' },
      { authorization: 'secret' },
      { cookie: 'secret' },
      { 'x-unknown': 'value' },
      { accept: 'value\r\n' },
      { accept: '\t' },
      { accept: '\u007f' },
      { accept: `${'😀'.repeat(2048)}x` },
    ])
      expect(codec.parse(value).ok).toBe(false)
    expect(codec.parse({ accept: '😀'.repeat(2048) }).ok).toBe(true)
    let calls = 0
    const accessor = Object.defineProperty({}, 'accept', {
      enumerable: true,
      get() {
        calls++
        return 'text/plain'
      },
    })
    expect(codec.parse(accessor).ok).toBe(false)
    expect(calls).toBe(0)
  })
})
