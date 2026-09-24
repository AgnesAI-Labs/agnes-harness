import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const local = fileURLToPath(new URL('../src/local/', import.meta.url))
const files: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (e.endsWith('.ts')) files.push(p)
  }
}
walk(local)

describe('daemon/local boundary', () => {
  it('has files to check at all', () => {
    expect(files.length).toBeGreaterThan(4)
  })

  it('never imports supervisor, worker, node:net or node:child_process', () => {
    for (const f of files) {
      const t = readFileSync(f, 'utf8')
      expect(t, f).not.toMatch(/from ['"]\.\.\/(supervisor|worker)\//)
      expect(t, f).not.toMatch(/from ['"]node:(net|child_process)['"]/)
      expect(t, f).not.toMatch(/from ['"]@agnes\/(core|sdk|base|ai)['"]/)
    }
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
