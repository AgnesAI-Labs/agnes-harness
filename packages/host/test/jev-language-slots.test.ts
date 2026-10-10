import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { readPreset, scanAll } from '@agnes/core'
import { actor, fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import type { JsonValue, RuntimeRecord } from '@agnes/jev-runtime'
import type { Provider, RequestBody } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { jevLanguageSlots } from '../src/runtime/jev-language-slots.js'
import type { JevLoopOptions } from '../src/runtime/jev-loop.js'
import { createTestHost } from '../testkit/index.js'

const signal = () => new AbortController().signal

it('reads jev_language_slots from a preset document and falls back to primary', () => {
  const view = readPreset(
    {
      model: {
        route: { primary: 'gw' },
        jev_language_slots: { parameters: 'fast', arbitration: 'escalation' },
      },
    },
    'stages',
  )
  expect(view.model.jevLanguageSlots).toEqual({ parameters: 'fast', arbitration: 'escalation' })
  expect(jevLanguageSlots(view)).toEqual({
    parameters: 'fast',
    arbitration: 'escalation',
    answer: 'primary',
  })
  expect(jevLanguageSlots(readPreset({ model: { route: { primary: 'gw' } } }, 'plain'))).toEqual({
    parameters: 'primary',
    arbitration: 'primary',
    answer: 'primary',
  })
  // The view types slot names loosely; a name outside the closed set must not reach resolveModel.
  expect(
    jevLanguageSlots(
      readPreset(
        { model: { route: { primary: 'gw' }, jev_language_slots: { answer: 'fictional' } } },
        'broken',
      ),
    ),
  ).toEqual({ parameters: 'primary', arbitration: 'primary', answer: 'primary' })
})

/**
 * Decision script mirroring the proven runtime-loop flow: INSPECT (read candidate, direct) →
 * ACT write via LLM_PARAMETERS (the parameters stage) → RESPOND (the answer stage). A low purpose
 * confidence fails the C-gate and escalates to arbitration instead.
 */
function stageJev(purposeConfidence = 1): JevLoopOptions {
  let decision = 0
  return {
    decision: {
      backend: 'jev',
      endpoint: 'https://jev.invalid/v1',
      model: 'jev-test',
      transport: {
        async invoke({ questions }) {
          const step = decision++
          const answers: Record<string, JsonValue> = {}
          for (const [name, value] of Object.entries(questions)) {
            const criteria = (value as { criteria?: Record<string, unknown> }).criteria
            if (!criteria) continue
            let selected: string | undefined
            const phase = step % 3
            if (name === 'purpose') selected = ['INSPECT', 'ACT', 'RESPOND'][phase]
            else if (name.startsWith('operation_'))
              selected =
                name === 'operation_ACT' ? 'write' : name === 'operation_RESPOND' ? 'RESPOND' : 'read'
            else if (name === 'binding_write') selected = 'LLM_PARAMETERS'
            else if (name === 'binding_read')
              selected =
                Object.keys(criteria).find(
                  (key) => key !== 'LLM_PARAMETERS' && String(criteria[key]).includes('a.txt'),
                ) ?? 'LLM_PARAMETERS'
            else continue
            const confidence = name === 'purpose' ? purposeConfidence : 1
            const choices = Object.keys(criteria)
            answers[name] = {
              type: 'choice',
              choice: selected as string,
              confidence,
              probabilities: Object.fromEntries(
                choices.map((key) => [
                  key,
                  choices.length === 1
                    ? 1
                    : key === selected
                      ? confidence
                      : (1 - confidence) / (choices.length - 1),
                ]),
              ),
            }
          }
          return { output: { answers }, observedModel: 'jev-test' }
        },
      },
    },
  }
}

async function runStages(jev: JevLoopOptions) {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-stages-'))
  await mkdir(join(root, 'child'))
  await writeFile(join(root, 'a.txt'), 'seed evidence')
  const models = [
    fakeModel({ route: 'gw', id: 'answer-model' }),
    fakeModel({ route: 'gw', id: 'param-model' }),
    fakeModel({ route: 'gw', id: 'arb-model', reasoning: true, thinkingLevelMap: { high: 'high' } }),
    fakeModel({ route: 'gw', id: 'rebound-model' }),
  ]
  // Each turn spends two language calls (parameters write, then the answer); two turns fit exactly.
  const provider = Object.assign(
    fakeProvider(
      [
        toolTurn('write', { path: 'child/result.txt', content: 'written\n' }),
        textTurn('DONE'),
        toolTurn('write', { path: 'child/result.txt', content: 'written\n' }),
        textTurn('DONE'),
      ],
      '2',
    ),
    { models: () => models },
  )
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models }],
        },
      },
    },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
    disableSessionTitle: true,
    approval: async () => 'allowed-once',
    jev,
    // Overriding the default recipe keeps the assembled route table and the session's preset in
    // agreement (checkPresetHardRequirements), while binding the language stages to slots.
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        model: {
          route: { primary: 'gw', fast: 'gw', escalation: 'gw' },
          id: { primary: 'answer-model', fast: 'param-model', escalation: 'arb-model' },
          jev_language_slots: { parameters: 'fast', arbitration: 'escalation', answer: 'primary' },
        },
      },
    },
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    return { session, provider, host, root }
  } catch (error) {
    await host.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

it('routes each Jev language stage through its preset-bound slot and follows slot switches', async () => {
  const { session, provider, host, root } = await runStages(stageJev())
  try {
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Write the marker file' }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: signal() })
    expect(outcome.reason).toBe('completed')
    const requests = provider.requests as RequestBody[]
    expect(requests.map((request) => [request.slot, request.model])).toEqual([
      ['fast', 'param-model'],
      ['primary', 'answer-model'],
    ])
    // An authorized switch on the fast slot moves only the parameters stage.
    await session.setModel({ slot: 'fast', route: 'gw', model: 'rebound-model' })
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Write it again' }],
    })
    const second = await session.run({ until: 'turn-end', signal: signal() })
    expect(second.reason).toBe('completed')
    expect(
      (provider.requests as RequestBody[]).slice(2).map((request) => [request.slot, request.model]),
    ).toEqual([
      ['fast', 'rebound-model'],
      ['primary', 'answer-model'],
    ])
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('escalates a failed purpose gate to the arbitration slot with its own thinking level', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-arb-'))
  const models = [
    fakeModel({ route: 'gw', id: 'answer-model' }),
    fakeModel({ route: 'gw', id: 'arb-model', reasoning: true, thinkingLevelMap: { high: 'high' } }),
  ]
  const provider = Object.assign(fakeProvider([textTurn('ARBITRATED')], '2'), {
    models: () => models,
  })
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models }],
        },
      },
    },
    disableSessionTitle: true,
    jev: stageJev(0.3),
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        model: {
          route: { primary: 'gw', escalation: 'gw' },
          id: { primary: 'answer-model', escalation: 'arb-model' },
          thinking: { escalation: 'high' },
          jev_language_slots: { arbitration: 'escalation' },
        },
      },
    },
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Do the thing' }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: signal() })
    expect(outcome.reason).toBe('completed')
    const requests = provider.requests as RequestBody[]
    expect(requests.map((request) => [request.slot, request.model, request.sampling?.thinking])).toEqual([
      ['escalation', 'arb-model', 'high'],
    ])
    const rows = (
      await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
    ).map((row) => row.data as unknown as { record: RuntimeRecord })
    expect(
      rows.some((row) => row.record.kind === 'model.requested' && row.record.call.purpose === 'arbitration'),
    ).toBe(true)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('honors a session stage binding over the preset slot and restores it on reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-bind-'))
  const models = [
    fakeModel({ route: 'gw', id: 'answer-model' }),
    fakeModel({
      route: 'gw',
      id: 'param-model',
      reasoning: true,
      thinkingLevelMap: { off: 'off', high: 'high' },
    }),
    fakeModel({
      route: 'gw',
      id: 'arb-model',
      reasoning: true,
      thinkingLevelMap: { off: 'off', high: 'high' },
    }),
  ]
  const provider = Object.assign(fakeProvider([textTurn('ARBITRATED')], '2'), {
    models: () => models,
  })
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models }],
        },
      },
    },
    disableSessionTitle: true,
    jev: stageJev(0.3),
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        model: {
          route: { primary: 'gw', escalation: 'gw' },
          id: { primary: 'answer-model', escalation: 'arb-model' },
          thinking: { escalation: 'high' },
          jev_language_slots: { arbitration: 'escalation' },
        },
      },
    },
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    // The binding wins over the escalation slot's arb-model/high for the arbitration stage…
    await session.setJevStages({
      stages: { arbitration: { route: 'gw', model: 'param-model', thinking: 'off' } },
    })
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Do the thing' }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: signal() })
    expect(outcome.reason).toBe('completed')
    const requests = provider.requests as RequestBody[]
    expect(requests.map((request) => [request.slot, request.model, request.sampling?.thinking])).toEqual([
      ['escalation', 'param-model', 'off'],
    ])
    // …and clearing it falls back to the preset slot resolution.
    await session.setJevStages({ stages: { arbitration: null } })
    expect(session.preset.model.jevStageBindings).toBeUndefined()
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Once more' }],
    })
    const second = await session.run({ until: 'turn-end', signal: signal() })
    expect(second.reason).toBe('completed')
    expect(
      (provider.requests as RequestBody[]).slice(1).map((r) => [r.slot, r.model, r.sampling?.thinking]),
    ).toEqual([['escalation', 'arb-model', 'high']])
    // An unknown route/model is refused before any write.
    await expect(
      session.setJevStages({ stages: { answer: { route: 'gw', model: 'fictional' } } }),
    ).rejects.toMatchObject({ code: 'E_MODEL_UNKNOWN' })
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
