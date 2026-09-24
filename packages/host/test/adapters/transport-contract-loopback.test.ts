import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRANSPORT_CONTRACT_CASES, type TransportFixture } from '@agnes/extension-api/testkit'
import { expect, it } from 'vitest'
import { createLoopbackTransport } from '../../src/adapters/remote-transport.js'

const open = async (): Promise<TransportFixture> => {
  const root = mkdtempSync(join(tmpdir(), 'b1-contract-'))
  const node = (script: string) => [process.execPath, '-e', script, '--']
  return {
    root,
    transport: createLoopbackTransport({ root }),
    commands: {
      nonzero: node('process.exit(7)'),
      argv: node('process.stdout.write(JSON.stringify(process.argv.slice(1)))'),
      stdin: node('process.stdin.pipe(process.stdout)'),
      env: node('process.stdout.write(process.env.B1_CONTRACT_ENV)'),
      output: node('process.stdout.write("x".repeat(100))'),
      readRelative: node('process.stdout.write(require("node:fs").readFileSync(process.argv[1]))'),
    },
    dispose: async () => rmSync(root, { recursive: true, force: true }),
  }
}
for (const c of TRANSPORT_CONTRACT_CASES) {
  // Stage A loopback deliberately does not enforce its output cap.
  const test = c.tier === 'must' ? it : it.skip
  test(c.name, () => c.run(open))
}

it('cwd contract rejects a transport pinned to the first command directory', async () => {
  const contract = TRANSPORT_CONTRACT_CASES.find(
    (c) => c.name === 'per-command cwd selects the relative file',
  )
  if (!contract) throw new Error('cwd contract case is missing')
  await expect(
    contract.run(async () => {
      const f = await open()
      const original = f.transport
      let firstCwd: string | undefined
      return {
        ...f,
        transport: {
          ...original,
          exec: (cmd, opts) => {
            firstCwd ??= opts.cwd
            return original.exec(cmd, { ...opts, cwd: firstCwd })
          },
        },
      }
    }),
  ).rejects.toThrow()
})
