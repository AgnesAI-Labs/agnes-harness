import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Reuse the preset owner's YAML dependency; run after the ordinary frozen dependency install.
const { isMap, parseDocument } = createRequire(new URL('../../packages/code/package.json', import.meta.url))(
  'yaml',
)
const permissions = ['workspace-write']

/** Cloud image build input only. Never rewrite a developer checkout or a running AGH_HOME. */
export function enableCloudCommandNetwork(sourceRoot) {
  const root = resolve(sourceRoot)
  if (existsSync(join(root, '.git')))
    throw new Error('Use an exported cloud build source directory, not a Git checkout')
  const changes = permissions.map((permission) => {
    const name = `permission-${permission}`
    const path = join(root, 'packages/code/presets', `${name}.yaml`)
    const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true })
    const sandbox = document.get('sandbox', true)
    if (
      document.errors.length ||
      document.get('name') !== name ||
      !isMap(sandbox) ||
      sandbox.get('level') !== 'L1' ||
      sandbox.get('loopback_serve') === true
    )
      throw new Error(`Unsupported cloud permission configuration: ${name}`)
    const current = sandbox.get('network_allow', true)?.toJSON()
    if (
      current !== undefined &&
      (!Array.isArray(current) || (current.length !== 0 && !(current.length === 1 && current[0] === '*')))
    )
      throw new Error(`Refusing to replace a custom network policy: ${name}`)
    sandbox.set('network_allow', ['*'])
    const text = document
      .toString()
      .replace('closed command network', 'open command network (cloud image only)')
    return { path, text }
  })
  for (const { path, text } of changes) writeFileSync(path, text)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node integrations/llmsg/command-network.mjs <exported-cloud-source>')
  enableCloudCommandNetwork(process.argv[2])
  console.log('Cloud command network enabled; file restrictions and approval policies retained')
}
