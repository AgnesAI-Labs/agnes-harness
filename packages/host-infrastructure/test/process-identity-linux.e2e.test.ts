import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { linuxProcessIdentity } from '../src/adapters/process-identity-linux.js'

it.skipIf(process.platform !== 'linux')(
  'does not mistake an unreaped child for a live owner',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-linux-identity-'))
    const source = join(root, 'child.c')
    const executable = join(root, 'child')
    try {
      // waitid WNOWAIT confirms termination but deliberately retains the child /proc record.
      await writeFile(
        source,
        `#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
int main(void) {
  pid_t pid = fork();
  if (pid < 0) return 1;
  if (!pid) _exit(0);
  siginfo_t info;
  if (waitid(P_PID, pid, &info, WEXITED | WNOWAIT)) return 2;
  printf("%d\\n", pid); fflush(stdout);
  getchar();
  return waitpid(pid, NULL, 0) == pid ? 0 : 3;
}`,
      )
      await promisify(execFile)('cc', ['-Wall', '-Wextra', '-Werror', source, '-o', executable])
      const parent = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      const exited = once(parent, 'exit')
      try {
        const [output] = await once(parent.stdout, 'data')
        const pid = Number(String(output).trim())
        expect(Number.isSafeInteger(pid)).toBe(true)
        process.kill(pid, 0) // PID-only liveness succeeds even though the child has exited.
        expect(await linuxProcessIdentity(pid)).toEqual({ state: 'dead' })
        if (!parent.pid) throw new Error('child did not start')
        expect((await linuxProcessIdentity(parent.pid)).state).toBe('alive')
        parent.stdin.end('\n')
        expect(await exited).toEqual([0, null])
      } finally {
        parent.stdin.end('\n')
        if (parent.exitCode === null) parent.kill()
        await exited
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15000,
)
