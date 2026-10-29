import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localRegistry } from './local-registry.js'
import { PUBLIC_PACKAGE_NAME, PUBLIC_PACKAGE_VERSION, publishableManifest } from './npx-package.js'

function publication(candidate: Buffer) {
  return {
    name: PUBLIC_PACKAGE_NAME,
    versions: {
      [PUBLIC_PACKAGE_VERSION]: {
        ...publishableManifest('darwin-arm64'),
        dist: {
          shasum: createHash('sha1').update(candidate).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(candidate).digest('base64')}`,
          tarball: 'https://registry.npmjs.org/should-never-be-used.tgz',
        },
      },
    },
    _attachments: { 'candidate.tgz': { data: candidate.toString('base64'), length: candidate.length } },
  }
}

it('serves only the expected candidate on loopback and refuses malformed or foreign uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-local-registry-test-'))
  const candidate = Buffer.from('synthetic candidate; no executable runtime')
  const registry = await localRegistry(root, candidate)
  const endpoint = `${registry.url}/${encodeURIComponent(PUBLIC_PACKAGE_NAME)}`
  const publish = (body: unknown) =>
    fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    expect(new URL(registry.url).hostname).toBe('127.0.0.1')
    expect((await fetch(endpoint)).status).toBe(404)
    expect((await fetch(`${registry.url}/some-other-package`)).status).toBe(404)
    expect((await fetch(`${registry.url}/%ZZ`)).status).toBe(400)
    expect((await publish(publication(Buffer.from('unreviewed payload')))).status).toBe(400)
    const corrupted = publication(candidate)
    corrupted._attachments['candidate.tgz'].length += 1
    expect((await publish(corrupted)).status).toBe(400)
    expect((await publish({ ...publication(candidate), name: '@other/package' })).status).toBe(400)
    expect((await publish(publication(candidate))).status).toBe(201)
    expect((await publish(publication(candidate))).status).toBe(409)
    const packument = (await (await fetch(endpoint)).json()) as {
      versions: Record<string, { dist: { tarball: string } }>
    }
    const url = packument.versions[PUBLIC_PACKAGE_VERSION]?.dist.tarball
    expect(url).toBe(`${registry.url}/candidate.tgz`)
    const installed = Buffer.from(await (await fetch(url ?? '')).arrayBuffer())
    expect(installed).toEqual(candidate)
    expect(await readFile(join(root, 'candidate.tgz'))).toEqual(candidate)
  } finally {
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})
