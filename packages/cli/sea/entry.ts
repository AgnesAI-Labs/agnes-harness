async function run(): Promise<void> {
  const { runExecutable } = await import('../src/bin.js')
  await runExecutable()
}

void run().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
