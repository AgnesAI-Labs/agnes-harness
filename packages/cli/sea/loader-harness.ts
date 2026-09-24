import { dirname } from 'node:path'
import { cacheDir, createLoader } from '@agnes/host'

declare const AGNES_VERSION: string

async function run(): Promise<void> {
  const entry = process.argv[2]
  const home = process.env.AGH_HOME
  if (!entry || !home) throw new Error('usage: loader-harness <extension>; AGH_HOME is required')
  const tools = new Map<string, { execute(): Promise<{ content: { text?: string }[] }> }>()
  const loader = createLoader({
    cacheDir: cacheDir(home),
    hostRoot: dirname(process.execPath),
    agnesVersion: AGNES_VERSION,
  })
  const extension = await loader.import(entry)
  if (typeof extension.default !== 'function') throw new Error('extension has no default factory')
  await extension.default({
    registerTool: (tool: { name: string; execute(): Promise<{ content: { text?: string }[] }> }) =>
      tools.set(tool.name, tool),
  })
  const tool = tools.get('hello_ping')
  if (!tool) throw new Error('extension did not register hello_ping')
  const result = await tool.execute()
  if (result.content[0]?.text !== 'pong') throw new Error('hello_ping did not return pong')
  process.stdout.write('SEA extension test/hello loaded: pong\n')
}

void run().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
