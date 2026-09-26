// Deep Bug Hunt M-09 (adversarial-tester, group B). Assertions describe CORRECT behaviour:
// a failure on the current code is the reproduction.
//
// Oracle: INV-04 (every exit path restores the terminal) and app.ts's own failure handling -- every
// other editor callback failure is routed to showError (app.ts onSubmit/onCancelKey), never thrown out
// of the terminal input callback. A synchronous throw from the input handler escapes Renderer's
// onInput -> NodeTerminal's stdin 'data' listener.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { completeToken } from '../../src/tui/commands.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const SID = 'agnes:local:default:cli:dm:m09'

function endpoint() {
  return new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: SID }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId: SID,
      upto: 0,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
    }))
}

async function withApp(cwd: string, body: (term: FakeTerminal) => void | Promise<void>) {
  const ep = endpoint()
  const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  // vitest workers cannot process.chdir(); pin the value app.ts passes to completeToken instead.
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  try {
    await app.start()
    await body(term)
  } finally {
    spy.mockRestore()
    await app.stop()
    await client.close()
    await ep.close()
  }
}

function fixtureDirs() {
  const base = mkdtempSync(join(tmpdir(), 'dbh-m09-'))
  const readable = join(base, 'readable')
  const unreadable = join(base, 'unreadable')
  mkdirSync(readable)
  mkdirSync(unreadable)
  writeFileSync(join(readable, 'xfile.txt'), '')
  // Search (x) but no read (r): a user can `cd` here and start the TUI, readdir fails with EACCES.
  chmodSync(unreadable, 0o311)
  return {
    base,
    readable,
    unreadable,
    cleanup: () => {
      chmodSync(unreadable, 0o755)
      rmSync(base, { recursive: true, force: true })
    },
  }
}

it('[control] Tab completion of @token in a readable cwd does not throw and completes', async () => {
  const dirs = fixtureDirs()
  try {
    await withApp(dirs.readable, async (term) => {
      term.feed('@x')
      expect(() => term.feed('\t')).not.toThrow()
      await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('@xfile.txt '))
    })
  } finally {
    dirs.cleanup()
  }
})

it('[M-09] Tab completion of @token in an unreadable cwd does not throw out of the input callback', async () => {
  const dirs = fixtureDirs()
  try {
    await withApp(dirs.unreadable, async (term) => {
      term.feed('@x')
      expect(() => term.feed('\t')).not.toThrow()
      // Nothing to offer, as with a prefix that matches nothing: the draft is left as typed and the editor
      // keeps taking keys.
      term.feed('y')
      await vi.waitFor(async () => expect((await screenOf(term, 80, 24)).join('\n')).toContain('@xy'))
    })
  } finally {
    dirs.cleanup()
  }
})

it('[M-09/unit] completeToken offers no @path in an unreadable or missing cwd; slash commands still complete', () => {
  const dirs = fixtureDirs()
  try {
    for (const cwd of [dirs.unreadable, '/nonexistent-agnes-dbh-m09']) {
      expect(() => completeToken('@x', cwd), cwd).not.toThrow()
      expect(completeToken('@x', cwd), cwd).toEqual([])
      expect(completeToken('/he', cwd), cwd).toEqual(['/help'])
    }
    expect(completeToken('@x', dirs.readable)).toEqual(['@xfile.txt'])
  } finally {
    dirs.cleanup()
  }
})

it('[M-09b] Tab completion of @token in a missing cwd does not throw out of the input callback', async () => {
  await withApp('/nonexistent-agnes-dbh-m09', (term) => {
    term.feed('@x')
    expect(() => term.feed('\t')).not.toThrow()
  })
})

// Second, independent dynamic source: a real child Node process (tsx) drives the real NodeTerminal
// through an EventEmitter stdin (no TTY needed), started with a real unreadable working directory
// (no process.cwd mock). Observed at process level: exit code and whether the alternate screen was
// left (`\x1b[?1049l`) before the process ended.
const ROOT = resolve(import.meta.dirname, '../../../..')
// The child's imports need file URLs: a bare Windows path is not an ESM specifier, and its
// backslashes would be read as escapes inside the generated string literal.
const source = (path: string): string => JSON.stringify(pathToFileURL(join(ROOT, path)).href)
const CHILD = `
import { EventEmitter } from 'node:events'
import { createClient } from ${source('packages/sdk/src/index.node.ts')}
import { TuiApp, NodeTerminal } from ${source('packages/cli-tui/src/index.ts')}
import { FakeEndpoint } from ${source('packages/cli/test/fake-endpoint.ts')}
const out = []
const stdout = Object.assign(new EventEmitter(), { columns: 80, rows: 24, write: (s) => { out.push(s); return true } })
const stdin = Object.assign(new EventEmitter(), { setRawMode() {}, resume() {}, pause() {}, setEncoding() {} })
let stopped = false
process.on('exit', (code) => {
  const all = out.join('')
  process.stderr.write('\\nRESULT ' + JSON.stringify({ code, stopped, entered: all.includes('\\x1b[?1049h'), restored: all.includes('\\x1b[?1049l') }) + '\\n')
})
const SID = '${SID}'
const ep = new FakeEndpoint()
  .on('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, _meta: { agnes: { agnesVersion: '0' } } }))
  .on('session/new', () => ({ sessionId: SID }))
  .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
  .on('_agnes/v1/session.detach', () => ({}))
  .on('_agnes/v1/session.projectUI', () => ({ sessionId: SID, upto: 0, generation: 1, opState: null, turns: [], nodes: [] }))
const client = createClient({ transport: { kind: 'inproc', endpoint: ep } })
const session = await client.session.new({ cwd: '/tmp' })
const term = new NodeTerminal(stdin, stdout, { NO_COLOR: '1' })
const app = new TuiApp({ session, term, header: 'Agnes' })
await app.start()
setTimeout(async () => {
  stdin.emit('data', '@x')
  stdin.emit('data', '\\t')
  await app.stop()
  stopped = true
  await client.close()
  await ep.close()
}, 50)
`

function runChild(cwd: string) {
  const scriptDir = mkdtempSync(join(tmpdir(), 'dbh-m09-child-'))
  try {
    const script = join(scriptDir, 'child.mts')
    writeFileSync(script, CHILD)
    const r = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, script],
      {
        cwd,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 60_000,
      },
    )
    const line = r.stderr.split('\n').find((l) => l.startsWith('RESULT '))
    return {
      status: r.status,
      result: line ? (JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>) : undefined,
      uncaught: /EACCES|ENOENT/.test(r.stderr)
        ? r.stderr.split('\n').find((l) => /Error:/.test(l))
        : undefined,
      stack: r.stderr
        .split('\n')
        .filter((l) => /^\s+at .*packages\/cli-tui\/src/.test(l))
        .map((l) => l.trim().replace(`${ROOT}/`, ''))
        .slice(0, 6),
    }
  } finally {
    rmSync(scriptDir, { recursive: true, force: true })
  }
}

it('[control/process] real NodeTerminal in a readable cwd: Tab is handled and the terminal is restored', () => {
  const dirs = fixtureDirs()
  try {
    const seen = runChild(dirs.readable)
    expect(seen.result, JSON.stringify(seen)).toMatchObject({ code: 0, stopped: true, restored: true })
  } finally {
    dirs.cleanup()
  }
}, 90_000)

it('[M-09/process] real NodeTerminal in an unreadable cwd: Tab must not crash the process or strand the terminal', () => {
  const dirs = fixtureDirs()
  try {
    const seen = runChild(dirs.unreadable)
    expect(seen.result, JSON.stringify(seen)).toMatchObject({ code: 0, stopped: true, restored: true })
  } finally {
    dirs.cleanup()
  }
}, 90_000)
