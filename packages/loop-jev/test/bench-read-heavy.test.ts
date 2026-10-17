import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadSuite } from '../bench/lib.mjs'
import { buildSuite } from '../bench/suites/make-read-heavy.mjs'

const path = new URL('../bench/suites/read-heavy.json', import.meta.url).pathname
const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version']).status === 0)
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A workspace holding the seed files, and a PATH whose `python` is the interpreter found above. */
function seeded(seed: Array<{ name: string; content: string }>) {
  const root = mkdtempSync(join(tmpdir(), 'read-heavy-'))
  dirs.push(root)
  const ws = join(root, 'ws')
  for (const f of seed) {
    mkdirSync(dirname(join(ws, f.name)), { recursive: true })
    writeFileSync(join(ws, f.name), f.content)
  }
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'python'), `#!/bin/sh\nexec ${python} "$@"\n`, { mode: 0o755 })
  const run = (command: string) =>
    spawnSync(command, {
      cwd: ws,
      shell: '/bin/bash',
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
    })
  return { ws, run }
}

describe('the read-heavy suite', () => {
  it('is what the generator writes, and the generator writes the same suite every time', () => {
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(buildSuite())
    expect(JSON.stringify(buildSuite())).toBe(JSON.stringify(buildSuite()))
  })
  it('loads two scenarios of eight turns, each seeded once with 20 to 40 files', () => {
    const s = loadSuite(path)
    expect(s.scenarios.map((x) => [x.id, x.category, x.turns.length])).toEqual([
      ['read-heavy-code', 'read_heavy', 8],
      ['read-heavy-docs', 'read_heavy', 8],
    ])
    for (const x of s.scenarios) {
      const seed = x.turns[0]?.inject_files ?? []
      expect(seed.length).toBeGreaterThanOrEqual(20)
      expect(seed.length).toBeLessThanOrEqual(40)
      expect(new Set(seed.map((f) => f.name)).size).toBe(seed.length)
      expect(x.turns.slice(1).every((t) => t.inject_files === undefined)).toBe(true)
    }
  })
  it('gives every turn one hard probe with its own marker, and every question answer checks', () => {
    const turns = loadSuite(path).scenarios.flatMap((x) => x.turns.map((t, i) => ({ id: x.id, i, t })))
    expect(new Set(turns.map(({ t }) => t.bash?.[0]?.contains)).size).toBe(turns.length)
    for (const { t } of turns) {
      expect(t.bash).toHaveLength(1)
      const [probe] = t.bash ?? []
      expect(probe?.soft).toBeUndefined()
      expect(probe?.command.startsWith("python -B -c '")).toBe(true)
      expect(probe?.command).toContain(`print("${probe?.contains}")`)
    }
    const writes = turns.filter(({ t }) => t.goal.startsWith('Write notes/'))
    expect(writes.map(({ id, i }) => [id, i])).toEqual([
      ['read-heavy-code', 5],
      ['read-heavy-docs', 5],
    ])
    for (const { t } of turns.filter(({ t }) => !t.goal.startsWith('Write ')))
      expect(t.answer_contains?.length ?? 0).toBeGreaterThan(0)
  })
  it('asks in the last turn of each scenario only for answers an earlier turn already checked', () => {
    for (const x of loadSuite(path).scenarios) {
      const earlier = new Set(x.turns.slice(0, -1).flatMap((t) => t.answer_contains ?? []))
      expect(x.turns.at(-1)?.answer_contains?.every((a) => earlier.has(a))).toBe(true)
    }
  })
  it('only checks answers that the seed files spell out, apart from counts', () => {
    for (const x of loadSuite(path).scenarios) {
      const seed = (x.turns[0]?.inject_files ?? []).map((f) => `${f.name}\n${f.content}`.toLowerCase())
      for (const answer of x.turns.flatMap((t) => t.answer_contains ?? [])) {
        if (/^\d+$/.test(answer)) continue
        expect(
          seed.some((text) => text.includes(answer.toLowerCase())),
          answer,
        ).toBe(true)
      }
    }
  })
  it.skipIf(!python)(
    'passes its probes on the untouched seed and fails them once a seed file changes',
    () => {
      for (const x of loadSuite(path).scenarios) {
        const seed = x.turns[0]?.inject_files ?? []
        const { ws, run } = seeded(seed)
        x.turns.forEach((t, i) => {
          const [probe] = t.bash ?? []
          const r = run(probe?.command ?? '')
          // The write turn's probe needs the file the turn writes.
          if (i === 5) expect(r.status).not.toBe(0)
          else expect(r.stdout).toContain(probe?.contains)
        })
        const write = x.turns[5]
        const words = write?.bash?.[0]?.command.match(/for w in (\[.*\]):/)?.[1]
        const note = write?.goal.match(/^Write (\S+)/)?.[1]
        mkdirSync(join(ws, 'notes'), { recursive: true })
        writeFileSync(join(ws, note ?? ''), `${(JSON.parse(words ?? '[]') as string[]).join('\n')}\n`)
        expect(run(write?.bash?.[0]?.command ?? '').stdout).toContain(write?.bash?.[0]?.contains)
        writeFileSync(join(ws, seed[0]?.name ?? ''), 'changed\n')
        const after = run(x.turns[6]?.bash?.[0]?.command ?? '')
        expect(after.status).not.toBe(0)
        expect(after.stderr).toContain('a seed file changed')
      }
    },
  )
})
