import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { createExec, createPolicyOpenProcess } from '@agnes/host-infrastructure/adapters/exec'
import { openLocalProcess } from '@agnes/host-infrastructure/adapters/process'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.platform === 'win32')('Host interactive processes', () => {
  it.each(existsSync('/bin/zsh') ? ['bash', 'zsh'] : ['bash'])(
    'provides %s a controlling PTY, input, resize, interruption and joined cleanup',
    async (shell) => {
      const handle = await openLocalProcess({
        argv: shell === 'zsh' ? ['/bin/zsh', '-f', '-i'] : ['bash', '--noprofile', '--norc', '-i'],
        cwd: tmpdir(),
        pty: { columns: 80, rows: 24 },
      })
      let output = ''
      handle.onOutput((chunk) => {
        output += chunk.text
      })
      const pollOutput = () => expect.poll(() => stripVTControlCharacters(output), { timeout: 5_000 })
      try {
        await handle.write('test -t 0 && printf "real-%s\\n" tty; stty size\r')
        await pollOutput().toContain('real-tty')
        await pollOutput().toContain('24 80')
        // Some tty implementations omit the newline. Frame both values and wait for the whole line.
        await handle.write('printf "tty:%s tpgid:%s\\n" "$(tty)" "$(ps -o tpgid= -p "$$")"\r')
        await pollOutput().toMatch(/(?:^|[\r\n])tty:\/dev\/\S+ tpgid:[ \t]*[1-9]\d*\r?\n/)
        expect(output).not.toMatch(/can't set tty pgrp|no job control|not a tty/i)
        await handle.resize(91, 31)
        await handle.write('stty size\r')
        await pollOutput().toContain('31 91')
        await handle.write('sh -c \'printf "sleep-%s\\n" started; exec sleep 30\'\r')
        await pollOutput().toContain('sleep-started')
        await handle.signal('SIGINT')
        await handle.write('printf "sleep-exit:%s\\n" "$?"\r')
        await pollOutput().toMatch(/(?:^|[\r\n])sleep-exit:130\r?\n/)
        await handle.close()
        expect((await handle.exited).code).not.toBeNull()
        await handle.close()
      } finally {
        await handle.close()
      }
    },
    30_000,
  )
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
