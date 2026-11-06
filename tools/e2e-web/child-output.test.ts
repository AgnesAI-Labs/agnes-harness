import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { childOutput } from './child-output.js'

const exec = promisify(execFile)

it('keeps a failed browser child stack and stderr in the reported error, with its exit metadata', async () => {
  const failure = await childOutput(
    exec(process.execPath, [
      '-e',
      "console.log(['BROWSER_STACK:', 'synthetic failure'].join(' ')); console.error(['browser', 'stderr'].join(' ')); process.exitCode = 23",
    ]),
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain('BROWSER_STACK: synthetic failure')
  expect((failure as Error).message).toContain('browser stderr')
  expect((failure as Error).cause).toMatchObject({ code: 23 })
})

it('retains a successful browser child output', async () => {
  const result = await childOutput(exec(process.execPath, ['-e', "console.log('browser passed')"]))
  expect(result.stdout).toBe('browser passed\n')
  expect(result.stderr).toBe('')
})
