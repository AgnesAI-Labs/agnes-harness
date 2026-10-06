import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EffectResult } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import type { ModelWireFetch } from '../../src/runtime/model-adapter/ports.js'
import { modelFixture } from './model-fixture.js'

type Refusal = { code: string; detailCode: string }
const refusal: Refusal = { code: 'denied', detailCode: 'model_egress_network' }
const sse = (lines: string[]) =>
  new Response(lines.map((line) => `data: ${line}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
const completion = (text = 'hi') =>
  sse([
    JSON.stringify({
      id: 'c',
      model: 'm',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }),
    JSON.stringify({ id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ])

/**
 * A fake egress. `evidence` lists what it provides; `bytes` says whether it commits its fence (the
 * bytes may leave) before it fails; `fail` makes the fetch reject instead of answering.
 */
function egress(options: {
  fenced?: 'owned' | 'absent'
  refusal?: Refusal | 'absent' | 'throws'
  bytes: boolean
  fail: boolean
  /** Answers with more output than one result may hold, which throws inside the adapter. */
  flood?: boolean
}) {
  let fenced = false
  const fetch: ModelWireFetch = async () => {
    if (options.bytes) fenced = true
    if (options.fail) throw new Error('egress failure')
    return completion(options.flood ? 'x'.repeat(2_000_000) : 'hi')
  }
  if (options.fenced === 'owned') fetch.fenced = () => fenced
  if (options.refusal && options.refusal !== 'absent')
    fetch.refusal = () => {
      if (options.refusal === 'throws') throw new Error('refusal unreadable')
      return options.refusal as Refusal
    }
  return fetch
}

async function run(port: ModelWireFetch, rejectOwnFence = false) {
  const directory = mkdtempSync(join(tmpdir(), 'model-evidence-'))
  const journal = join(directory, 'r.json')
  const fixture = await modelFixture('openai-completions', 'http://127.0.0.1:9/v1', journal)
  fixture.egress(port)
  if (rejectOwnFence) fixture.reject()
  try {
    const effect = await fixture.action.execute(fixture.frame, fixture.call)
    // The fixture store writes this file only when the adapter saves.
    const saves = existsSync(journal)
      ? [(JSON.parse(readFileSync(journal, 'utf8')) as { result: EffectResult }).result]
      : []
    return { effect, saves, sends: fixture.sends() }
  } finally {
    await fixture.provider.close('shutdown')
    rmSync(directory, { recursive: true, force: true })
  }
}

const unknown = {
  outcome: 'unknown_effect',
  error: { code: 'unknown_effect', detailCode: 'model_stream_unknown' },
}
const proven = {
  outcome: 'failed',
  error: { code: 'denied', detailCode: 'model_egress_network', retryAdvice: { kind: 'never' } },
  externalRequests: [],
  usage: [],
}

describe('egress not-sent evidence', () => {
  for (const after of [undefined, 'quota'] as const) {
    const fail = (
      options: Parameters<typeof egress>[0] extends infer O ? Omit<O & object, 'fail' | 'flood'> : never,
    ) => egress({ ...options, fail: !after, flood: Boolean(after) })
    describe(after ? 'failure thrown inside the adapter' : 'egress failure', () => {
      it('fenced false with a refusal is a proven not-sent: definite failure, nothing saved', async () => {
        const { effect, saves, sends } = await run(fail({ fenced: 'owned', refusal, bytes: false }))
        expect(effect).toMatchObject(proven)
        expect(saves).toEqual([])
        expect(sends).toBe(0)
      })
      for (const [name, port] of [
        ['fenced true with a refusal', fail({ fenced: 'owned', refusal, bytes: true })],
        ['fenced true without a refusal', fail({ fenced: 'owned', bytes: true })],
      ] as const)
        it(`${name} stays unknown with a saved result`, async () => {
          const { effect, saves, sends } = await run(port)
          expect(effect).toMatchObject(unknown)
          expect(effect.externalRequests).toHaveLength(1)
          expect(saves).toHaveLength(1)
          expect(sends).toBe(0)
        })
      it('fenced false without a refusal is the adapter default for not sent, never a new claim', async () => {
        const { effect, saves } = await run(fail({ fenced: 'owned', bytes: false }))
        expect(effect).toMatchObject({
          outcome: after ? 'cancelled' : 'failed',
          error: { detailCode: after ? 'model_send_refused' : 'model_not_sent' },
          externalRequests: [],
          usage: [],
        })
        expect(saves).toEqual([])
      })
      for (const evidence of ['throws', { code: 'denied', detailCode: 'Not Valid!' }] as const)
        it(`an unusable refusal (${typeof evidence === 'string' ? evidence : 'bad detail'}) proves nothing`, async () => {
          const { effect } = await run(fail({ fenced: 'owned', refusal: evidence, bytes: false }))
          expect(effect.error?.detailCode).toBe(after ? 'model_send_refused' : 'model_not_sent')
        })
    })
  }

  it("a refusal without fenced is ignored: the adapter fence and today's result apply", async () => {
    const { effect, saves, sends } = await run(egress({ refusal, bytes: false, fail: true }))
    expect(effect).toMatchObject(unknown)
    expect(saves).toHaveLength(1)
    expect(sends).toBe(1)
  })

  it('a refusal without fenced never proves anything, even when the adapter fence itself refused', async () => {
    const { effect, saves } = await run(egress({ refusal, bytes: false, fail: true }), true)
    expect(effect).toMatchObject({
      outcome: 'failed',
      error: { detailCode: 'model_not_sent' },
      externalRequests: [],
    })
    expect(saves).toEqual([])
  })

  it('an answer that arrived counts as sent even when the egress reports an unset fence', async () => {
    const { effect, saves } = await run(egress({ fenced: 'owned', refusal, bytes: false, fail: false }))
    expect(effect.outcome).toBe('succeeded')
    expect(saves).toHaveLength(1)
  })

  it('a fence answer that is not a plain false counts as possibly sent', async () => {
    for (const odd of [undefined, 0, 'no', null]) {
      const port = egress({ fenced: 'owned', refusal, bytes: false, fail: true })
      port.fenced = () => odd as never
      const { effect, saves } = await run(port)
      expect(effect).toMatchObject(unknown)
      expect(saves).toHaveLength(1)
    }
  })

  it('absent fields behave exactly as before: own fence, unknown, saved', async () => {
    const plain = await run(egress({ bytes: false, fail: true }))
    const bare = await run((async () => {
      throw new Error('egress failure')
    }) as ModelWireFetch)
    expect(plain.effect).toMatchObject(unknown)
    const stable = (effect: EffectResult) =>
      JSON.parse(JSON.stringify(effect).replace(/"observedAt":"[^"]*"/g, '"observedAt":"-"'))
    expect(stable(plain.effect)).toEqual(stable(bare.effect))
    expect(plain.saves).toHaveLength(1)
    expect(plain.sends).toBe(1)
  })

  it('maps a retryable refusal to a retry advice and an unknown code to internal', async () => {
    const retry = await run(
      egress({
        fenced: 'owned',
        refusal: { code: 'retryable', detailCode: 'model_egress_connect' },
        bytes: false,
        fail: true,
      }),
    )
    expect(retry.effect).toMatchObject({
      outcome: 'failed',
      error: {
        code: 'retryable',
        detailCode: 'model_egress_connect',
        retryAdvice: { kind: 'retry_same_action' },
      },
    })
    const odd = await run(
      egress({
        fenced: 'owned',
        refusal: { code: 'unknown_effect', detailCode: 'x' },
        bytes: false,
        fail: true,
      }),
    )
    expect(odd.effect).toMatchObject({ outcome: 'failed', error: { code: 'internal', detailCode: 'x' } })
  })

  it('an owned fence that throws counts as possibly sent', async () => {
    const port = egress({ fenced: 'owned', refusal, bytes: false, fail: true })
    port.fenced = () => {
      throw new Error('unreadable')
    }
    const { effect, saves } = await run(port)
    expect(effect).toMatchObject(unknown)
    expect(saves).toHaveLength(1)
  })

  it('a successful call with an owned fence succeeds and saves without the adapter fencing', async () => {
    const { effect, saves, sends } = await run(egress({ fenced: 'owned', bytes: true, fail: false }))
    expect(effect.outcome).toBe('succeeded')
    expect(saves).toHaveLength(1)
    expect(sends).toBe(0)
  })
})
