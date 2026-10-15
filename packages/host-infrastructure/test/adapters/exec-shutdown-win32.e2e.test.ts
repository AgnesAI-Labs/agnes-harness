import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxProcess } from '@agnes/extension-api'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { createExec } from '../../src/adapters/exec.js'

describe.skipIf(process.platform !== 'win32')('Windows adapter shutdown', () => {
  it.each([0, 1, 2])(
    'joins all real process trees with %i interactive cleanup failures',
    async (failures) => {
      const cwd = await mkdtemp(join(tmpdir(), 'agh-shutdown-'))
      const exec = createExec({ windowsNodeExecutable: process.execPath })
      const abort = new AbortController()
      const handles: SandboxProcess[] = []
      const errors = Array.from({ length: failures }, (_, i) => new Error(`cleanup failure ${i}`))
      const spies: ReturnType<typeof vi.spyOn>[] = []
      let running: ReturnType<typeof exec.run> | undefined
      try {
        if (!exec.openProcess) throw new Error('interactive process adapter is missing')
        for (let i = 0; i < 2; i++) {
          const handle = await exec.openProcess(
            [
              process.execPath,
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(join(cwd, `job${i}.pid`))}, String(process.pid));setTimeout(()=>{},60000)`,
            ],
            { cwd },
          )
          handles.push(handle)
          const failure = errors[i]
          if (failure) {
            const close = handle.close.bind(handle)
            spies.push(
              vi.spyOn(handle, 'close').mockImplementation(async () => {
                await close()
                throw failure
              }),
            )
          }
        }
        running = exec.run(
          [
            process.execPath,
            '-e',
            `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached:true, windowsHide:true, stdio:'ignore' });
child.once('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(join(cwd, 'child.pid'))}, String(child.pid)));
setTimeout(()=>{},60000);`,
          ],
          { cwd, signal: abort.signal },
        )
        const pids: number[] = []
        for (const name of ['job0.pid', 'job1.pid', 'child.pid']) {
          const marker = join(cwd, name)
          await expect.poll(() => readFile(marker, 'utf8'), { timeout: 10000 }).toMatch(/^\d+$/)
          const pid = Number(await readFile(marker, 'utf8'))
          expect(windowsProcessStartTimeSync(pid)).not.toBeNull()
          pids.push(pid)
        }
        const result = await exec.killAll().then(
          () => undefined,
          (error: unknown) => error,
        )
        for (const pid of pids) expect(windowsProcessStartTimeSync(pid)).toBeNull()
        if (failures) expect(result).toMatchObject({ errors })
        else expect(result).toBeUndefined()
        expect(await running).toMatchObject({ signal: 'SIGKILL', timedOut: false })
        await exec.killAll()
      } finally {
        for (const spy of spies) spy.mockRestore()
        abort.abort()
        try {
          await Promise.allSettled(handles.map((handle) => handle.close()))
          await running
          await exec.killAll()
        } finally {
          await rm(cwd, { recursive: true, force: true })
        }
      }
    },
    30000,
  )
})
