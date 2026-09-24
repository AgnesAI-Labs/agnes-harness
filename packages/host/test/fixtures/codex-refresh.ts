import { codexCredentials } from '../../src/adapters/codex-credentials.js'

const [home, ref, mode] = process.argv.slice(2)
if (!home || !ref) throw new Error('missing fixture args')
await codexCredentials(home, ref).modify('openai-codex', async (current) => {
  if (current?.type !== 'oauth') throw new Error('missing fixture credential')
  if (mode === 'hold') {
    process.stdout.write('LOCKED\n')
    await new Promise(() => {
      setInterval(() => {}, 1000)
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 75))
  return { ...current, expires: current.expires + 1 }
})
