import type { InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { PARSER_VERSION } from '../src/index.js'
import { fakeModel, fakeRequest, RecordingProvider, ScriptedProvider, stampFor } from '../testkit/index.js'

async function collect(it: AsyncIterable<InferenceEvent>) {
  const out: InferenceEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const sig = () => new AbortController().signal
const run = () => ({ signal: sig(), toolNames: [] })

describe('ScriptedProvider', () => {
  it('plays scripts in order, auto-prepends sent, and repeats the last by default', async () => {
    const p = new ScriptedProvider({
      scripts: [
        [
          { type: 'text_delta', delta: 'a' },
          {
            type: 'usage',
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            creditSource: 'estimated',
          },
          { type: 'done', reason: 'stop' },
        ],
        [
          {
            type: 'error',
            reason: 'error',
            code: 'RATE_LIMIT',
            message: '429',
            retryable: true,
            retryAfterMs: 10,
          },
        ],
      ],
    })
    const a = await collect(p.infer(fakeRequest(), run()))
    expect(a.map((e) => e.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
    const b = await collect(p.infer(fakeRequest(), run()))
    expect(b.map((e) => e.type)).toEqual(['sent', 'error'])
    const c = await collect(p.infer(fakeRequest(), run()))
    expect(c.map((e) => e.type)).toEqual(['sent', 'error'])
    expect(p.calls).toHaveLength(3)
  })

  // A test that needs the run after the scripted ones to fail rather than replay says so, and gets
  // a failure that is recognisably the harness running out of script.
  it('ends an exhausted script with an error when asked to', async () => {
    const p = new ScriptedProvider({ scripts: [[{ type: 'done', reason: 'stop' }]], onExhausted: 'error' })
    await collect(p.infer(fakeRequest(), run()))
    const after = await collect(p.infer(fakeRequest(), run()))
    expect(after.map((e) => e.type)).toEqual(['sent', 'error'])
    expect(after[1]).toMatchObject({ type: 'error', code: 'TRANSPORT', retryable: false })
  })

  // A stamp is prepended only when the script did not open with one, so a test that needs a
  // particular stamp can write it and see exactly that.
  it('leaves a script that opens with its own sent alone', async () => {
    const stamp = { ...stampFor(fakeRequest()), parser_version: 'written-by-the-test' }
    const p = new ScriptedProvider({
      scripts: [
        [
          { type: 'sent', stamp },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const events = await collect(p.infer(fakeRequest(), run()))
    expect(events.map((e) => e.type)).toEqual(['sent', 'done'])
    expect(events[0]).toEqual({ type: 'sent', stamp })
  })

  it('honours abort mid-stream', async () => {
    const ac = new AbortController()
    const p = new ScriptedProvider({
      scripts: [
        () => [
          { type: 'text_delta', delta: 'a' },
          { type: 'text_delta', delta: 'b' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const out: InferenceEvent[] = []
    for await (const e of p.infer(fakeRequest(), { signal: ac.signal, toolNames: [] })) {
      out.push(e)
      if (e.type === 'text_delta') ac.abort()
    }
    expect(out.at(-1)).toMatchObject({ type: 'error', reason: 'aborted', code: 'ABORTED' })
    expect(out.map((e) => e.type)).toEqual(['sent', 'text_delta', 'error'])
  })

  it('stops at the first terminal event in a script, ignoring what follows it', async () => {
    const p = new ScriptedProvider({
      scripts: [
        [
          { type: 'done', reason: 'stop' },
          { type: 'text_delta', delta: 'ghost' },
        ],
      ],
    })
    expect((await collect(p.infer(fakeRequest(), run()))).map((e) => e.type)).toEqual(['sent', 'done'])
  })

  it('function scripts see the request and the call index', async () => {
    const p = new ScriptedProvider({
      scripts: [
        (req, n) => [
          { type: 'text_delta', delta: `${req.model}#${n}` },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const a = await collect(p.infer(fakeRequest({ model: 'flash' }), run()))
    expect(a[1]).toEqual({ type: 'text_delta', delta: 'flash#0' })
    // the index counts runs, not scripts, so a repeated script still knows which run this is
    const b = await collect(p.infer(fakeRequest({ model: 'pro' }), run()))
    expect(b[1]).toEqual({ type: 'text_delta', delta: 'pro#1' })
  })

  // Repeating means replaying the last script as written, whatever it was: a test that needs the
  // model to keep answering the same way past the end of the script gets exactly that.
  it('replays the last script unchanged once the written ones run out', async () => {
    const p = new ScriptedProvider({
      scripts: [
        [
          { type: 'text_delta', delta: 'first' },
          { type: 'done', reason: 'stop' },
        ],
        [
          { type: 'text_delta', delta: 'last' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    await collect(p.infer(fakeRequest(), run()))
    await collect(p.infer(fakeRequest(), run()))
    const third = await collect(p.infer(fakeRequest(), run()))
    expect(third.map((e) => e.type)).toEqual(['sent', 'text_delta', 'done'])
    expect(third[1]).toEqual({ type: 'text_delta', delta: 'last' })
  })

  it('records every request it was handed, in order, including the exhausted ones', async () => {
    const p = new ScriptedProvider({ scripts: [[{ type: 'done', reason: 'stop' }]] })
    await collect(p.infer(fakeRequest({ model: 'first' }), run()))
    await collect(p.infer(fakeRequest({ model: 'second' }), run()))
    expect(p.calls.map((c) => c.model)).toEqual(['first', 'second'])
  })

  it('projects the models it was given, and one placeholder model when it was given none', () => {
    expect(new ScriptedProvider({ scripts: [] }).models().map((m) => m.id)).toEqual(['faux-1'])
    const listed = new ScriptedProvider({
      models: [fakeModel({ id: 'given', route: 'faux' })],
      scripts: [],
    })
    expect(listed.models().map((m) => m.id)).toEqual(['given'])
  })

  // The stamp a faux run emits is derived from the request, so two runs of the same request stamp
  // alike and a different tool disclosure stamps differently — otherwise a test asserting on a
  // stamp would be asserting on a constant.
  it('stamps a faux run from the request it was given', async () => {
    const p = new ScriptedProvider({ scripts: [[{ type: 'done', reason: 'stop' }]] })
    const plain = await collect(p.infer(fakeRequest({ route: 'gw', model: 'flash' }), run()))
    const withTool = await collect(
      p.infer(fakeRequest({ tools: [{ name: 'read', description: 'r', parameters: {} }] }), run()),
    )
    const stampOf = (e: InferenceEvent[]) => (e[0] as Extract<InferenceEvent, { type: 'sent' }>).stamp
    expect(stampOf(plain).model).toEqual({ route: 'gw', id: 'flash' })
    expect(stampOf(withTool).model).toEqual({ route: 'faux', id: 'faux-1' })
    expect(stampOf(plain).tool_schema_hash).not.toBe(stampOf(withTool).tool_schema_hash)
    expect(stampOf(plain).contract_id).toBeNull()
    expect(stampOf(plain).derived_hash).toBe(fakeRequest().derivedHash)
    expect(stampOf(plain).parser_version).toBe(PARSER_VERSION)
  })

  it('can pin a non-default parser contract for mismatch tests', async () => {
    const p = new ScriptedProvider({
      parserVersion: 'fixture-parser',
      scripts: [[{ type: 'done', reason: 'stop' }]],
    })
    const events = await collect(p.infer(fakeRequest(), run()))

    expect(events[0]).toMatchObject({ type: 'sent', stamp: { parser_version: 'fixture-parser' } })
    expect(stampFor(fakeRequest(), 'fixture-parser').parser_version).toBe('fixture-parser')
  })
})

describe('fakeRequest', () => {
  it('is a complete request that overrides apply on top of', () => {
    expect(fakeRequest()).toMatchObject({
      kind: 'inference',
      slot: 'primary',
      route: 'faux',
      model: 'faux-1',
    })
    expect(fakeRequest({ slot: 'fast', model: 'other' })).toMatchObject({ slot: 'fast', model: 'other' })
    expect(fakeRequest().derivedHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('RecordingProvider', () => {
  it('records requests and events and dumps JSONL', async () => {
    const inner = new ScriptedProvider({ scripts: [[{ type: 'done', reason: 'stop' }]] })
    const rec = new RecordingProvider(inner)
    await collect(rec.infer(fakeRequest(), run()))
    expect(rec.records).toHaveLength(1)
    expect(rec.dump().split('\n').filter(Boolean)).toHaveLength(1)
    expect(JSON.parse(rec.dump()).events.map((e: InferenceEvent) => e.type)).toEqual(['sent', 'done'])
  })

  // One line per run, so a fixture file of several runs replays in the order they happened.
  it('dumps one parseable line per recorded run', async () => {
    const inner = new ScriptedProvider({
      scripts: [
        [{ type: 'done', reason: 'stop' }],
        [{ type: 'error', reason: 'error', code: 'AUTH', message: '401', retryable: false }],
      ],
    })
    const rec = new RecordingProvider(inner)
    await collect(rec.infer(fakeRequest({ model: 'first' }), run()))
    await collect(rec.infer(fakeRequest({ model: 'second' }), run()))
    const lines = rec
      .dump()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.req.model)).toEqual(['first', 'second'])
    expect(lines.map((l) => l.events.at(-1).type)).toEqual(['done', 'error'])
  })

  it('passes the events through unchanged as it records them', async () => {
    const script: InferenceEvent[] = [
      { type: 'text_delta', delta: 'a' },
      { type: 'done', reason: 'stop' },
    ]
    const rec = new RecordingProvider(new ScriptedProvider({ scripts: [script] }))
    const seen = await collect(rec.infer(fakeRequest(), run()))
    expect(seen.slice(1)).toEqual(script)
    expect(rec.records[0]?.events).toEqual(seen)
  })

  // The recorder is a wrapper, so what it says it can do is whatever the provider underneath can do.
  it('projects the wrapped provider models', () => {
    const inner = new ScriptedProvider({ models: [fakeModel({ id: 'inner', route: 'faux' })], scripts: [] })
    expect(new RecordingProvider(inner).models().map((m) => m.id)).toEqual(['inner'])
  })

  // A run that is still in flight is already in the record, so a test that inspects the recorder
  // after an abort sees the partial run rather than nothing at all.
  it('keeps the partial record of a run that was abandoned mid-stream', async () => {
    const inner = new ScriptedProvider({
      scripts: [
        [
          { type: 'text_delta', delta: 'a' },
          { type: 'text_delta', delta: 'b' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const rec = new RecordingProvider(inner)
    for await (const e of rec.infer(fakeRequest(), run())) if (e.type === 'text_delta') break
    expect(rec.records).toHaveLength(1)
    expect(rec.records[0]?.events.map((e) => e.type)).toEqual(['sent', 'text_delta'])
  })
})
