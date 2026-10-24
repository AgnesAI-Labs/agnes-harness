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
  const open = async (request: Opened['request']): Promise<SandboxProcess> => {
    const flags = table[basename(request.argv[0] as string)]
    if (!flags) throw new Error(`spawn ${request.argv[0]} ENOENT`)
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
  return {
    opened,
    open,
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
