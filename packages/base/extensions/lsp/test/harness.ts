import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProcessOutput, SandboxProcess } from '@agnes/extension-api'
import { fakeToolContext } from '../../../testkit/tool-context.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url))

export type Opened = {
  request: { argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }
  child: ChildProcess
  exited: boolean
}

/**
 * Stands in for the Host's sandbox: `openProcess` runs the fake language server as a child process
 * for the commands in `table` (the value is the fake's flags) and refuses the rest like a missing binary.
 */
export function sandboxHarness(table: Record<string, string[]>) {
  const opened: Opened[] = []
  // The invocation of the call that is running now. Core closes it when the call returns, and an
  // open still pending then is refused, as the Host's wrapper does for a closed workspace invocation.
  let current: { closed: boolean } | undefined
  const open = async (request: Opened['request']): Promise<SandboxProcess> => {
    const invocation = current
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (invocation?.closed) throw new Error('E_WORKSPACE_CLOSED: workspace invocation is closed')
    const listed = table[basename(request.argv[0] as string)]
    if (!listed) throw new Error(`spawn ${request.argv[0]} ENOENT`)
    // `--needs-writable-cache` models gopls under a write-confined sandbox: it dies at startup unless its
    // caches are redirected into the workspace, and it must keep the user's own HOME.
    const confined = listed.includes('--needs-writable-cache')
    const flags = listed.filter((flag) => flag !== '--needs-writable-cache')
    const cache = request.env?.GOPLSCACHE
    if (
      confined &&
      !(cache?.startsWith(`${request.cwd}/`) && request.env?.GOCACHE?.startsWith(`${request.cwd}/`))
    )
      flags.push('--exit-on-start')
    const child = spawn(process.execPath, [FAKE, ...flags], { stdio: ['pipe', 'pipe', 'ignore'] })
    const record: Opened = { request, child, exited: false }
    opened.push(record)
    child.stdin?.on('error', () => undefined)
    const listeners = new Set<(chunk: ProcessOutput) => void>()
    child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      for (const listener of listeners) listener({ stream: 'stdout', text })
    })
    const exited = new Promise<{ code: number | null }>((resolve) =>
      child.on('exit', (code) => {
        record.exited = true
        resolve({ code })
      }),
    )
    return {
      enforcement: { level: 'none', scope: [] },
      exited,
      onOutput(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      async write(text) {
        child.stdin?.write(text)
      },
      async resize() {},
      async signal() {},
      async close() {
        child.kill()
        await exited
      },
    }
  }
  /** Runs one tool call and closes its invocation as soon as it returns. */
  const inInvocation = async <T>(call: () => Promise<T>): Promise<T> => {
    const invocation = { closed: false }
    current = invocation
    try {
      return await call()
    } finally {
      invocation.closed = true
    }
  }
  return {
    opened,
    open,
    /** Makes every call of `lsp` end its invocation on return, like core does. */
    closing<
      L extends {
        diagnosticsFor: (...a: never[]) => Promise<unknown>
        check: (...a: never[]) => Promise<unknown>
      },
    >(lsp: L): L {
      for (const name of ['diagnosticsFor', 'check'] as const) {
        const original = lsp[name].bind(lsp) as (...a: unknown[]) => Promise<unknown>
        ;(lsp as Record<string, unknown>)[name] = (...a: unknown[]) => inInvocation(() => original(...a))
      }
      return lsp
    },
    killAll: () => {
      for (const o of opened) o.child.kill()
    },
  }
}

let sessions = 0
/** A tool context in `/work/proj` (a package.json makes it a TypeScript root) wired to the harness. */
export function lspContext(
  harness: ReturnType<typeof sandboxHarness> | undefined,
  files: Record<string, string> = {},
  sessionKey = `lsp-session-${sessions++}`,
) {
  const ctx = fakeToolContext({
    sessionKey,
    files: { 'package.json': '{}', 'pyproject.toml': '', 'go.mod': '', 'Cargo.toml': '', ...files },
  })
  if (harness) ctx.sandbox.openProcess = harness.open as never
  // The fake file port has no exclusive create; this one refuses an existing file as the real one does.
  ctx.fs.create = async (path, data) => {
    if (
      await ctx.fs.stat(path).then(
        () => true,
        () => false,
      )
    )
      throw new Error('EEXIST')
    await ctx.fs.write(path, data)
    return { size: data.byteLength, sha256: '' }
  }
  return ctx
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A tool directory on disk: `bin/<name>` for each name, with typescript installed beside
 * typescript-language-server the way a global npm install lays it out.
 */
export function fakeInstall(names: readonly string[], withTypescript = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-bin-')))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of names) {
    if (name === 'typescript-language-server') {
      const pkg = join(root, 'lib', 'node_modules', 'typescript-language-server', 'lib')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'typescript-language-server'), '')
      chmodSync(join(pkg, 'typescript-language-server'), 0o755)
      symlinkSync(join(pkg, 'typescript-language-server'), join(bin, name))
    } else {
      writeFileSync(join(bin, name), '')
      chmodSync(join(bin, name), 0o755)
    }
  }
  const lib = join(root, 'lib', 'node_modules', 'typescript', 'lib')
  if (withTypescript) {
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'tsserver.js'), '')
  }
  return { root, searchPath: bin, tsserver: join(lib, 'tsserver.js') }
}
