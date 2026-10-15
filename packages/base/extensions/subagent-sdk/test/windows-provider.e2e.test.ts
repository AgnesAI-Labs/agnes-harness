import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ChildAgentEvent } from '@agnes/extension-api'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
import { codexChildAgentProvider } from '../../subagent-codex/src/provider.js'
import { sdkChildAgentProvider } from '../src/provider.js'

describe.skipIf(process.platform !== 'win32')('Windows external child entrypoints', () => {
  it.each(['sdk', 'acp'] as const)(
    'keeps %s stdin task text through cmd/bat in a Chinese directory',
    async (protocol) => {
      const cwd = await mkdtemp(join(tmpdir(), 'agh-child-中文 空格-'))
      const fixture = fileURLToPath(
        new URL(
          protocol === 'sdk' ? './fake-sdk.mjs' : '../../subagent-acp/test/fixture-agent.mjs',
          import.meta.url,
        ),
      )
      try {
        const bootstrap = join(cwd, 'owned-fixture.mjs')
        const marker = join(cwd, 'descendant.pid')
        await writeFile(
          bootstrap,
          `
          import { spawn } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          const descendant = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
          descendant.once('spawn', async () => {
            writeFileSync(${JSON.stringify(marker)}, String(descendant.pid));
            await import(${JSON.stringify(pathToFileURL(fixture).href)});
          });
        `,
        )
        for (const extension of ['cmd', 'bat']) {
          const command = join(cwd, `agent.${extension}`)
          // A plain script, not a %* argument proxy. Runtime paths travel via explicit environment.
          await writeFile(command, '@echo off\r\n"%CHILD_NODE%" "%CHILD_SCRIPT%"\r\n')
          const provider = sdkChildAgentProvider({
            enabled: true,
            protocol,
            command,
            allow: [command],
            env: { CHILD_NODE: process.execPath, CHILD_SCRIPT: bootstrap },
          })
          const task = '中文 "quoted" %PATH% & | ^ !\nsecond line\n' + '长'.repeat(9000)
          const handle = await provider.start(task, {
            signal: new AbortController().signal,
            sessionKey: 'batch-test',
            cwd,
            launch: { windowsNodeExecutable: process.execPath },
          })
          const events: ChildAgentEvent[] = []
          const reading = (async () => {
            for await (const event of handle.events()) events.push(event)
          })()
          try {
            await expect
              .poll(
                () =>
                  events
                    .filter((e) => e.type === 'text')
                    .map((e) => e.text)
                    .join(''),
                { timeout: 10000 },
              )
              .toContain(`echo:${task}`)
            if (protocol === 'acp') {
              await handle.sendMessage('second turn', new AbortController().signal)
              await expect
                .poll(() => JSON.stringify(events), { timeout: 10000 })
                .toContain('echo:second turn')
            } else expect((await handle.result()).status).toBe('completed')
          } finally {
            await handle.dispose()
            await handle.dispose()
            await reading
          }
          expect(windowsProcessStartTimeSync(Number(await readFile(marker, 'utf8')))).toBeNull()
        }
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    },
    45000,
  )
  it('preserves proxy argv only when the deployment explicitly declares the verified wrapper', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agh-child-proxy-'))
    try {
      const command = join(cwd, 'agent.cmd')
      const fixture = fileURLToPath(new URL('../../subagent-codex/test/fake-codex.mjs', import.meta.url))
      await writeFile(command, '@echo off\r\n"%CHILD_NODE%" "%CHILD_SCRIPT%" %*\r\n')
      const provider = codexChildAgentProvider({
        enabled: true,
        command,
        allow: [command],
        windowsBatch: 'argv-proxy',
        env: { CHILD_NODE: process.execPath, CHILD_SCRIPT: fixture },
      })
      const options = { signal: new AbortController().signal, sessionKey: 'proxy', cwd }
      const task = '中文 "quotes" & | %PATH% ! ^ tail\\'
      const handle = await provider.start(task, options)
      try {
        expect(await handle.result()).toMatchObject({ status: 'completed', text: `echo:${task}` })
      } finally {
        await handle.dispose()
      }
      await expect(provider.start('line one\nline two', options)).rejects.toMatchObject({
        code: 'E_WINDOWS_BATCH_ARGUMENT',
      })
      const denied = sdkChildAgentProvider({ enabled: true, protocol: 'sdk', command, allow: [] })
      await expect(denied.start('no', options)).rejects.toThrow('not allowlisted')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30000)
})
