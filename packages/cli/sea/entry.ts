import { trimNativeHeap } from '@agnes/system-node'

async function run(): Promise<void> {
  const { runExecutable } = await import('../src/bin.js')
  // The bundle is parsed and compiled: hand the memory V8 freed doing that back to the OS.
  void trimNativeHeap()
  await runExecutable()
}

void run().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
