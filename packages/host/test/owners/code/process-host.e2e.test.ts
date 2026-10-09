import { createExec } from '@agnes/host-infrastructure/adapters/exec'
import { expect, it } from 'vitest'

it.each(['read', 'denied-shell', 'raw-io-denied'] as const)(
  'loads the official preset and drives %s through Host approvals and ledger',
  async (target) => {
    const { mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const { fakeProvider, textTurn, toolTurn } = await import('@agnes/core/testkit')
    const { createTestHost } = await import('@agnes/host/testkit')
    const code = await import('@agnes/code')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-ptc-')))
    writeFileSync(join(dir, 'input.txt'), 'nested host read')
    const executor = createExec()
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
      '2',
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
      seams: { sandbox: { exec: executor.run } },
      approval: async (req) => {
        approvals.push(req.tool?.name ?? 'budget')
        return req.tool?.name === 'shell' ? 'rejected' : 'allowed-once'
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
      if (target === 'read') expect(JSON.stringify(results)).toContain('nested host read')
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
