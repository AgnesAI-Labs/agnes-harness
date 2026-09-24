import { describe, expect, it } from 'vitest'

const IMPLEMENTED = process.env.AGNES_RUNTIME_PYTHON_READY === '1'

describe.skipIf(!IMPLEMENTED)('rewrite acceptance (spike only)', () => {
  it('the kernel opens exactly one comm target', async () => {
    const { runtimes } = await import('../src/index.js')
    const python = runtimes.python
    if (!python) throw new Error('python runtime is not registered')
    const rt = await python({
      log: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    })
    await rt.start({ cwd: process.cwd(), env: {}, confine: async (a) => a })
    const seen: string[] = []
    await rt.run({
      program: 'import agnes\nawait agnes.log("info", "hi")',
      bindings: async (f) => {
        seen.push((f as { method: string }).method)
        return { jsonrpc: '2.0', id: (f as { id: number }).id, result: null }
      },
      limits: { wallMs: 30000, maxOutputChars: 65536 },
    })
    expect(seen).toEqual(['bridge.log'])
    await rt.kill()
  })

  it('the runtime exposes propose but no direct harness writes', async () => {
    const { runtimes } = await import('../src/index.js')
    const python = runtimes.python
    if (!python) throw new Error('python runtime is not registered')
    const rt = await python({
      log: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    })
    await rt.start({ cwd: process.cwd(), env: {}, confine: async (a) => a })
    const r = await rt.run({
      program: 'import agnes\nprint([n for n in dir(agnes.harness) if not n.startswith("_")])',
      bindings: async (f) => ({ jsonrpc: '2.0', id: (f as { id: number }).id, result: null }),
      limits: { wallMs: 30000, maxOutputChars: 65536 },
    })
    expect(r.stdout).toContain('propose')
    for (const forbidden of ['create_memory', 'create_skill', 'delete_entry'])
      expect(r.stdout).not.toContain(forbidden)
    await rt.kill()
  })

  it('a write through builtins.open becomes a write sub-call when raw_io is false', async () => {
    const { runtimes } = await import('../src/index.js')
    const python = runtimes.python
    if (!python) throw new Error('python runtime is not registered')
    const rt = await python({
      log: { debug() {}, info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    })
    await rt.start({ cwd: process.cwd(), env: {}, confine: async (a) => a })
    const methods: string[] = []
    await rt.run({
      program: "open('/tmp/agnes-shim-probe.txt', 'w').write('x')",
      bindings: async (f) => {
        methods.push(
          `${(f as { method: string }).method}:${JSON.stringify((f as { params: { name?: string } }).params.name)}`,
        )
        return { jsonrpc: '2.0', id: (f as { id: number }).id, result: {} }
      },
      limits: { wallMs: 30000, maxOutputChars: 65536 },
    })
    expect(methods.some((m) => m.startsWith('bridge.tools.invoke:"write"'))).toBe(true)
    await rt.kill()
  })
})
