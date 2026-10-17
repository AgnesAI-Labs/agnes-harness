// Make a compatible package upgrade; Loop ABI/version stays fixed while implementation changes.
import { cp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const state = JSON.parse(await readFile('/tmp/agh-acme-whitelabel-state.json', 'utf8'))
const destination = resolve(state.root, 'v11')
await cp(resolve('spikes/acme-maintenance'), destination, { recursive: true, filter: path => !path.includes('node_modules') })
const file = `${destination}/package.json`
const manifest = JSON.parse(await readFile(file, 'utf8'))
manifest.version = '1.1.0'
await writeFile(file, JSON.stringify(manifest, null, 2)+'\n')
const client = `${destination}/client/agnes.client.json`
const descriptor = JSON.parse(await readFile(client, 'utf8'))
descriptor.client.publicConfig.version = '1.1.0'
await writeFile(client, JSON.stringify(descriptor, null, 2)+'\n')
const backend = `${destination}/index.mjs`
await writeFile(backend, (await readFile(backend, 'utf8')).replace("revision: '1.0.0'", "revision: '1.1.0'"))
console.log(destination)
