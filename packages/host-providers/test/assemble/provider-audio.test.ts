import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENAI_AUDIO_WIRE_API, openAiAudioUnits, wavHeader } from '@agnes/ai'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { ModelRecord } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { buildProvider, PROVIDER_AUDIO_FACTS } from '../../src/assemble/provider.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

it('gives the voice payload facts of the AI package', () => {
  expect(PROVIDER_AUDIO_FACTS.wav).toBe(wavHeader)
  expect(PROVIDER_AUDIO_FACTS.units).toBe(openAiAudioUnits)
  expect(Object.isFrozen(PROVIDER_AUDIO_FACTS)).toBe(true)
})

it('assembles a provider that carries the voice payload facts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agnes-provider-audio-'))
  roots.push(home)
  const model: ModelRecord = {
    id: 'FunAudioLLM/SenseVoiceSmall',
    name: 'SenseVoiceSmall',
    api: OPENAI_AUDIO_WIRE_API,
    route: 'account-a',
    baseUrl: 'https://api.siliconflow.cn/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65_536,
    maxTokens: 4096,
    toolCallFormats: [],
    thinkingReplay: 'drop',
    contract_id: null,
    audioRole: 'transcribe',
  }
  const route = {
    route: model.route,
    api: model.api,
    baseUrl: model.baseUrl,
    credentialRef: 'secret://generic/00000000-0000-4000-8000-000000000000',
    models: [model],
  }
  const profile = {
    dataDir: join(home, 'data'),
    provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [route] },
    limits: {},
    adapters: { secrets: { kind: 'file', path: join(home, 'secrets') } },
  } as unknown as ResolvedProfile
  const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
  const built = await buildProvider(
    profile,
    { primary: { route: model.route, model: model.id } },
    { secrets: () => 'synthetic-key', clock: Date.now, log },
  )
  try {
    expect(built.provider.audio).toBe(PROVIDER_AUDIO_FACTS)
    expect(built.provider.models().find((m) => m.route === 'account-a')).toMatchObject({
      audioRole: 'transcribe',
    })
  } finally {
    await built.dispose()
  }
})
