import { type CodeRuntime, checkToolDef, type ToolContext } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { createRunCodeTool, readLimits } from '../src/index.js'

const preset = {
  code_runtime: {
    language: 'python',
    state: 'persistent',
    isolation: 'process',
    raw_io: false,
    max_parallel_sub_calls: 4,
    cell_timeout_ms: 600000,
    max_output_chars: 65536,
  },
}
const result = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  stdout: 'hello',
  stderr: '',
  durationMs: 12,
  subcalls: 0,
  ...over,
})
const runtime = (over: Record<string, unknown> = {}) =>
  ({ run: vi.fn(async () => result()), ...over }) as unknown as CodeRuntime
const context = () => {
  const put = vi.fn(async () => ({ sha256: 'a'.repeat(64), size: 200000, mime: 'text/plain' }))
  return {
    signal: new AbortController().signal,
    artifacts: { put },
  } as unknown as ToolContext & { artifacts: { put: typeof put } }
}
const deps = (rt: CodeRuntime, done = vi.fn()) => ({
  acquire: async () => rt,
  bridge: () => async (frame: unknown) => frame,
  limits: () => readLimits(preset),
  onCellDone: done,
})

describe('run_code tool definition', () => {
  it('has the schema and all eight explicit metadata keys', () => {
    const tool = createRunCodeTool(deps(runtime()))
    expect(checkToolDef(tool)).toEqual({ ok: true })
    expect(tool.name).toBe('run_code')
    expect(tool.description).toContain('persistent kernel')
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual([
      'code',
      'description',
    ])
    expect((tool.parameters as { required: string[] }).required).toEqual(['code'])
    expect(tool.meta).toEqual({
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      isOpenWorld: true,
      replay: 'never',
      costHint: undefined,
      deferLoading: false,
      requiresApproval: undefined,
    })
  })

  it('passes the program, bridge, signal and limits to the runtime', async () => {
    const rt = runtime()
    const ctx = context()
    const done = vi.fn()
    const output = await createRunCodeTool(deps(rt, done)).execute(
      { code: 'print(1)', description: 'probe' },
      ctx,
    )
    const request = vi.mocked(rt.run).mock.calls[0]?.[0]
    expect(request).toMatchObject({
      program: 'print(1)',
      signal: ctx.signal,
      limits: { wallMs: 600000, maxOutputChars: 65536 },
    })
    await expect(request?.bindings({ marker: 1 })).resolves.toEqual({ marker: 1 })
    expect(output).toMatchObject({
      isError: false,
      structured: { status: 'ok', durationMs: 12, subcalls: 0, truncated: false },
    })
    expect(output.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(done).toHaveBeenCalledWith(ctx, rt)
  })

  it('returns an errored cell as data without throwing', async () => {
    const rt = runtime({
      run: vi.fn(async () =>
        result({
          status: 'error',
          stdout: '',
          stderr: 'boom',
          error: { name: 'ValueError', message: 'bad value', traceback: ['line 1'] },
          subcalls: 1,
        }),
      ),
    })
    const output = await createRunCodeTool(deps(rt)).execute({ code: 'raise' }, context())
    expect(output.isError).toBe(true)
    expect(output.structured).toMatchObject({ status: 'error', subcalls: 1 })
    expect(JSON.stringify(output.content)).toContain('ValueError: bad value')
  })

  it('stores the full output when the bounded preview truncates it', async () => {
    const full = 'x'.repeat(200000)
    const ctx = context()
    const output = await createRunCodeTool(
      deps(runtime({ run: vi.fn(async () => result({ stdout: full })) })),
    ).execute({ code: 'print(big)' }, ctx)
    expect(output.structured).toMatchObject({ truncated: true, artifact: 'a'.repeat(64) })
    expect((output.content[0] as { text: string }).text.length).toBeLessThanOrEqual(65536)
    expect(ctx.artifacts.put).toHaveBeenCalledWith(new TextEncoder().encode(full), {
      mime: 'text/plain',
      name: 'cell-output.txt',
    })
  })
})
