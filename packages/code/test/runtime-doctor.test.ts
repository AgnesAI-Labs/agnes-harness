import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeDoctor } from '../src/runtime/doctor.js'
import { FakeRuntime } from '../src/runtime/testkit.js'

afterEach(() => vi.useRealTimers())
describe('runtime diagnostics', () => {
  it('reports missing installation', async () => {
    expect(await runtimeDoctor(undefined)).toMatchObject({
      status: 'fail',
      checks: [{ id: 'installed', status: 'fail' }],
    })
  })
  it('reports interfaces without claiming execution or restoration has passed', async () => {
    const rt = new FakeRuntime(),
      start = vi.spyOn(rt, 'start'),
      run = vi.spyOn(rt, 'run')
    const result = await runtimeDoctor(rt)
    expect(result.status).toBe('ok')
    expect(result.checks.map((c) => c.id)).toEqual(['installed', 'probe', 'descriptors', 'persistence'])
    expect(result.checks[3]?.detail).toContain('recovery is not verified')
    expect(start).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
  it('includes a declared installation failure and hint', async () => {
    const rt = new FakeRuntime()
    vi.spyOn(rt, 'probe').mockResolvedValue({
      ok: false,
      reason: 'missing dependency',
      installHint: 'run installer',
    } as never)
    const result = await runtimeDoctor(rt)
    expect(result.status).toBe('fail')
    expect(result.checks[1]?.detail).toBe('missing dependency - run installer')
  })
  it('does not disclose thrown backend errors', async () => {
    const rt = new FakeRuntime()
    vi.spyOn(rt, 'probe').mockRejectedValue(new Error('private-backend-error'))
    const result = await runtimeDoctor(rt)
    expect(result.status).toBe('fail')
    expect(JSON.stringify(result)).not.toContain('private-backend-error')
  })
  it.each(['snapshot', 'restore', 'listNames'] as const)('warns when %s is unavailable', async (method) => {
    const rt = new FakeRuntime()
    Object.defineProperty(rt, method, { value: undefined })
    expect(await runtimeDoctor(rt)).toMatchObject({
      status: 'warn',
      checks: expect.arrayContaining([{ id: 'persistence', status: 'warn', detail: expect.any(String) }]),
    })
  })
  it('fails invalid descriptors instead of reporting isolation as verified', async () => {
    const rt = new FakeRuntime()
    Object.defineProperty(rt, 'isolation', { value: 'unknown' })
    expect((await runtimeDoctor(rt)).status).toBe('fail')
  })
  it('keeps a probe failure dominant over missing persistence warnings', async () => {
    const rt = new FakeRuntime()
    Object.defineProperty(rt, 'snapshot', { value: undefined })
    vi.spyOn(rt, 'probe').mockRejectedValue(new Error())
    expect((await runtimeDoctor(rt)).status).toBe('fail')
  })
  it('rejects accessor probe responses without executing them', async () => {
    const rt = new FakeRuntime(),
      getter = vi.fn(() => 'version')
    vi.spyOn(rt, 'probe').mockResolvedValue({
      ok: true,
      get version() {
        return getter()
      },
    })
    expect((await runtimeDoctor(rt)).status).toBe('fail')
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([
    { ok: true, version: '' },
    { ok: 'yes', version: '1' },
    { ok: false },
    { ok: true, version: '1', extra: 'x' },
  ])('rejects invalid report %j', async (value) => {
    const rt = new FakeRuntime()
    vi.spyOn(rt, 'probe').mockResolvedValue(value as never)
    expect((await runtimeDoctor(rt)).status).toBe('fail')
  })
  it('enforces the default deadline and cleans up its timer', async () => {
    vi.useFakeTimers()
    const rt = new FakeRuntime()
    vi.spyOn(rt, 'probe').mockReturnValue(new Promise(() => {}))
    let finished = false
    const running = runtimeDoctor(rt).then((result) => {
      finished = true
      return result
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(finished).toBe(true)
    expect((await running).status).toBe('fail')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('removes a deadline timer when the probe succeeds early', async () => {
    vi.useFakeTimers()
    expect((await runtimeDoctor(new FakeRuntime())).status).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })
})
