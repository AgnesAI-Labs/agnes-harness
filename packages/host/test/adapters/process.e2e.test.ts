import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createExec, createPolicyOpenProcess } from '../../src/adapters/exec.js'
import { openLocalProcess } from '../../src/adapters/process.js'

describe.skipIf(process.platform === 'win32')('Host interactive processes', () => {
  it('provides a real PTY, input, resize, interruption and joined cleanup with bounded launch and joined cleanup', async () => {
    const handle = await openLocalProcess({
      argv: ['bash', '--noprofile', '--norc', '-i'],
      cwd: tmpdir(),
      pty: { columns: 80, rows: 24 },
    })
    let output = ''
    handle.onOutput((chunk) => {
      output += chunk.text
    })
    try {
      await handle.write('test -t 0 && printf "real-%s\\n" tty; stty size\r')
      await expect.poll(() => output).toContain('real-tty')
      await expect.poll(() => output).toContain('24 80')
      await handle.resize(91, 31)
      await handle.write('stty size\r')
      await expect.poll(() => output).toContain('31 91')
      await handle.write('sleep 30\r')
      // Wait for input echo before signalling the foreground process.
      await expect.poll(() => output).toContain('sleep 30')
      await handle.signal('SIGINT')
      await handle.write('printf "after-%s\\n" interrupt\r')
      await expect.poll(() => output).toContain('after-interrupt')
      await handle.close()
      expect((await handle.exited).code).not.toBeNull()
      await handle.close()
    } finally {
      await handle.close()
    }
  })
  it.runIf(existsSync('/usr/bin/sandbox-exec')).each([false, true])(
    'retains read-only confinement through the %s PTY mode and its descendants',
    async (pty) => {
      const root = mkdtempSync(join(tmpdir(), 'agnes-pty-policy-'))
      const target = join(root, 'forbidden')
      const profile =
        '(version 1)(deny default)(allow process*)(allow sysctl-read)(allow file-read*)(deny file-write*)(deny network*)'
      const handle = await openLocalProcess({
        argv: [
          '/usr/bin/sandbox-exec',
          '-p',
          profile,
          '/bin/sh',
          '-c',
          `/bin/sh -c 'printf forbidden > "$1"' child "$1"; printf "policy-%s\\n" done`,
          'parent',
          target,
        ],
        cwd: root,
        ...(pty ? { pty: { columns: 80, rows: 24 } } : {}),
      })
      let output = ''
      handle.onOutput((chunk) => {
        output += chunk.text
      })
      try {
        await handle.exited
        expect(output).toContain('policy-done')
        expect(existsSync(target)).toBe(false)
      } finally {
        await handle.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
  it('refuses missing/stale policy and disallowed cwd before creating an interactive process', async () => {
    const exec = createExec()
    const open = createPolicyOpenProcess(exec, {
      boundDigest: () => 'bound',
      state: () => ({ backend: 'none', onUnavailable: 'deny' }),
      authorizeCwd: async () => {
        throw new Error('E_FS_DENIED')
      },
    })
    const args = ['bash', '-s']
    await expect(open(args, { cwd: tmpdir() })).rejects.toThrow('no sandbox binding')
    await expect(
      open(args, { cwd: tmpdir(), sandbox: { policyDigest: 'stale', backend: 'none' } }),
    ).rejects.toThrow('valid sandbox binding')
    await expect(
      open(args, { cwd: tmpdir(), sandbox: { policyDigest: 'bound', backend: 'none' } }),
    ).rejects.toThrow('E_FS_DENIED')
    await exec.killAll()
  })
})
