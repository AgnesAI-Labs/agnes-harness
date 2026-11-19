import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandboxImplementation, sandboxWorkspaceProbe } from '@agnes/base'
import { createPlatform } from '@agnes/host-infrastructure/adapters/platform'
import { resolveConfiguredExecutionPowerShell } from '@agnes/host-infrastructure/adapters/powershell'
import { createSandboxSeam } from '@agnes/host-infrastructure/sandbox-seam'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

describe.skipIf(process.platform !== 'win32')('Windows shell in a workspace-bound session', () => {
  it.each([
    'restricted',
    ...(process.env.AGH_TEST_INCOMPATIBLE_POWERSHELL
      ? ['full-access', 'restricted-explicit', 'full-access-auto']
      : []),
  ])(
    'returns an approved shell result in %s mode',
    async (mode) => {
      const fullAccess = mode.startsWith('full-access')
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-shell-session-')))
      const workspace = join(base, 'work')
      mkdirSync(workspace)
      const marker = join(workspace, 'business-started')
      const incompatible = process.env.AGH_TEST_INCOMPATIBLE_POWERSHELL
      const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: join(base, 'local') }
      if (incompatible) {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
        env.PATH = `${dirname(incompatible)};${env.SystemRoot}/System32`
        env.AGNES_POWERSHELL =
          mode === 'full-access' || mode === 'restricted-explicit' ? incompatible : 'auto'
        await expect(
          resolveConfiguredExecutionPowerShell({ ...env, AGNES_POWERSHELL: incompatible }, process.execPath),
        ).rejects.toMatchObject({
          code: 'E_POWERSHELL_UNAVAILABLE',
          attempts: [{ reason: 'restricted-execution-failed' }],
        })
      }
      const { host } = await createTestHost({
        dataDir: join(base, 'home'),
        workspaceRoot: workspace,
        platform: createPlatform(),
        env,
        ...(mode === 'full-access-auto'
          ? {
              profileInputs: {
                user: {
                  name: 'local-dev',
                  permissions: { default: 'full-access', allowed: ['full-access'] },
                },
              },
            }
          : {}),
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
        packages: { '@agnes/base': { sandboxImplementation, sandboxWorkspaceProbe } },
        presets: {
          standard: {
            name: 'standard',
            extends: 'base',
            sandbox: fullAccess
              ? { level: 'L0', on_unavailable: 'allow' }
              : {
                  level: 'L1',
                  on_unavailable: 'allow-if-unimplemented',
                  windows_mode: 'write-restricted',
                },
          },
        },
        sandboxSeam: createSandboxSeam(),
        disableSessionTitle: true,
        approval: async (request) => ({ verdict: 'allowed-once', answeredBy: request.actor }),
        script: [
          [
            {
              type: 'toolcall_end',
              call: {
                toolUseId: '',
                name: 'shell',
                args: {
                  command: `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}','ready'); Write-Output AGH_SESSION_OK; Write-Output "AGH_PS_MAJOR=$($PSVersionTable.PSVersion.Major)"; & "$env:SystemRoot/System32/whoami.exe" /groups /fo csv /nh | Select-String S-1-16 | ForEach-Object { $_.Line }`,
                },
                ordinal: 0,
              },
              via: 'native',
            },
            { type: 'done', reason: 'toolUse' },
          ],
          [
            { type: 'text_delta', delta: 'done' },
            { type: 'done', reason: 'stop' },
          ],
        ],
      })
      try {
        const key = 'windows-shell-session'
        const binding = host.acceptWorkspaceBinding(
          { version: 1, sessionKey: key, workspaceId: 'a'.repeat(64), revision: 1, canonicalRoot: workspace },
          key,
        )
        const session = await host.createSession({ key, binding })
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text: 'print the marker' }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        const outcome = await session.run({ until: 'turn-end', signal: AbortSignal.timeout(15_000) })
        expect(outcome.reason).toBe('completed')
        const results = await session.scan({ type: 'tool/result', limit: 10 })
        expect(results).toHaveLength(1)
        if (mode === 'restricted-explicit' || mode === 'full-access') {
          expect(results[0]?.data).toMatchObject({ isError: true })
          expect(JSON.stringify(results[0]?.data)).toContain('E_POWERSHELL_UNAVAILABLE')
          expect(JSON.stringify(results[0]?.data)).not.toContain('AGH_SESSION_OK')
          expect(existsSync(marker)).toBe(false)
          return
        }
        expect(results[0]?.data, JSON.stringify(results[0]?.data)).toMatchObject({ isError: false })
        expect(JSON.stringify(results[0]?.data)).toContain('AGH_SESSION_OK')
        expect(
          JSON.stringify(results[0]?.data).includes('S-1-16-4096'),
          JSON.stringify(results[0]?.data),
        ).toBe(!fullAccess)
        if (incompatible) expect(JSON.stringify(results[0]?.data)).toContain('AGH_PS_MAJOR=5')
      } finally {
        await host.close()
        execFileSync('icacls', [base, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' })
        rmSync(base, { recursive: true, force: true, maxRetries: 5 })
      }
    },
    30_000,
  )
})
