import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const { observeExecFile } = (await import(
  new URL('./fixtures/mcp-runtime-observer.mjs', import.meta.url).href
)) as {
  observeExecFile(
    original: typeof execFile,
    report: (entry: Record<string, unknown>) => void,
    executable?: string,
  ): typeof execFile
}

it.each([false, true])(
  'observes a real execFile settlement without replacing its promise/child/error (failure=%s)',
  async (failure) => {
    const originalCustom = promisify(execFile)
    let originalPromise: ReturnType<typeof originalCustom> | undefined
    let originalError: unknown
    const captured = new Proxy((..._args: unknown[]) => undefined, {
      get(_target, property) {
        if (property !== promisify.custom) return Reflect.get(execFile, property)
        return (...args: Parameters<typeof originalCustom>) => {
          originalPromise = originalCustom(...args)
          void originalPromise.catch((error) => {
            originalError = error
          })
          return originalPromise
        }
      },
    }) as unknown as typeof execFile
    const records: Record<string, unknown>[] = []
    const observed = promisify(observeExecFile(captured, (entry) => records.push(entry), process.execPath))
    const promise = observed(process.execPath, [
      '-e',
      failure
        ? "process.stderr.write('PRIVATE_SENTINEL');process.exit(42)"
        : "process.stdout.write('PRIVATE_SENTINEL')",
    ])
    expect(promise).toBe(originalPromise)
    expect(promise.child).toBe(originalPromise?.child)
    if (failure) {
      let caught: unknown
      try {
        await promise
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(originalError)
      expect(caught).toMatchObject({ code: 42, stderr: 'PRIVATE_SENTINEL' })
    } else expect(await promise).toEqual({ stdout: 'PRIVATE_SENTINEL', stderr: '' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'exec-file-settled',
      attempt: 1,
      outcome: failure ? 'failed' : 'succeeded',
      code: failure ? 42 : null,
    })
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_SENTINEL|stdout|stderr|argv|execPath/)
  },
)

it('handles Node’s immutable custom-promisify property and ignores other executables', async () => {
  const records: unknown[] = []
  const observed = promisify(observeExecFile(execFile, (entry) => records.push(entry)))
  expect(await observed(process.execPath, ['-e', "process.stdout.write('ok')"])).toEqual({
    stdout: 'ok',
    stderr: '',
  })
  expect(records).toEqual([])
})

it('keeps the actual command result even if its diagnostic sink throws', async () => {
  const observed = promisify(
    observeExecFile(
      execFile,
      () => {
        throw new Error('synthetic diagnostic sink failure')
      },
      process.execPath,
    ),
  )
  expect(await observed(process.execPath, ['-e', "process.stdout.write('ok')"])).toEqual({
    stdout: 'ok',
    stderr: '',
  })
})
