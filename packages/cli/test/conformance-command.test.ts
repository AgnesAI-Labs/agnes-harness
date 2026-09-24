import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createProvider, NullContractStore } from '@agnes/ai'
import { FakeAdapter, fakeModel } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import { conformanceGateway } from '../src/commands/conformance.js'
import { TEST_LOCK } from './boot-host.js'

const cleanup: string[] = []

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deps(adapter: FakeAdapter): LocalBootDeps {
  const home = mkdtempSync(join(tmpdir(), 'agnes-conformance-command-'))
  cleanup.push(home)
  return {
    env: {},
    home,
    cwd: home,
    agnesVersion: '0',
    log: () => undefined,
    lock: TEST_LOCK,
    createHostImpl: async () =>
      (
        await createTestHost({
          dataDir: home,
          profileInputs: {
            user: {
              name: 'local-dev',
              provider: {
                package: '@agnes/ai',
                adapters: ['@agnes/ai'],
                routes: [
                  {
                    route: 'agnes-gateway',
                    api: 'openai-completions',
                    baseUrl: 'https://gateway.invalid',
                    models: [
                      fakeModel({
                        id: 'm',
                        route: 'agnes-gateway',
                        api: 'openai-completions',
                        baseUrl: 'https://gateway.invalid',
                      }),
                    ],
                  },
                ],
              },
            },
          },
          provider: createProvider({
            adapters: [adapter],
            routes: { primary: { route: 'agnes-gateway', model: 'm' } },
            contract: new NullContractStore(),
            secrets: () => '',
            clock: () => 0,
          }),
        })
      ).host,
  }
}

function gateway(): FakeAdapter {
  const route = {
    route: 'agnes-gateway',
    api: 'openai-completions' as const,
    baseUrl: 'https://gateway.invalid',
  }
  return new FakeAdapter({
    id: 'gateway',
    routes: [route],
    models: { 'agnes-gateway': [fakeModel({ id: 'm', ...route })] },
    script: () => [
      { type: 'text_delta', delta: 'ok' },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ],
  })
}

describe('conformance gateway command', () => {
  it('is dispatched by the executable and preserves the failing matrix exit code', async () => {
    const commandDeps = deps(gateway())
    const stdout = new PassThrough()
    let output = ''
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const io: MainIO = {
      env: { AGH_HOME: commandDeps.home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout,
      stderr: new PassThrough(),
      cwd: commandDeps.cwd,
      agnesVersion: '0',
    }

    await expect(
      main(['conformance', 'gateway', '--json'], io, {
        lock: TEST_LOCK,
        createHostImpl: commandDeps.createHostImpl as NonNullable<LocalBootDeps['createHostImpl']>,
      }),
    ).resolves.toBe(1)
    expect(JSON.parse(output)).toMatchObject({ total: 8 })
  })

  it('runs the protocol-specific eight-scenario matrix and fails on scenario mismatches', async () => {
    const result = await conformanceGateway(parseArgs(['conformance', 'gateway', '--json']), deps(gateway()))

    expect(result.exitCode).toBe(1)
    const report = JSON.parse(result.text) as { total: number; results: Array<{ protocol: string }> }
    expect(report.total).toBe(8)
    expect(report.results).toHaveLength(8)
    expect(report.results.every((row) => row.protocol === 'openai-completions')).toBe(true)
  })

  it('fails closed before streaming when the assembled gateway route is absent', async () => {
    const adapter = gateway()
    const result = await conformanceGateway(
      parseArgs(['conformance', 'gateway', '--model', 'primary=other/m']),
      deps(adapter),
    )

    expect(result).toEqual({
      text: 'gateway conformance unavailable: route other is not assembled',
      exitCode: 1,
    })
    expect(adapter.calls).toEqual([])
  })

  it('rejects every command shape other than the gateway subcommand', async () => {
    await expect(conformanceGateway(parseArgs(['conformance']), deps(gateway()))).rejects.toThrow(
      /conformance gateway/,
    )
  })
})
