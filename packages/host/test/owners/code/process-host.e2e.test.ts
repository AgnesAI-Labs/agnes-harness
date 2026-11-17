import { PARSER_VERSION } from '@agnes/ai'
import { createExec } from '@agnes/host-infrastructure/adapters/exec'
import { expect, it } from 'vitest'

const windows = process.platform === 'win32'
const unavailable = 'SANDBOX_UNAVAILABLE: Windows programmatic transport is unavailable'

function execution(windowsTransport: boolean) {
  const executor = createExec(
    windowsTransport ? { windowsNodeExecutable: process.execPath, detached: false } : {},
  )
  const failures: unknown[] = []
  const exec: typeof executor.run = async (argv, options) => {
    try {
      return await executor.run(argv, options)
    } catch (error) {
      failures.push(error)
      throw error
    }
  }
  return { executor, exec, failures }
}

it.each([
  ...(['read', 'denied-shell', 'raw-io-denied'] as const).map((target) => ({ target, ownedWindows: false })),
  { target: 'read' as const, ownedWindows: true },
])(
  'loads the official preset and drives $target through Host approvals and ledger (Windows owned=$ownedWindows)',
  async ({ target, ownedWindows }) => {
    const windowsTransport = windows || ownedWindows
    const { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { fakeProvider, textTurn, toolTurn } = await import('@agnes/core/testkit')
    const { createTestHost } = await import('@agnes/host/testkit')
    const code = await import('@agnes/code')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-ptc-')))
    writeFileSync(join(dir, 'input.txt'), 'nested host read')
    const { executor, exec, failures } = execution(windowsTransport)
    const approvals: string[] = []
    const provider = fakeProvider(
      [
        toolTurn('run_code', {
          code:
            target === 'read'
              ? "return await tools.read({ path: 'input.txt' });"
              : target === 'denied-shell'
                ? "try { return await tools.shell({ command: 'printf never' }); } catch (e) { return e.code; }"
                : "const fs = await import('node:fs'); const cp = await import('node:child_process'); const codes = []; try { fs.writeFileSync('bypass.txt', 'bad'); } catch (e) { codes.push(e.code); } try { cp.spawnSync('sh', ['-c', 'printf bad']); } catch (e) { codes.push(e.code); } return codes;",
        }),
        textTurn('done'),
      ],
      PARSER_VERSION,
    )
    const { host } = await createTestHost({
      dataDir: dir,
      provider,
      packageDirs: {
        '@agnes/base': fileURLToPath(new URL('../../../../base/', import.meta.url)),
        '@agnes/code': fileURLToPath(new URL('../../../../code/', import.meta.url)),
      },
      packages: {
        '@agnes/code': {
          presets: code.presets,
          ecosystem: code.ecosystem,
          runtimes: code.runtimes,
          operations: code.operations,
        },
      },
      allowed: ['ptc'],
      profileInputs: { user: { name: 'local-dev', presets: { default: 'ptc', allowed: ['ptc'] } } },
      seams: { sandbox: { exec } },
      approval: async (req) => {
        approvals.push(req.tool?.name ?? 'budget')
        return {
          verdict: req.tool?.name === 'shell' ? 'rejected' : 'allowed-once',
          answeredBy: { ...req.actor, id: 'reviewer' },
        }
      },
    })
    try {
      expect(host.kernel.tools.resolve('workflow')?.source.source).toBe('agnes/workflow')
      const session = await host.createSession({ cwd: dir, key: 'ptc-integration', preset: 'ptc' })
      await session.enqueue('next-turn', {
        actor: session.d.actor,
        content: [{ type: 'text', text: 'Read the input.' }],
      })
      const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(out.reason).toBe('completed')
      const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
      if (windowsTransport) {
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ message: unavailable })
        expect(results.map((row) => row.data)).toContainEqual(expect.objectContaining({ isError: true }))
        const calls = await session.scan({ type: 'tool/call', toSeq: session.lastSeq })
        expect(calls.map((row) => (row.data as { name: string }).name)).toEqual(['run_code'])
        expect(approvals.filter((name) => name !== 'budget')).toEqual(['run_code'])
        expect(existsSync(join(dir, 'bypass.txt'))).toBe(false)
        expect(JSON.stringify(results)).not.toContain('nested host read')
      } else if (target === 'read') expect(JSON.stringify(results)).toContain('nested host read')
      else if (target === 'denied-shell') {
        expect(approvals).toContain('shell')
        expect(JSON.stringify(results)).toContain('1002')
      } else {
        expect(JSON.stringify(results)).toContain('ERR_ACCESS_DENIED')
        expect(JSON.stringify(results).match(/ERR_ACCESS_DENIED/g)?.length).toBeGreaterThanOrEqual(2)
      }
      expect(approvals).toContain('run_code')
      expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(['run_code'])
      expect(provider.requests[0]?.system).toContain('declare const tools')
    } finally {
      await host.close()
      await executor.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30000,
)

it.each([false, true])(
  'keeps nested results out of later requests (Windows owned=%s)',
  async (ownedWindows) => {
    const windowsTransport = windows || ownedWindows
    const { mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { fakeProvider, textTurn, toolTurn } = await import('@agnes/core/testkit')
    const { createTestHost } = await import('@agnes/host/testkit')
    const code = await import('@agnes/code')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-ptc-')))
    writeFileSync(join(dir, 'input.txt'), 'nested host read')
    const { executor, exec, failures } = execution(windowsTransport)
    const provider = fakeProvider(
      [
        toolTurn('run_code', {
          code: "const a = await tools.read({ path: 'input.txt' }); console.log('len=' + String(a).length);",
        }),
        textTurn('done'),
        textTurn('again'),
      ],
      PARSER_VERSION,
    )
    const { host } = await createTestHost({
      dataDir: dir,
      provider,
      packageDirs: {
        '@agnes/base': fileURLToPath(new URL('../../../../base/', import.meta.url)),
        '@agnes/code': fileURLToPath(new URL('../../../../code/', import.meta.url)),
      },
      packages: {
        '@agnes/code': {
          presets: code.presets,
          ecosystem: code.ecosystem,
          runtimes: code.runtimes,
          operations: code.operations,
        },
      },
      allowed: ['ptc'],
      profileInputs: { user: { name: 'local-dev', presets: { default: 'ptc', allowed: ['ptc'] } } },
      seams: { sandbox: { exec } },
      approval: async (req) => ({ verdict: 'allowed-once', answeredBy: { ...req.actor, id: 'reviewer' } }),
    })
    try {
      const session = await host.createSession({ cwd: dir, key: 'ptc-hidden', preset: 'ptc' })
      for (const text of ['Read the input.', 'Anything else?']) {
        await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text }] })
        const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(out.reason).toBe('completed')
      }
      // A supported cell made the nested read; the unavailable transport must dispatch no nested tool.
      const calls = (await session.scan({ type: 'tool/call', toSeq: session.lastSeq })).map(
        (row) => row.data as { name?: string; depth?: number },
      )
      if (windowsTransport) {
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ message: unavailable })
        expect(calls.map((call) => call.name)).toEqual(['run_code'])
        const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
        expect(results.map((row) => row.data)).toContainEqual(expect.objectContaining({ isError: true }))
      } else expect(calls).toContainEqual(expect.objectContaining({ name: 'read', depth: 1 }))
      const second = JSON.stringify(provider.requests[1]?.messages)
      expect(JSON.stringify(provider.requests[1])).toContain('"name":"run_code"')
      if (!windowsTransport) expect(second).toContain('len=')
      expect(second).not.toContain('nested host read')
      expect(second).not.toContain('"name":"read"')
      expect(JSON.stringify(provider.requests[1])).not.toContain('ExperimentalWarning')
      expect(JSON.stringify(provider.requests[2])).not.toContain('ExperimentalWarning')
    } finally {
      await host.close()
      await executor.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30000,
)
