import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { parseActionResult, parseCaptureResult, parseListingResult } from '../src/parse.js'
import { actionToolResult, actionVerdict, captureToolResult } from '../src/result.js'

describe('computer_use capture parsing and result budgets', () => {
  it('parses snake/camel aliases, placeholder ids, tokens, and zero bounds', () => {
    const capture = parseCaptureResult({
      mode: 'som',
      width: 800,
      height: 600,
      app: 'Editor',
      windowTitle: 'doc',
      target: { pid: 0, window_id: 0, app: 'Editor' },
      elements: [
        {
          index: 0,
          role: 'button',
          label: 'Save',
          bounds: [0, 0, 0, 0],
          element_token: 'opaque',
        },
      ],
    })
    expect(capture.target).toEqual({ app: 'Editor' })
    expect(capture.windowTitle).toBe('doc')
    expect(capture.elements[0]).toMatchObject({ index: 0, bounds: null, elementToken: 'opaque' })
  })

  it('prefers MCP structuredContent and supports typed frames plus JSON text fallback', () => {
    const parsed = parseCaptureResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ mode: 'som', width: 640, height: 480, app: 'text-app' }),
        },
      ],
      structured_content: {
        app: 'structured-app',
        window_title: 'Document',
        bounds_scale: 2,
        target: { app: 'structured-app', pid: 12, window_id: 34 },
        elements: [
          {
            element_index: 2,
            role: 'button',
            label: 'Save',
            frame: { x: 10, y: 20, w: 30, h: 40 },
            element_token: 'opaque',
          },
        ],
      },
      is_error: false,
    })
    expect(parsed).toMatchObject({
      mode: 'som',
      width: 640,
      height: 480,
      app: 'structured-app',
      windowTitle: 'Document',
      boundsScale: 2,
      elements: [{ index: 2, bounds: [10, 20, 30, 40], elementToken: 'opaque' }],
    })
  })

  it('uses the versioned text element fallback but rejects unnormalized MCP image bytes', () => {
    const parsed = parseCaptureResult({
      data: 'window tree\n[0] AXButton "Save"\n- [2] AXTextField id=Name',
      structuredContent: { mode: 'ax', width: 800, height: 600, target: {} },
      isError: false,
    })
    expect(parsed.elements).toEqual([
      { index: 0, role: 'AXButton', label: 'Save', bounds: null },
      { index: 2, role: 'AXTextField', label: 'Name', bounds: null },
    ])
    expect(() =>
      parseCaptureResult({
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
        structuredContent: { mode: 'som', width: 1, height: 1, target: {}, elements: [] },
      }),
    ).toThrow('Host artifact normalization')
    expect(() =>
      parseCaptureResult({
        content: [{ type: 'image', data: '' }],
        structuredContent: { mode: 'som', width: 1, height: 1, target: {}, elements: [] },
      }),
    ).toThrow('Host artifact normalization')
    expect(() =>
      parseCaptureResult({
        images: 'not-an-array',
        structuredContent: { mode: 'som', width: 1, height: 1, target: {}, elements: [] },
      }),
    ).toThrow('driver images must be an array')
    expect(() =>
      parseCaptureResult({ mode: 'som', width: 1, height: 1, target: {}, elements: [], images: ['AAAA'] }),
    ).toThrow('Host artifact normalization')
  })

  it('rejects duplicate element indices in structured and text-fallback captures', () => {
    expect(() =>
      parseCaptureResult({
        mode: 'som',
        width: 1,
        height: 1,
        target: {},
        elements: [
          { index: 1, role: 'button', element_token: 'first' },
          { index: 1, role: 'button', element_token: 'second' },
        ],
      }),
    ).toThrow('capture element indices must be unique')
    expect(() =>
      parseCaptureResult({
        data: '[1] AXButton "First"\n[1] AXButton "Second"',
        structuredContent: { mode: 'ax', width: 1, height: 1, target: {} },
        isError: false,
      }),
    ).toThrow('capture element indices must be unique')
  })

  it('rejects a captured window identity without its process identity', () => {
    expect(() =>
      parseCaptureResult({
        mode: 'som',
        width: 1,
        height: 1,
        target: { window_id: 9 },
        elements: [],
      }),
    ).toThrow('capture target window_id requires pid')
  })

  it('does not let a null canonical structuredContent fall through to its snake alias', () => {
    expect(() =>
      parseCaptureResult({
        data: { mode: 'ax', width: 1, height: 1, target: {}, elements: [] },
        structuredContent: null,
        structured_content: { mode: 'som', width: 2, height: 2, target: {}, elements: [] },
      }),
    ).not.toThrow()
    expect(
      parseCaptureResult({
        data: { mode: 'ax', width: 1, height: 1, target: {}, elements: [] },
        structuredContent: null,
        structured_content: { mode: 'som', width: 2, height: 2, target: {}, elements: [] },
      }).mode,
    ).toBe('ax')
  })

  it('caps elements=100, text=40 lines, labels=120 and spills the complete tree', async () => {
    const long = 'x'.repeat(140)
    const elements = Array.from({ length: 105 }, (_, i) => ({
      index: i + 1,
      role: 'button',
      label: i === 0 ? long : `element-${i}`,
      bounds: [i, 2, 3, 4] as [number, number, number, number],
      elementToken: `opaque-${i}`,
    }))
    const ctx = fakeToolContext()
    const result = await captureToolResult(
      { mode: 'ax', width: 800, height: 600, elements, target: { app: 'Editor' } },
      ctx,
    )
    const structured = result.structured as Record<string, unknown>
    expect((structured.elements as unknown[]).length).toBe(100)
    expect((structured.elements as Array<{ label: string; label_truncated?: boolean }>)[0]).toEqual(
      expect.objectContaining({ label: 'x'.repeat(120), label_truncated: true }),
    )
    expect((result.content[0] as { text: string }).text.split('\n').length).toBeLessThanOrEqual(40)
    expect(structured.truncated_elements).toBe(5)
    expect(structured.elements_artifact).toMatchObject({ mime: 'application/json' })
    expect(ctx.calls.artifacts).toHaveLength(1)
    expect(new TextDecoder().decode(ctx.calls.artifacts[0]?.bytes)).not.toContain('element_token')
  })

  it('rejects malformed image refs, MIME mismatch, and unreliable safety shapes', () => {
    const base = {
      mode: 'som',
      width: 800,
      height: 600,
      target: {},
      elements: [],
    }
    expect(() =>
      parseCaptureResult({
        ...base,
        image: {
          ref: { sha256: 'not-a-digest', size: 3, mime: 'image/png' },
          mime: 'image/png',
          width: 10,
          height: 10,
          digest: 'a'.repeat(64),
        },
      }),
    ).toThrow('capture.image.ref is invalid')
    expect(() =>
      parseCaptureResult({
        ...base,
        image: {
          ref: { sha256: 'a'.repeat(64), size: 3, mime: 'image/jpeg' },
          mime: 'image/png',
          width: 10,
          height: 10,
          digest: 'b'.repeat(64),
        },
      }),
    ).toThrow('MIME')
    expect(() => parseCaptureResult({ ...base, safety: { reliable: 'yes', secureInput: true } })).toThrow(
      'capture.safety.reliable',
    )
    expect(() =>
      parseCaptureResult({
        ...base,
        safety: { reliable: true, secureInput: false, secure_input: true },
      }),
    ).toThrow('aliases disagree')
    expect(() => parseCaptureResult({ ...base, elements: [{ index: 1.5, role: 'button' }] })).toThrow(
      'non-negative integer',
    )
    expect(() => parseCaptureResult({ ...base, elements: [{ index: -1, role: 'button' }] })).toThrow(
      'non-negative integer',
    )
    expect(() =>
      parseCaptureResult({
        ...base,
        image: {
          ref: { sha256: 'a'.repeat(64), size: 3, mime: 'image/png' },
          mime: 'image/png',
          width: 10,
          height: 10,
          digest: 'not-a-sha256',
        },
      }),
    ).toThrow('capture.image.digest')
    expect(() =>
      parseCaptureResult({
        ...base,
        image: {
          ref: { sha256: 'a'.repeat(64), size: 3, mime: 'image/png' },
          mime: 'image/png',
          width: 10,
          height: 10,
          digest: 'b'.repeat(64),
        },
      }),
    ).toThrow('does not match its artifact reference')
    expect(() =>
      parseCaptureResult({
        ...base,
        image: {
          ref: { sha256: 'a'.repeat(64), size: 0, mime: 'image/png' },
          mime: 'image/png',
          width: 10,
          height: 10,
          digest: 'a'.repeat(64),
        },
      }),
    ).toThrow('must not be empty')
  })

  it('does not accept a backend result that forges the dispatched action or escalation', () => {
    expect(() => parseActionResult({ ok: true, action: 'capture' }, 'click')).toThrow('dispatched action')
    expect(() =>
      parseActionResult({ ok: false, action: 'click', escalation: { recommended: 'repeat' } }, 'click'),
    ).toThrow('action.escalation.recommended')
    expect(() => parseActionResult({ ok: false, action: 'click', effect: 'confirmed' }, 'click')).toThrow(
      'cannot be confirmed',
    )
    expect(() => parseActionResult({ ok: false, action: 'click', verified: true }, 'click')).toThrow(
      'cannot be confirmed',
    )
  })

  it('lifts action fields from structuredContent and derives ok from the MCP error flag', () => {
    expect(
      parseActionResult(
        {
          content: [{ type: 'text', text: 'delivered' }],
          structuredContent: { effect: 'unverifiable', verified: false, reason_code: 'NO_CONFIRM' },
          isError: false,
        },
        'click',
      ),
    ).toMatchObject({
      ok: true,
      action: 'click',
      message: 'delivered',
      effect: 'unverifiable',
      verified: false,
      code: 'NO_CONFIRM',
    })
  })

  it('requires fresh verification for unverifiable input even when the backend supplies an error code', () => {
    expect(
      actionVerdict({
        ok: false,
        action: 'click',
        effect: 'unverifiable',
        code: 'NO_CONFIRM',
        escalation: { recommended: 'foreground' },
      }),
    ).toEqual({
      decision: 'verify_fresh_state',
      hint: 'Input was delivered but not confirmed. Capture fresh state before any retry.',
    })
  })

  it('preserves confirmed/verified precedence and surfaces explicit px or foreground escalation', () => {
    expect(
      actionVerdict({
        ok: true,
        action: 'click',
        effect: 'confirmed',
        escalation: { recommended: 'foreground' },
      }),
    ).toEqual({ decision: 'done' })
    expect(
      actionVerdict({
        ok: true,
        action: 'click',
        verified: true,
        escalation: { recommended: 'px' },
      }),
    ).toEqual({ decision: 'done' })
    expect(
      actionVerdict({
        ok: true,
        action: 'click',
        escalation: { recommended: 'px', reason: 'background hit test missed' },
      }),
    ).toMatchObject({ decision: 'escalate', recommended: 'px' })
    expect(
      actionVerdict({
        ok: true,
        action: 'click',
        escalation: { recommended: 'foreground', reason: 'background unavailable' },
      }),
    ).toMatchObject({ decision: 'escalate', recommended: 'foreground' })
    expect(actionVerdict({ ok: false, action: 'click', effect: 'confirmed' })).toMatchObject({
      decision: 'escalate',
    })
    expect(actionVerdict({ ok: false, action: 'click', verified: true })).toMatchObject({
      decision: 'escalate',
    })
  })

  it('returns a confirmed launch target without exposing its opaque snapshot', () => {
    const result = actionToolResult({
      ok: true,
      action: 'launch_app',
      effect: 'confirmed',
      target: { app: 'mspaint.exe', pid: 30, windowId: 50, snapshotId: 'opaque' },
    })
    expect(result.structured).toMatchObject({
      ok: true,
      action: 'launch_app',
      target: { app: 'mspaint.exe', pid: 30, window_id: 50 },
    })
    expect(JSON.stringify(result)).not.toContain('opaque')
  })

  it('accepts structured and JSON-text listing envelopes without flattening their arrays', () => {
    expect(parseListingResult({ structuredContent: [{ name: 'Notes' }] }, 'apps')).toEqual([
      { name: 'Notes' },
    ])
    expect(
      parseListingResult({ content: [{ type: 'text', text: '[{"title":"Todo"}]' }] }, 'windows'),
    ).toEqual([{ title: 'Todo' }])
  })

  it('returns complete structured capture provenance without exposing opaque tokens', async () => {
    const ctx = fakeToolContext()
    const result = await captureToolResult(
      {
        mode: 'som',
        width: 100,
        height: 80,
        app: 'Notes',
        windowTitle: 'Todo',
        note: 'native coordinates',
        boundsScale: 2,
        target: { app: 'Notes', pid: 7, windowId: 9, snapshotId: 'opaque-snapshot' },
        elements: [],
        image: {
          ref: { sha256: 'a'.repeat(64), size: 20, mime: 'image/png' },
          mime: 'image/png',
          width: 100,
          height: 80,
          digest: 'a'.repeat(64),
        },
      },
      ctx,
    )
    expect(result.structured).toMatchObject({
      app: 'Notes',
      window_title: 'Todo',
      note: 'native coordinates',
      bounds_scale: 2,
      image: {
        artifact: { sha256: 'a'.repeat(64), size: 20, mime: 'image/png' },
        mime: 'image/png',
        width: 100,
        height: 80,
        digest: 'a'.repeat(64),
      },
    })
    expect(JSON.stringify(result)).not.toContain('opaque-snapshot')
  })
})
