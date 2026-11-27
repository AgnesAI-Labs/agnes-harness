import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [pluginArg, llmsgArg, outputArg] = process.argv.slice(2)
if (!pluginArg || !llmsgArg || !outputArg || process.argv.length !== 5)
  throw new Error(
    'Usage: node integrations/llmsg/prepare-image.mjs <plugin-checkout> <llmsg-checkout> <new-build-directory>',
  )
const plugin = resolve(pluginArg)
const llmsg = resolve(llmsgArg)
const output = resolve(outputArg)
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
for (const repo of [root, plugin, llmsg]) {
  if (git(repo, ['status', '--porcelain', '--untracked-files=normal']))
    throw new Error(`Build source must be committed and clean: ${repo}`)
}
if (existsSync(output)) throw new Error('Build directory already exists; choose a new directory')
const coreRevision = git(root, ['rev-parse', 'HEAD'])
const pluginRevision = git(plugin, ['rev-parse', 'HEAD'])
const llmsgEntrypointRevision = git(llmsg, ['rev-parse', 'HEAD'])
const entrypoint = execFileSync('git', ['-C', root, 'show', `${coreRevision}:integrations/llmsg/start.sh`])
const upstreamEntrypoint = execFileSync('git', [
  '-C',
  llmsg,
  'show',
  `${llmsgEntrypointRevision}:deploy/agh-cloud/start.sh`,
])
if (!entrypoint.equals(upstreamEntrypoint))
  throw new Error('Harness entrypoint differs from the selected CNB commit')
const entrypointSha256 = createHash('sha256').update(entrypoint).digest('hex')
const pluginVersion = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version
mkdirSync(output, { recursive: true })
git(root, ['archive', '--format=tar', `--output=${join(output, 'core-source.tar')}`, coreRevision])
git(plugin, ['archive', '--format=tar', `--output=${join(output, 'plugin-source.tar')}`, pluginRevision])
mkdirSync(join(output, 'packaging'))
writeFileSync(join(output, 'packaging/start.sh'), entrypoint)
copyFileSync(join(root, 'integrations/llmsg/Dockerfile'), join(output, 'Dockerfile'))
writeFileSync(
  join(output, '.dockerignore'),
  '*\n!Dockerfile\n!core-source.tar\n!plugin-source.tar\n!packaging/\n!packaging/start.sh\n',
)
const sources = { coreRevision, pluginRevision, pluginVersion, llmsgEntrypointRevision, entrypointSha256 }
writeFileSync(join(output, 'sources.json'), `${JSON.stringify(sources, null, 2)}\n`)
console.log(JSON.stringify({ output, ...sources }))
