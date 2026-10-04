import { describe, expect, it } from 'vitest'
import { decodeLanguageResponse } from '../src/language-response.js'

describe('native language proposals', () => {
  it('preserves parameter proposals for runtime tool and schema admission', () => {
    expect(
      decodeLanguageResponse('parameters', 'I can read that file.', [
        { name: 'read', arguments: '{"path":"note.txt"}' },
      ]),
    ).toEqual({ output: { kind: 'call', name: 'read', arguments: { path: 'note.txt' } } })
    expect(decodeLanguageResponse('parameters', '', [{ name: 'unavailable', arguments: '{}' }])).toEqual({
      output: { kind: 'call', name: 'unavailable', arguments: {} },
    })
  })

  it.each([
    '',
    '我先读取相关说明。',
    'I will gather information. Extra explanation.',
    'Inspect the existing file first.',
  ])('accepts a native arbitration call with ordinary commentary: %j', (text) => {
    expect(
      decodeLanguageResponse('arbitration', text, [{ name: 'shell', arguments: '{"command":"pwd"}' }]),
    ).toEqual({ output: { kind: 'call', name: 'shell', arguments: { command: 'pwd' } } })
  })

  it('keeps no-call explanations separate from tool proposals', () => {
    expect(decodeLanguageResponse('parameters', '  Please provide the file path.  ', [])).toEqual({
      output: { kind: 'cannot_bind', reason: 'Please provide the file path.' },
    })
    expect(decodeLanguageResponse('arbitration', 'The recorded result answers the question.', [])).toEqual({
      output: {
        kind: 'answer',
        content: [{ kind: 'text', text: 'The recorded result answers the question.' }],
      },
    })
    expect(decodeLanguageResponse('parameters', '', []).error).toMatchObject({
      code: 'LANGUAGE_TOOL_CALL',
      retryable: true,
    })
    expect(decodeLanguageResponse('arbitration', '  \n ', []).error).toMatchObject({
      code: 'LANGUAGE_TOOL_CALL',
      retryable: true,
    })
    expect(decodeLanguageResponse('arbitration', '  Exact text.\n', []).output).toEqual({
      kind: 'answer',
      content: [{ kind: 'text', text: '  Exact text.\n' }],
    })
  })

  it.each(['', '{', '{} {}', '[]', 'null', 'true', '"value"', '```json\n{}\n```', '{"value":1e400}'])(
    'rejects incomplete or non-object arguments: %s',
    (argumentsText) => {
      expect(
        decodeLanguageResponse('parameters', '', [{ name: 'read', arguments: argumentsText }]).error,
      ).toMatchObject({ code: 'LANGUAGE_INVALID_JSON', retryable: true })
      const batch = decodeLanguageResponse('arbitration', '', [
        { name: 'read', arguments: '{"path":"valid"}' },
        { name: 'read', arguments: argumentsText },
      ])
      expect(batch.error).toMatchObject({ code: 'LANGUAGE_INVALID_JSON', retryable: true })
      expect(batch.output).toBeUndefined()
    },
  )

  it.each([2, 32])('preserves an ordered arbitration batch of %i calls', (count) => {
    const calls = Array.from({ length: count }, (_, index) => ({
      name: index % 2 === 0 ? 'read' : 'write',
      arguments: JSON.stringify({ path: `file-${index}` }),
    }))
    expect(decodeLanguageResponse('arbitration', 'These calls use existing evidence.', calls)).toEqual({
      output: {
        kind: 'calls',
        calls: calls.map((call) => ({
          kind: 'call',
          name: call.name,
          arguments: JSON.parse(call.arguments),
        })),
      },
    })
  })

  it('rejects multiple parameter proposals and oversized arbitration batches', () => {
    expect(
      decodeLanguageResponse('parameters', '', [
        { name: 'read', arguments: '{"path":"a"}' },
        { name: 'read', arguments: '{"path":"b"}' },
      ]).error,
    ).toMatchObject({ code: 'LANGUAGE_TOOL_CALL', retryable: true })
    expect(
      decodeLanguageResponse(
        'arbitration',
        '',
        Array.from({ length: 33 }, () => ({ name: 'read', arguments: '{}' })),
      ),
    ).toEqual({
      error: { code: 'LANGUAGE_TOOL_CALL', message: expect.any(String), retryable: true },
    })
  })
})
