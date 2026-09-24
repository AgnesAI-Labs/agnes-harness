import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const configured = process.env.AGNES_ACP_CONCURRENCY
const enabled = configured !== undefined || process.env.CI !== undefined
const concurrency = Number(configured ?? 200)
const fixture = fileURLToPath(new URL('./fixtures/acp-cli.ts', import.meta.url))
const productionBin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const profileTemplate = fileURLToPath(new URL('../../host/templates/local-dev.yaml', import.meta.url))
const basePreset = fileURLToPath(new URL('../../base/presets/base.yaml', import.meta.url))
const hookMap = fileURLToPath(
  new URL('../../base/extensions/hooks-runner/generated/cc-hook-map.json', import.meta.url),
)

type Measurement = { startupMs: number; totalMs: number; updates: number }

const percentile95 = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] as number
}

describe.skipIf(!enabled)('--ephemeral ACP concurrency', () => {
  it('the production bin handles early success and argument failure without hanging', async () => {
    const run = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', productionBin, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
        }, 10_000)
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.once('error', reject)
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr })
        })
      })

    const version = await run(['--version'])
    expect(version.code).toBe(0)
    expect(version.stdout).toMatch(/^agh \S+ node \S+ protocol _agnes\/v1\n$/)

    const invalid = await run(['--not-an-agnes-option'])
    expect(invalid.code).not.toBe(0)
    expect(invalid.stderr).toContain('unknown flag')
  }, 30_000)

  it(`${concurrency} processes complete initialize + session/new + prompt and exit`, async () => {
    expect(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 200).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'agnes-acp-concurrency-'))
    const fixtureExecutable = join(root, 'acp-fixture.cjs')
    const runOne = (ordinal: number): Promise<Measurement> => {
      const dataDir = join(root, `host-${ordinal}`)
      mkdirSync(dataDir)
      return new Promise((resolve, reject) => {
        const started = performance.now()
        const child = spawn(
          process.execPath,
          [fixtureExecutable, '--mode', 'acp', '--ephemeral', '--profile', 'local-dev', '--cwd', dataDir],
          {
            env: {
              ...process.env,
              AGNES_ACP_FIXTURE_DIR: dataDir,
              TMPDIR: root,
              TMP: root,
              TEMP: root,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
        let buffer = ''
        let stderr = ''
        let startupMs = 0
        let updates = 0
        let completed = false
        let settled = false
        let failure: Error | undefined
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve({ startupMs, totalMs: performance.now() - started, updates })
        }
        const timer = setTimeout(() => {
          fail(new Error(`ACP child ${ordinal} timed out; stderr=${stderr.slice(-500)}`))
        }, 115_000)
        const fail = (error: Error): void => {
          failure ??= error
          child.stdin.destroy()
          child.kill('SIGKILL')
        }
        child.once('error', (error) => finish(error))
        child.stdin.on('error', (error) => fail(error))
        child.stderr.on('data', (chunk) => {
          stderr = `${stderr}${String(chunk)}`.slice(-8_192)
        })
        child.stdout.on('data', (chunk) => {
          buffer += String(chunk)
          for (;;) {
            const newline = buffer.indexOf('\n')
            if (newline < 0) break
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            let message: {
              id?: number
              method?: string
              result?: { sessionId?: string; stopReason?: string }
              error?: unknown
            }
            try {
              message = JSON.parse(line) as typeof message
            } catch (error) {
              fail(error as Error)
              return
            }
            if (message.method === 'session/update') updates++
            if (message.id === 1) {
              if (message.error) return fail(new Error(`initialize failed: ${line}`))
              startupMs = performance.now() - started
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'session/new',
                  params: { cwd: dataDir, mcpServers: [] },
                })}\n`,
              )
            }
            if (message.id === 2) {
              const sessionId = message.result?.sessionId
              if (!sessionId) return fail(new Error(`session/new failed: ${line}`))
              child.stdin.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: 3,
                  method: 'session/prompt',
                  params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
                })}\n`,
              )
            }
            if (message.id === 3) {
              if (message.result?.stopReason !== 'end_turn')
                return fail(new Error(`session/prompt failed: ${line}`))
              completed = true
              child.stdin.end()
            }
          }
        })
        child.once('exit', (code, signal) => {
          if (failure) return finish(failure)
          if (code !== 0 || !completed || startupMs === 0 || updates === 0)
            finish(
              new Error(
                `ACP child ${ordinal} exit=${code} signal=${signal} completed=${completed} startup=${startupMs.toFixed(0)} updates=${updates}; stderr=${stderr.slice(-500)}`,
              ),
            )
          else finish()
        })
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} },
          })}\n`,
        )
      })
    }

    try {
      // Compile the test executable once. Measuring N independent TypeScript compiler processes
      // would benchmark tsx's cache lock rather than Agnes startup. The production binary remains
      // separately covered above; this bundle is explicitly a test-only Host assembly.
      await build({
        entryPoints: [fixture],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        outfile: fixtureExecutable,
        logLevel: 'silent',
        define: {
          AGNES_VERSION: JSON.stringify('0.0.0-test'),
          // `import.meta.url` is pinned to the CLI entry below, so assets that other bundled
          // packages read relative to their own module are inlined, as the release builds do.
          AGNES_BASE_PRESET_TEXT: JSON.stringify(readFileSync(basePreset, 'utf8')),
          AGNES_CC_HOOK_MAP_TEXT: JSON.stringify(readFileSync(hookMap, 'utf8')),
          AGNES_PROFILE_TEMPLATE_TEXTS: JSON.stringify({
            'local-dev': readFileSync(profileTemplate, 'utf8'),
          }),
          'import.meta.url': JSON.stringify(new URL('../src/bin.ts', import.meta.url).href),
          'import.meta.resolve': 'require.resolve',
        },
      })
      const single = await runOne(-1)
      // Start every executable before awaiting any of them. This is the actual simultaneous cold
      // start gate; the executable uses only a test-owned Host assembly and never changes the
      // production bin/provider surface.
      const running = Array.from({ length: concurrency }, (_, index) => runOne(index))
      const results = await Promise.allSettled(running)
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      expect(failures, failures.map(({ reason }) => String(reason)).join('\n')).toEqual([])
      const measurements = results
        .filter((result): result is PromiseFulfilledResult<Measurement> => result.status === 'fulfilled')
        .map(({ value }) => value)
      const startupP95 = percentile95(measurements.map(({ startupMs }) => startupMs))
      const totalP95 = percentile95(measurements.map(({ totalMs }) => totalMs))
      const limit = Math.max(single.startupMs * 3, 1_500)
      console.info(
        `[acp-concurrency] n=${concurrency} simultaneous=true single-startup=${single.startupMs.toFixed(0)}ms startup-p95=${startupP95.toFixed(0)}ms total-p95=${totalP95.toFixed(0)}ms limit=${limit.toFixed(0)}ms`,
      )
      expect(
        startupP95,
        `startup p95 ${startupP95.toFixed(0)} ms vs single ${single.startupMs.toFixed(0)} ms`,
      ).toBeLessThan(limit)
    } finally {
      // Both the fixture-owned host homes and main()'s agnes-ephemeral-* homes live below this
      // private TMPDIR. The tsx loader may retain its own cache until the root is removed; no
      // application-owned entry may remain after every child exits.
      const leaked = readdirSync(root).filter(
        (entry) => entry.startsWith('host-') || entry.startsWith('agnes-ephemeral-'),
      )
      rmSync(root, { recursive: true, force: true })
      expect(leaked, `temporary resources leaked: ${leaked.join(', ')}`).toEqual([])
    }
  }, 120_000)
})
