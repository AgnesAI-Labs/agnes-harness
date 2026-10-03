import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { must } from '../../../../packages/host/test/runtime/network-secrets-fixture.js'
import { fixture } from '../../../../packages/host/test/runtime/sandbox-exec-fixture.js'

const [kind, directory, mode] = process.argv.slice(2)
if ((kind !== 'default' && kind !== 'reference') || !directory) throw new Error('Invalid fixture arguments')
const f = await fixture(kind, directory)
const admitted = await f.ready()
const call = f.auth.call()
const input = f.request(
  admitted,
  mode === 'lost'
    ? ['/usr/bin/touch', join(f.roots.workspace, 'effect')]
    : [process.execPath, join(f.roots.workspace, 'workload.mjs'), 'escape', join(f.roots.workspace, 'pids')],
)
writeFileSync(
  join(directory, 'agent.json'),
  JSON.stringify({
    admitted,
    input,
    invocationId: call.invocationId,
    bindingId: call.bindingId,
    executionId: createHash('sha256').update(`${call.bindingId}/${call.invocationId}`).digest('hex'),
    roots: f.roots,
    policy: f.policy,
  }),
)
const reply = await f.exec.run(input, call)
if (mode === 'lost') {
  must(reply)
  writeFileSync(join(directory, 'persisted'), 'ready')
  // Simulate a response lost after the durable result, with no result delivered to the caller.
  await new Promise<void>((resolve) => setTimeout(resolve, 30000))
} else process.stdout.write(`${JSON.stringify(reply)}\n`)
