import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeProvider, textTurn } from '@agnes/core/testkit'
import { createTestHost, runOnce } from '@agnes/host/testkit'
import type { RequestBody, RouteDecl } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { loadPrompt, operations, presets } from '../src/index.js'

const dirs: string[] = []
// createTestHost binds the production AI parser contract. Core's lower-level fakeProvider defaults
// to its own parser fixture, so Host integration cases must name the contract they are exercising.
const HOST_PARSER_VERSION = '2'
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
// The cwd and the other request-scoped facts no longer live in system: they are in the tail
// runtime-context message instead. This joins every user-role message's text so a test can still
// assert on the cwd without caring which message carries it.
function runtimeContextText(request: RequestBody): string {
  return request.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content)
    .map((c) => ('text' in c ? c.text : ''))
    .join('\n')
}
// The host reports the workspace in its canonical spelling, which on Windows expands an 8.3 short
// name such as the one a runner's temporary directory is reached through.
function scratch() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-prompt-host-')))
  dirs.push(dir)
  return dir
}
// A route declaring exactly one model, under whichever id the caller names. Two hosts built from
// two calls to this differ only in which model id core resolves ctx.model.model to; everything
// else about the route (its own name, the api, the base URL) stays the fixture's fixed shape.
function routeFor(modelId: string): RouteDecl {
  return {
    route: 'gw',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        route: 'gw',
        baseUrl: 'http://127.0.0.1:1/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        toolCallFormats: ['native'],
        thinkingReplay: 'native',
        contract_id: null,
      },
    ],
  }
}

const BASE_PACKAGE_DIR = fileURLToPath(new URL('../../base/', import.meta.url))
const CODE_PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))

// Drives one real turn through a freshly assembled host and hands back the one request its
// FakeProvider recorded. The session key is pinned explicitly rather than left to derive from cwd
// (host/src/session.ts's sessionKey() hashes cwd into it), because EnvironmentFacts.sessionKey
// renders straight into the persona-adjacent environment section: two hosts built from two
// different scratch directories would otherwise disagree on that one line for a reason that has
// nothing to do with the model or tool axis the two callers below are actually isolating.
async function runFixtureTurn(o: { dataDir: string; modelId: string }): Promise<RequestBody> {
  const provider = fakeProvider([textTurn('done')], HOST_PARSER_VERSION)
  const { host } = await createTestHost({
    dataDir: o.dataDir,
    provider,
    packageDirs: { '@agnes/base': BASE_PACKAGE_DIR },
    packages: { '@agnes/code': { operations } },
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [routeFor(o.modelId)] },
      },
    },
  })
  try {
    const session = await host.createSession({ cwd: o.dataDir, key: 'byte-identity-fixture' })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'hello' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
  } finally {
    await host.close()
  }
  expect(provider.requests).toHaveLength(1)
  const request = provider.requests[0]
  if (!request) throw new Error('provider received no request')
  return request
}

it('keeps the wire system string byte-identical across a real model switch', async () => {
  // Two hosts, same preset and session key, differing only in which model id the route
  // publishes. ctx.model.model is what used to be interpolated into persona before it moved to
  // runtimeContext, so this is the regression the move was for.
  const requestA = await runFixtureTurn({ dataDir: scratch(), modelId: 'model-alpha' })
  const requestB = await runFixtureTurn({ dataDir: scratch(), modelId: 'model-beta' })
  // The comparison below is only meaningful if the two runs actually resolved to different models;
  // otherwise a passing assertion would prove nothing about the model axis at all.
  expect(requestA.model).not.toBe(requestB.model)
  expect(requestA.system.length).toBeGreaterThan(500)
  expect(requestA.system).toBe(requestB.system)
  // The other axis (installing a tool-contributing extension) is host/test/assemble/plugin-extension.test.ts.
})

it.each(['standard', 'hybrid', 'code'] as const)(
  'sends the real prompt operation SDK only in the %s tier',
  async (disclosure) => {
    const dataDir = scratch()
    const provider = fakeProvider([textTurn('done')], HOST_PARSER_VERSION)
    const { host } = await createTestHost({
      dataDir,
      provider,
      packageDirs: {
        '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)),
        '@agnes/code': CODE_PACKAGE_DIR,
      },
      packages: { '@agnes/code': { operations } },
      // standard deliberately traverses the test host's actual default preset.
      ...(disclosure === 'standard'
        ? {}
        : {
            presets: {
              standard: {
                name: 'standard',
                extends: 'base',
                disclosure,
                model: { route: { primary: 'default' } },
              },
            },
          }),
    })
    try {
      expect(host.extensions().find((e) => e.id === 'agnes/code-mode')?.loaded).toBe(true)
      expect((await runOnce(host, { cwd: dataDir, prompt: 'hello' })).reason).toBe('completed')
      expect(provider.requests).toHaveLength(1)
      const request = provider.requests[0]
      if (!request) throw new Error('provider received no request')
      const names = request.tools.map((t) => t.name)
      expect(runtimeContextText(request)).toContain(JSON.stringify(dataDir).slice(1, -1))
      if (disclosure === 'standard') {
        expect(names).toContain('read')
        expect(names).not.toContain('run_code')
        expect(request.system).not.toContain('class tools:')
      } else {
        expect(names).toContain('run_code')
        if (disclosure === 'code') expect(names).toEqual(['run_code'])
        else expect(names).toContain('read')
        expect(request.system).toContain('class tools:')
        expect(request.system).toContain('async def read(')
        expect(request.system).not.toContain('async def run_code(')
      }
    } finally {
      await host.close()
    }
  },
)

it('does not advertise an SDK when hybrid has no loaded run_code', async () => {
  const dataDir = scratch()
  const provider = fakeProvider([textTurn('done')], HOST_PARSER_VERSION)
  const { host } = await createTestHost({
    dataDir,
    provider,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
    packages: { '@agnes/code': { operations } },
    presets: { standard: { name: 'standard', extends: 'base', disclosure: 'hybrid' } },
  })
  try {
    expect((await runOnce(host, { cwd: dataDir, prompt: 'hello' })).reason).toBe('completed')
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]?.system).not.toContain('class tools:')
    expect(provider.requests[0]?.tools.map((t) => t.name)).toContain('read')
  } finally {
    await host.close()
  }
})

it.each(['standard', 'channel', 'minimal-rl'])(
  'honors the shipped %s prompt declaration through Host resolution',
  async (preset) => {
    const dataDir = scratch()
    const provider = fakeProvider([textTurn('done')], HOST_PARSER_VERSION)
    const { host } = await createTestHost({
      dataDir,
      provider,
      packages: { '@agnes/code': { operations, presets } },
      profileInputs: {
        user: { name: 'prompt-declaration', presets: { default: preset, allowed: [preset] } },
      },
    })
    try {
      expect((await runOnce(host, { cwd: dataDir, prompt: 'hello' })).reason).toBe('completed')
      expect(provider.requests).toHaveLength(1)
      const request = provider.requests[0]
      if (!request) throw new Error('provider received no request')
      const system = request.system
      if (preset === 'minimal-rl') {
        expect(runtimeContextText(request)).not.toContain(JSON.stringify(dataDir).slice(1, -1))
        expect(system).not.toContain(loadPrompt('coding-doctrine'))
        expect(system).not.toContain('You have no tools on this request')
      } else {
        expect(runtimeContextText(request)).toContain(JSON.stringify(dataDir).slice(1, -1))
        expect(system).toContain(loadPrompt('coding-doctrine'))
      }
      if (preset === 'channel') expect(system).toContain(loadPrompt('channel-style'))
      else expect(system).not.toContain(loadPrompt('channel-style'))
    } finally {
      await host.close()
    }
  },
)

it('an inherited explicit declaration filters out unrequested code sections', async () => {
  const dataDir = scratch()
  const provider = fakeProvider([textTurn('done')], HOST_PARSER_VERSION)
  const { host } = await createTestHost({
    dataDir,
    provider,
    packages: {
      '@agnes/code': {
        operations,
        presets: {
          ...presets,
          selected: { name: 'selected', extends: 'channel', model: { prompt_sections: ['channel-style'] } },
        },
      },
    },
    profileInputs: {
      user: { name: 'prompt-selection', presets: { default: 'selected', allowed: ['selected'] } },
    },
  })
  try {
    expect((await runOnce(host, { cwd: dataDir, prompt: 'hello' })).reason).toBe('completed')
    expect(provider.requests).toHaveLength(1)
    const system = provider.requests[0]?.system
    expect(system).toContain(loadPrompt('channel-style'))
    expect(system).not.toContain(dataDir)
    expect(system).not.toContain(loadPrompt('coding-doctrine'))
  } finally {
    await host.close()
  }
})
