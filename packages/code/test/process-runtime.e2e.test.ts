import { sandboxWorkspaceProbe } from '@agnes/base'
import type { ToolContext } from '@agnes/extension-api'
import { createExec } from '@agnes/host-infrastructure/adapters/exec'
import { createLocalSandboxProvider } from '@agnes/host-infrastructure/adapters/sandbox-local'
import { expect, it } from 'vitest'
import { createBridge } from '../src/extensions/code-mode/bridge.js'
import { processRuntime } from '../src/runtime/process.js'

const windows = process.platform === 'win32'
const unavailable = 'SANDBOX_UNAVAILABLE: Windows programmatic transport is unavailable'

function context(
  executor = createExec(windows ? { windowsNodeExecutable: process.execPath, detached: false } : {}),
) {
  const invocations: unknown[] = []
  const ctx = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    exec: executor.run,
    tools: {
      list: () => [{ name: 'echo' }],
      invoke: async (_name: string, args: unknown) => {
        invocations.push(args)
        return { content: [], structured: args }
      },
    },
  } as unknown as ToolContext
  return { ctx, executor, invocations }
}

it.each(['typescript', 'python'] as const)(
  'runs fresh %s cells on supported providers and refuses the unavailable Windows bridge',
  async (language) => {
    const { ctx, executor, invocations } = context()
    const runtime = processRuntime(ctx, language, { rawIo: language === 'python' })
    const code =
      language === 'typescript'
        ? 'const values: unknown[] = await Promise.all([tools.echo({n: 1}), tools.echo({n: 2})]); return values;'
        : 'return await asyncio.gather(tools.echo(n=1), tools.echo(n=2))'
    try {
      const pending = runtime.run({
        program: code,
        bindings: createBridge(ctx),
        limits: { wallMs: 5000, maxOutputChars: 65536 },
      })
      if (windows) {
        await expect(pending).rejects.toThrow(unavailable)
        expect(invocations).toEqual([])
        return
      }
      const result = await pending
      expect(result.status).toBe('ok')
      expect(JSON.parse(result.stdout)).toEqual([{ n: 1 }, { n: 2 }])
      expect(result.subcalls).toBe(2)
    } finally {
      await executor.killAll()
    }
  },
)

it('enforces process lifetime within the platform transport capabilities', async () => {
  const { ctx, executor, invocations } = context()
  const runtime = processRuntime(ctx, 'typescript')
  const run = (program: string, wallMs = 5000) =>
    runtime.run({
      program,
      bindings: createBridge(ctx),
      limits: { wallMs, maxOutputChars: 65536 },
    })
  try {
    if (windows) {
      await expect(run('globalThis.marker = 42; return 1;')).rejects.toThrow(unavailable)
      const signal = AbortSignal.abort()
      await expect(
        runtime.run({
          program: 'return 1;',
          bindings: createBridge(ctx),
          signal,
          limits: { wallMs: 5000, maxOutputChars: 65536 },
        }),
      ).resolves.toMatchObject({ status: 'aborted', subcalls: 0 })
      await runtime.kill()
      await expect(run('return 1;')).rejects.toThrow('code runtime is closed')
      expect(invocations).toEqual([])
      return
    }
    expect((await run('globalThis.marker = 42; return 1;')).status).toBe('ok')
    expect((await run('return globalThis.marker ?? null;')).stdout.trim()).toBe('null')
    expect((await run('while (true) {}', 200)).error?.name).toBe('TimeoutError')
    const pending = run('await new Promise(r => setTimeout(r, 10000));')
    await runtime.kill()
    expect((await pending).status).toBe('aborted')
  } finally {
    await executor.killAll()
  }
})

it('propagates governed budget and approval rejections into code', async () => {
  const { ctx, executor } = context()
  let dispatched = 0
  ctx.tools.invoke = async () => {
    dispatched++
    throw Object.assign(new Error('private refusal'), { code: 'APPROVAL_REJECTED' })
  }
  try {
    const pending = processRuntime(ctx, 'typescript').run({
      program: 'try { await tools.echo({}); } catch (e) { return e.code; }',
      bindings: createBridge(ctx),
      limits: { wallMs: 5000, maxOutputChars: 65536 },
    })
    if (windows) {
      await expect(pending).rejects.toThrow(unavailable)
      expect(dispatched).toBe(0)
    } else {
      const result = await pending
      expect(result.status).toBe('ok')
      expect(result.stdout.trim()).toBe('1002')
      expect(result.stdout).not.toContain('private refusal')
    }
    const capped = createBridge(ctx, { maxCalls: 0 })
    expect(
      await capped({
        jsonrpc: '2.0',
        id: 1,
        method: 'bridge.tools.invoke',
        params: { name: 'echo', args: {} },
      }),
    ).toMatchObject({ error: { code: 1001 } })
  } finally {
    await executor.killAll()
  }
})

it.each(['typescript', 'python'] as const)(
  'the real Windows provider and owned executor refuse %s before tool dispatch',
  async (language) => {
    const { ctx, executor, invocations } = context(
      createExec({ windowsNodeExecutable: process.execPath, detached: false }),
    )
    const provider = createLocalSandboxProvider(executor, 'win32')
    expect(provider.capabilities.programmatic).toBe(false)
    const instance = await provider.create({})
    try {
      await expect(
        instance.exec({ argv: ['node', '--version'], cwd: ctx.cwd, bridge: createBridge(ctx) }),
      ).rejects.toThrow('programmatic transport is unavailable on this platform')
      await expect(
        processRuntime(ctx, language, { rawIo: language === 'python' }).run({
          program: language === 'python' ? 'return await tools.echo(n=1)' : 'return await tools.echo({n:1});',
          bindings: createBridge(ctx),
          limits: { wallMs: 5000, maxOutputChars: 65536 },
        }),
      ).rejects.toThrow(unavailable)
      expect(invocations).toEqual([])
    } finally {
      await instance.dispose()
      await executor.killAll()
    }
  },
)

it('refuses an unbound provider request before process execution', async () => {
  const { executor, ctx } = context()
  const provider = createLocalSandboxProvider(executor, 'darwin')
  const instance = await provider.create({})
  try {
    await expect(
      processRuntime(ctx, 'python').run({
        program: 'return 1',
        bindings: createBridge(ctx),
        limits: { wallMs: 5000, maxOutputChars: 65536 },
      }),
    ).rejects.toThrow('Python raw_io:false')
    await expect(
      instance.exec({
        argv: ['node', '-e', 'process.exit(0)'],
        cwd: process.cwd(),
        bridge: async () => null,
      }),
    ).rejects.toThrow('bound execution policy')
  } finally {
    await instance.dispose()
    await executor.killAll()
  }
})

it.runIf(process.platform === 'darwin').each(['read-only', 'workspace-write'] as const)(
  'keeps the bridge usable inside the real %s process boundary',
  async (access) => {
    const { mkdtempSync, realpathSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-code-policy-')))
    const { ctx, executor } = context()
    try {
      const backend = await sandboxWorkspaceProbe({
        level: 'L1',
        required: true,
        onUnavailable: 'deny',
        shell: 'posix',
        options: {
          cwd: dir,
          allowPaths: access === 'workspace-write' ? [dir] : [],
          denyPaths: [],
          networkAllow: [],
        },
        probeExec: executor.run,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      })
      ctx.exec = async (argv, opts) =>
        executor.run([...(await backend.confine({ argv, cwd: dir }))], { ...opts, cwd: dir })
      const result = await processRuntime(ctx, 'typescript', { rawIo: true }).run({
        program: `const fs = await import('node:fs'); let writable = true;
          try { fs.writeFileSync(${JSON.stringify(join(dir, 'output'))}, 'ok'); } catch { writable = false; }
          return { writable, echo: await tools.echo({ value: 1 }) };`,
        bindings: createBridge(ctx),
        limits: { wallMs: 5000, maxOutputChars: 65536 },
      })
      expect(result.status, result.stderr).toBe('ok')
      expect(JSON.parse(result.stdout)).toEqual({
        writable: access === 'workspace-write',
        echo: { value: 1 },
      })
    } finally {
      await executor.killAll()
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
