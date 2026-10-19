import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadSuite, type Turn } from '../bench/lib.mjs'
import { buildSuite } from '../bench/suites/make-read-heavy.mjs'

const path = fileURLToPath(new URL('../bench/suites/read-heavy.json', import.meta.url))
// The write probes call `str.removesuffix`, so an interpreter older than Python 3.9 skips the run.
const python = ['python3', 'python'].find(
  (name) =>
    spawnSync(name, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0,
)
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

type SeedFile = { name: string; content: string }
const WRITE_TURN = 5

/** Writes `files` under `ws`, creating directories. */
function put(ws: string, files: SeedFile[]) {
  for (const f of files) {
    mkdirSync(dirname(join(ws, f.name)), { recursive: true })
    writeFileSync(join(ws, f.name), f.content)
  }
}

/** A workspace holding the seed files, and a PATH whose `python` is the interpreter found above. */
function seeded(seed: SeedFile[]) {
  const root = mkdtempSync(join(tmpdir(), 'read-heavy-'))
  dirs.push(root)
  const ws = join(root, 'ws')
  put(ws, seed)
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

const scenarioOf = (id: string) => {
  const found = loadSuite(path).scenarios.find((x) => x.id === id)
  if (!found) throw new Error(`no scenario ${id}`)
  return found
}
const seedOf = (turns: Turn[]) => turns[0]?.inject_files ?? []
const content = (seed: SeedFile[], name: string) => seed.find((f) => f.name === name)?.content ?? ''
const answers = (t: Turn | undefined) => t?.answer_contains ?? []

/**
 * The answers recomputed from the seed files by rules of their own, not by the generator's: a
 * change to a seed file that moves an answer fails here instead of passing silently.
 */
function recomputed() {
  const code = seedOf(scenarioOf('read-heavy-code').turns)
  const modules = code.filter(
    (f) => /^src\/tallyhouse\/.+\.py$/.test(f.name) && !f.name.endsWith('/__init__.py'),
  )
  const callsBy = new Map<string, number>()
  for (const f of code.filter((x) => x.name.startsWith('src/'))) {
    const n = f.content
      .split('\n')
      .filter((l) => /\baudit_log\(/.test(l) && !/\bdef audit_log\(/.test(l)).length
    if (n > 0) callsBy.set(f.name.replace(/^.*\//, '').replace(/\.py$/, ''), n)
  }
  const docs = seedOf(scenarioOf('read-heavy-docs').turns)
  const runbooks = docs.filter((f) => f.name.startsWith('runbooks/'))
  const kestrel = runbooks.filter((f) => /^Owner: kestrel$/m.test(f.content)).map((f) => f.name.slice(9))
  const onLedgerd = docs
    .filter((f) => f.name.startsWith('services/') && /^Depends on: .*\bledgerd\b/m.test(f.content))
    .map((f) => f.name.slice(9, -3))
  // One escalation hop from beacon: its runbook link, then that runbook's escalation link.
  const first = content(docs, 'services/beacon.md').match(/\(\.\.\/runbooks\/([^)]+)\)/)?.[1] ?? ''
  const hop = content(docs, `runbooks/${first}`).match(/continue with \[[^\]]+\]\(([^)]+)\)/)?.[1] ?? ''
  const hopText = content(docs, `runbooks/${hop}`)
  const hopOwner = hopText.match(/^Owner: (\S+)$/m)?.[1] ?? ''
  return {
    modules: modules.length,
    calls: [...callsBy.values()].reduce((a, b) => a + b, 0),
    callsBy,
    runbooks: runbooks.length,
    kestrel,
    onLedgerd,
    hopTitle: hopText.match(/^# (.+)$/m)?.[1] ?? '',
    hopChannel: content(docs, `teams/${hopOwner}.md`).match(/^Pages: #(\S+)$/m)?.[1] ?? '',
  }
}

describe('the read-heavy suite', () => {
  it('is what the generator writes, and the generator writes the same suite every time', () => {
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(buildSuite())
    expect(JSON.stringify(buildSuite())).toBe(JSON.stringify(buildSuite()))
  })
  it('loads two long scenarios, each seeded once with 20 to 40 files and later changed only in place', () => {
    const s = loadSuite(path)
    expect(s.scenarios.map((x) => [x.id, x.category])).toEqual([
      ['read-heavy-code', 'read_heavy'],
      ['read-heavy-docs', 'read_heavy'],
    ])
    for (const x of s.scenarios) {
      expect(x.turns.length).toBeGreaterThanOrEqual(12)
      expect(x.turns.length).toBeLessThanOrEqual(14)
      const seed = seedOf(x.turns)
      expect(seed.length).toBeGreaterThanOrEqual(20)
      expect(seed.length).toBeLessThanOrEqual(40)
      const names = new Set(seed.map((f) => f.name))
      expect(names.size).toBe(seed.length)
      const later = x.turns.slice(1).flatMap((t) => t.inject_files ?? [])
      expect(later.length).toBeGreaterThan(0)
      for (const f of later) expect(names.has(f.name), f.name).toBe(true)
    }
  })
  it('gives every turn one hard probe with its own marker, and every question has answer checks', () => {
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
      ['read-heavy-code', WRITE_TURN],
      ['read-heavy-docs', WRITE_TURN],
    ])
    for (const { t } of turns.filter(({ t }) => !t.goal.startsWith('Write ')))
      expect(answers(t).length).toBeGreaterThan(0)
  })
  it('asks in the last turn of each scenario only for answers an earlier turn already checked', () => {
    for (const x of loadSuite(path).scenarios) {
      const earlier = new Set(x.turns.slice(0, -1).flatMap(answers))
      expect(answers(x.turns.at(-1)).every((a) => earlier.has(a))).toBe(true)
    }
  })
  it('checks every count with a marker line, never a bare number', () => {
    for (const x of loadSuite(path).scenarios)
      for (const a of x.turns.flatMap(answers)) expect(/^\d+$/.test(a), a).toBe(false)
  })
  it('only checks names that the seed files spell out', () => {
    for (const x of loadSuite(path).scenarios) {
      const text = x.turns
        .flatMap((t) => t.inject_files ?? [])
        .map((f) => `${f.name}\n${f.content}`.toLowerCase())
      for (const answer of x.turns.flatMap(answers)) {
        // `KEY=value` and `name=n,team` lines: each part is a marker key, a number or a seed name.
        for (const part of answer.split(/[=,]/)) {
          if (/^\d+$/.test(part) || /^[A-Z_]+$/.test(part)) continue
          expect(
            text.some((t) => t.includes(part.toLowerCase())),
            `${answer}: ${part}`,
          ).toBe(true)
        }
      }
    }
  })
  it('checks the counts and the escalation hop that the seed files give when read independently', () => {
    const r = recomputed()
    expect([r.modules, r.calls, r.runbooks, r.kestrel.length, r.onLedgerd.length]).toEqual([16, 6, 11, 4, 3])
    const code = scenarioOf('read-heavy-code').turns
    expect(answers(code[0])).toContain(`MODULES=${r.modules}`)
    expect(answers(code[4])).toContain(`CALLS=${r.calls}`)
    expect(answers(code[4])).toEqual(expect.arrayContaining([...r.callsBy.keys()]))
    expect(answers(code[11]).sort()).toEqual([...r.callsBy].map(([m, n]) => `${m}=${n}`).sort())
    const docs = scenarioOf('read-heavy-docs').turns
    expect(answers(docs[0])).toContain(`RUNBOOKS=${r.runbooks}`)
    expect(answers(docs[2])).toEqual([r.hopTitle, r.hopChannel])
    expect(answers(docs[3])).toEqual([`COUNT=${r.kestrel.length}`, ...r.kestrel])
    expect(answers(docs[6])).toEqual([...r.onLedgerd, `DIRECT_COUNT=${r.onLedgerd.length}`])
  })
  // The probe runs through a `#!/bin/sh` python shim, which Windows cannot execute.
  it.skipIf(!python || process.platform === 'win32')(
    'passes its probes on a run that answers right, and fails them on a wrong note or a changed workspace',
    () => {
      const r = recomputed()
      const notes = {
        'read-heavy-code': {
          right: '- `accounts.py`\n* batch\nsrc/tallyhouse/ledger.py\n\nreconcile\n',
          superset: [...r.callsBy.keys(), 'report'].join('\n'),
          subset: [...r.callsBy.keys()].slice(1).join('\n'),
        },
        'read-heavy-docs': {
          right: `- \`runbooks/${r.kestrel[0]}\`\n${r.kestrel[1]?.replace(/\.md$/, '')}\n${r.kestrel.slice(2).join('\n')}\n`,
          superset: [...r.kestrel, 'dns-failover.md'].join('\n'),
          subset: r.kestrel.slice(1).join('\n'),
        },
      }
      for (const x of loadSuite(path).scenarios) {
        const { ws, run } = seeded(seedOf(x.turns))
        const note = join(ws, x.turns[WRITE_TURN]?.goal.match(/^Write (\S+)/)?.[1] ?? '')
        const variants = notes[x.id as keyof typeof notes]
        x.turns.forEach((t, i) => {
          if (i > 0) put(ws, t.inject_files ?? [])
          const command = t.bash?.[0]?.command ?? ''
          if (i === WRITE_TURN) {
            // The write turn's probe needs the file the turn writes, listing exactly the right names.
            expect(run(command).status).not.toBe(0)
            mkdirSync(dirname(note), { recursive: true })
            for (const wrong of [variants.superset, variants.subset]) {
              writeFileSync(note, `${wrong}\n`)
              const out = run(command)
              expect(out.status).not.toBe(0)
              expect(out.stderr).toContain('the note lists')
            }
            writeFileSync(note, variants.right)
          }
          expect(run(command).stdout, `${x.id} turn ${i + 1}`).toContain(t.bash?.[0]?.contains)
        })
        const last = x.turns.at(-1)?.bash?.[0]
        // Hidden entries, caches and other files under notes/ are not counted.
        put(ws, [
          { name: '.cache/state', content: 'x' },
          { name: '__pycache__/m.pyc', content: 'x' },
          { name: 'notes/extra.md', content: 'x' },
        ])
        expect(run(last?.command ?? '').stdout).toContain(last?.contains)
        writeFileSync(join(ws, 'scratch.txt'), 'x')
        const added = run(last?.command ?? '')
        expect(added.status).not.toBe(0)
        expect(added.stderr).toContain('a file was added or removed outside notes/')
        rmSync(join(ws, 'scratch.txt'))
        writeFileSync(join(ws, seedOf(x.turns)[0]?.name ?? ''), 'changed\n')
        const changed = run(last?.command ?? '')
        expect(changed.status).not.toBe(0)
        expect(changed.stderr).toContain('a seed file changed')
      }
    },
  )
})
