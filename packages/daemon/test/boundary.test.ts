import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const files: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) files.push(p)
  }
}
for (const owner of ['daemon', 'daemon-foundation', 'daemon-rpc']) {
  const source = fileURLToPath(new URL(`../../${owner}/src/local/`, import.meta.url))
  if (existsSync(source)) walk(source)
}

describe('daemon/local boundary', () => {
  it('has files to check at all', () => {
    expect(files.length).toBeGreaterThan(4)
  })

  it('keeps local RPC on owner ports rather than execution implementations', () => {
    for (const f of files) expect(forbiddenImports(readFileSync(f, 'utf8')), f).toEqual([])
  })

  it.each([
    ["import { run } from '@agnes/core/session'", true],
    ["import type { Session } from '@agnes/core-ledger'", true],
    ["import { startSupervisor } from '@agnes/daemon/supervisor/runtime'", true],
    ["export { applyPlanCommand } from '@agnes/base/plan-mode'", true],
    ["const base = await import('@agnes/base/search')", true],
    ["const base = require('@agnes/base')", true],
    ['const unknown = await import(moduleName)', true],
    ["import { ScheduleRejected, createScheduleStore } from '@agnes/base/schedule'", true],
    ["import { spawn } from 'node:child_process'", true],
    ["import { start } from '../../supervisor/start.js'", true],
    ["import { ScheduleRejected as Refusal } from '@agnes/base/schedule'", false],
    ["import { createAppServerAdmin } from '@agnes/daemon-admin/app-server'", false],
    ["import { rpcError } from '@agnes/protocol'", false],
    ['registry.require(sessionId)', false],
  ])('classifies the declared module boundary in %s', (source, refused) => {
    expect(forbiddenImports(source).length > 0).toBe(refused)
  })

  // `f?.g(x) ?? h(x)` where g returns void runs BOTH sides, always: the optional call evaluates to
  // undefined whenever the object is present, so `??` falls through and the right side runs as well.
  // It has cost twice already - host's `opts.killTree?.(pid) ?? process.kill(-pid,'SIGKILL')` killed
  // the process group twice, and this package's `bounded.get(k)?.onEvent(e) ?? f.onEvent(e)` sent
  // every event twice. There is no version of this shape that is a fallback; write if / else.
  const VOID_COALESCE =
    /\?\.[A-Za-z_$][\w$]*\([^)]*\)\s*\?\?\s*[A-Za-z_$][\w$.]*\(|\?\.\([^)]*\)\s*\?\?\s*[A-Za-z_$][\w$.]*\(/

  it('never uses an optional call as the left side of ?? with a call on the right', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(VOID_COALESCE)
  })

  // A house style, no longer the barrier. This reads source text, so it can only see how a name is
  // spelled: a backtick, a name built by concatenation, and a hand-built payload with an unrelated
  // legitimate noticeParams( inside the window all defeated it while it stayed green, and it never
  // looked outside src/local at all. What actually stops a malformed notice now is
  // LocalEndpoint.push(), which validates the frame against METHODS before it can be queued
  // (acp-roundtrip.test.ts, 'outbound validation'). This is kept because one construction site is
  // still the shape we want the code in.
  it('builds every daemon.notice through noticeParams', () => {
    const NAME = "'_agnes/v1/daemon.notice'"
    let sites = 0
    for (const f of files) {
      const t = readFileSync(f, 'utf8')
      // Only construction sites, not mentions: the method also appears as a string in the apis.list
      // family table, and a guard that tripped on that would have to be weakened to something that
      // checks nothing.
      let at = t.indexOf(NAME)
      while (at !== -1) {
        if (/notify\(\s*$/.test(t.slice(Math.max(0, at - 40), at))) {
          sites++
          // A window rather than the same line: the formatter puts the method name and its payload
          // on separate lines, so a same-line check would pass by never matching anything.
          expect(t.slice(at, at + 200), f).toMatch(/noticeParams\(/)
        }
        at = t.indexOf(NAME, at + 1)
      }
      // The other way to put one on the wire is a hand-built envelope. There is no such site.
      expect(t, f).not.toMatch(/method:\s*'_agnes\/v1\/daemon\.notice'/)
    }
    expect(sites).toBeGreaterThan(0)
  })

  it('the guard matches the two shapes that actually shipped and leaves real fallbacks alone', () => {
    expect(VOID_COALESCE.test('bounded.get(key)?.onEvent(e) ?? f.onEvent(e)')).toBe(true)
    expect(VOID_COALESCE.test("opts.killTree?.(pid) ?? process.kill(-pid, 'SIGKILL')")).toBe(true)
    expect(VOID_COALESCE.test('const p = cache?.nodes() ?? []')).toBe(false)
    expect(VOID_COALESCE.test('const n = opts.pollMs ?? defaultPollMs')).toBe(false)
  })
})

/** Settings implementations belong to daemon-admin; local RPC authenticates and dispatches.
 * ScheduleRejected is the existing public refusal marker, not an execution service. */
function forbiddenImports(source: string): string[] {
  const refused: string[] = []
  // Scan static import/export clauses and literal dynamic imports/require calls. Only the named
  // public refusal marker is an exception; implementation imports and computed dynamic imports fail closed.
  const modules =
    /(?:\b(import|export)\s+([^;]*?)\s+from\s*|\bimport\s*|(?<![\w$.])(?:import|require)\s*\(\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(modules)) {
    const value = match[3] ?? ''
    if (/^@agnes\/base(?:\/|$)/.test(value)) {
      if (
        value === '@agnes/base/schedule' &&
        match[1] === 'import' &&
        /^(?:type\s+)?\{\s*(?:type\s+)?ScheduleRejected(?:\s+as\s+[\w$]+)?\s*,?\s*\}$/.test(
          (match[2] ?? '').trim(),
        )
      )
        continue
      refused.push(value)
    } else if (
      /^@agnes\/(?:core(?:-[\w-]+)?|sdk|ai)(?:\/|$)/.test(value) ||
      /^@agnes\/daemon\/supervisor(?:\/|$)/.test(value) ||
      /^(?:\.\.\/)+(?:supervisor|worker)(?:\/|$)/.test(value) ||
      /^node:(?:net|child_process)(?:\/|$)/.test(value)
    )
      refused.push(value)
  }
  if (/(?<![\w$.])import\s*\(\s*(?!['"\s])/.test(source)) refused.push('non-literal module import')
  return refused
}
