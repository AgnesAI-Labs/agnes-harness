import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { enableCloudCommandNetwork } from './command-network.mjs'

const { parse } = createRequire(new URL('../../packages/code/package.json', import.meta.url))('yaml')
const presets = fileURLToPath(new URL('../../packages/code/presets', import.meta.url))

test('cloud build opens workspace command network and retains the other permission contracts', () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-cloud-network-config-'))
  try {
    const destination = join(root, 'packages/code/presets')
    cpSync(presets, destination, { recursive: true })
    const before = new Map(
      ['read-only', 'workspace-write', 'full-access'].map((permission) => {
        const name = `permission-${permission}.yaml`
        return [name, readFileSync(join(destination, name), 'utf8')]
      }),
    )
    enableCloudCommandNetwork(root)
    for (const permission of ['workspace-write']) {
      const name = `permission-${permission}.yaml`
      const original = parse(before.get(name))
      const actual = parse(readFileSync(join(destination, name), 'utf8'))
      assert.deepEqual(actual.sandbox.network_allow, ['*'])
      delete actual.sandbox.network_allow
      assert.deepEqual(actual, original)
      assert.equal(readFileSync(join(presets, name), 'utf8'), before.get(name))
    }
    assert.equal(
      readFileSync(join(destination, 'permission-read-only.yaml'), 'utf8'),
      before.get('permission-read-only.yaml'),
    )
    assert.equal(
      readFileSync(join(destination, 'permission-full-access.yaml'), 'utf8'),
      before.get('permission-full-access.yaml'),
    )
    const once = readFileSync(join(destination, 'permission-workspace-write.yaml'), 'utf8')
    enableCloudCommandNetwork(root)
    assert.equal(readFileSync(join(destination, 'permission-workspace-write.yaml'), 'utf8'), once)
    // Use a parsed custom policy so YAML formatting cannot make this refusal case vacuous.
    const custom = parse(once)
    custom.sandbox.network_allow = ['api.example.com']
    writeFileSync(join(destination, 'permission-workspace-write.yaml'), JSON.stringify(custom))
    assert.throws(() => enableCloudCommandNetwork(root), /custom network policy/)
    mkdirSync(join(root, '.git'))
    assert.throws(() => enableCloudCommandNetwork(root), /not a Git checkout/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
