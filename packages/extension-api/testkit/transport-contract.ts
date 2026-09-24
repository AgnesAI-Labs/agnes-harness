import assert from 'node:assert/strict'
import type { RemoteTransport } from '@agnes/core'

/** Commands are supplied by the fixture so the suite requires no particular remote interpreter. */
export type TransportFixture = {
  transport: RemoteTransport
  root: string
  commands: {
    /** Exits with status 7. */
    nonzero: string[]
    /** Prints the appended argv as JSON. */
    argv: string[]
    /** Copies stdin to stdout. */
    stdin: string[]
    /** Prints the value of B1_CONTRACT_ENV. */
    env: string[]
    /** Produces more than 10 output bytes. */
    output: string[]
    /** Reads the appended relative file path and writes its bytes to stdout. */
    readRelative: string[]
  }
  dispose(): Promise<void>
}
export type TransportContractCase = {
  name: string
  tier: 'must' | 'best-effort'
  run(open: () => Promise<TransportFixture>): Promise<void>
}
const enc = (s: string) => new TextEncoder().encode(s)
async function fixture(open: () => Promise<TransportFixture>, run: (f: TransportFixture) => Promise<void>) {
  const f = await open()
  try {
    await run(f)
  } finally {
    try {
      await f.transport.close()
    } finally {
      await f.dispose()
    }
  }
}
export const TRANSPORT_CONTRACT_CASES: readonly TransportContractCase[] = [
  {
    name: 'nonzero execution resolves as data',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        assert.equal((await f.transport.exec(f.commands.nonzero, { cwd: f.root })).code, 7)
      }),
  },
  {
    name: 'argv is preserved literally',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        const args = ['a b', "a'b", '$HOME; echo nope', 'line\nbreak', '']
        const result = await f.transport.exec([...f.commands.argv, ...args], { cwd: f.root })
        assert.equal(result.code, 0)
        assert.deepEqual(JSON.parse(result.stdout), args)
      }),
  },
  {
    name: 'stdin and per-command environment survive',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        assert.equal(
          (await f.transport.exec(f.commands.stdin, { cwd: f.root, stdin: 'input\n' })).stdout,
          'input\n',
        )
        assert.equal(
          (await f.transport.exec(f.commands.env, { cwd: f.root, env: { B1_CONTRACT_ENV: 'value' } })).stdout,
          'value',
        )
      }),
  },
  {
    name: 'per-command cwd selects the relative file',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        for (const name of ['first', 'second'])
          await f.transport.upload([{ path: `${f.root}/${name}/marker`, content: enc(name) }])
        for (const name of ['first', 'second', 'first']) {
          const result = await f.transport.exec([...f.commands.readRelative, 'marker'], {
            cwd: `${f.root}/${name}`,
          })
          assert.equal(result.code, 0)
          assert.equal(result.stdout, name)
        }
      }),
  },
  {
    name: 'binary roundtrip creates missing parents',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        const path = `${f.root}/nested/bytes`
        const content = new Uint8Array([0, 255, 10, 128])
        await f.transport.upload([{ path, content }])
        const got = await f.transport.download([path])
        assert.equal(got.length, 1)
        assert.deepEqual(got[0]?.content, content)
      }),
  },
  {
    name: 'missing download has ENOENT',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        await assert.rejects(f.transport.download([`${f.root}/missing`]), { code: 'ENOENT' })
      }),
  },
  {
    name: 'failed upload retains completed earlier writes',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        const kept = `${f.root}/kept`
        const blocker = `${f.root}/blocker`
        await f.transport.upload([{ path: blocker, content: enc('file') }])
        await assert.rejects(
          f.transport.upload([
            { path: kept, content: enc('kept') },
            { path: `${blocker}/child`, content: enc('no') },
          ]),
          (e: unknown) => {
            assert.ok(e !== null && typeof e === 'object' && 'code' in e)
            assert.ok(['ENOENT', 'ENOTDIR', 'EEXIST', 'EACCES', 'EISDIR', 'UNKNOWN'].includes(String(e.code)))
            return true
          },
        )
        assert.deepEqual((await f.transport.download([kept]))[0]?.content, enc('kept'))
      }),
  },
  {
    name: 'closed channels reject all operations',
    tier: 'must',
    run: (open) =>
      fixture(open, async (f) => {
        await f.transport.close()
        assert.equal(f.transport.alive(), false)
        await assert.rejects(f.transport.exec(f.commands.nonzero, { cwd: f.root }))
        await assert.rejects(f.transport.upload([]))
        await assert.rejects(f.transport.download([]))
      }),
  },
  {
    name: 'output limits report truncation',
    tier: 'best-effort',
    run: (open) =>
      fixture(open, async (f) => {
        const r = await f.transport.exec(f.commands.output, { cwd: f.root, maxOutputBytes: 10 })
        assert.equal(r.truncated, true)
        assert.ok(Buffer.byteLength(r.stdout) <= 10 && Buffer.byteLength(r.stderr) <= 10)
      }),
  },
]
