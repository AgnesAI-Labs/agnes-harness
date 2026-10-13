import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createProvider, NullContractStore } from '@agnes/ai'
import { FakeAdapter, fakeModel } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import { TEST_LOCK } from './boot-host.js'

const cleanup: string[] = []
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function io(home: string): { io: MainIO; err: () => string } {
  const stderr = new PassThrough()
  let err = ''
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString()
  })
  return {
    err: () => err,
    io: {
      env: { AGH_HOME: home },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      stdout: new PassThrough(),
      stderr,
      cwd: home,
      agnesVersion: '0',
    },
  }
}

describe('agh batch dispatch', () => {
  it('is dispatched by the executable and points at the daemon when the host does not serve batches', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-batch-dispatch-'))
    cleanup.push(home)
    const route = {
      route: 'agnes-gateway',
      api: 'openai-completions' as const,
      baseUrl: 'https://gateway.invalid',
    }
    const adapter = new FakeAdapter({
      id: 'gateway',
      routes: [route],
      models: { 'agnes-gateway': [fakeModel({ id: 'm', ...route })] },
      script: () => [{ type: 'done', reason: 'stop' }],
    })
    const run = io(home)
    const code = await main(['batch', 'list'], run.io, {
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
                  routes: [{ ...route, models: [fakeModel({ id: 'm', ...route })] }],
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
    } satisfies Pick<LocalBootDeps, 'lock' | 'createHostImpl'>)
    expect(code).toBe(1)
    expect(run.err()).toContain('agh daemon start')
  })

  it('prints the usage for --help without booting anything', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-batch-dispatch-'))
    cleanup.push(home)
    const stdout = new PassThrough()
    let out = ''
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    const run = io(home)
    const code = await main(['batch', 'status', '--help'], { ...run.io, stdout }, { lock: TEST_LOCK })
    expect(code).toBe(0)
    expect(out).toContain('agh batch start')
    expect(out).toContain('0 when the batch completed or is still running')
  })

  it('answers a malformed batch command with usage before any boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agnes-batch-dispatch-'))
    cleanup.push(home)
    const run = io(home)
    const code = await main(['batch', 'explode'], run.io, { lock: TEST_LOCK })
    expect(code).toBe(2)
    expect(run.err()).toContain('agh batch start')
  })
})
