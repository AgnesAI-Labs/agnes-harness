import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { PUBLIC_PACKAGE_NAME, PUBLIC_PACKAGE_VERSION } from './npx-package.js'

/** Minimal npm publish/packument/tarball protocol, no auth, uplinks or configurable address.
 * Only the already-reviewed candidate can be uploaded. Lives inside the smoke temp directory.
 */
export async function localRegistry(root: string, candidate: Buffer) {
  const expectedIntegrity = `sha512-${createHash('sha512').update(candidate).digest('base64')}`
  const maxUploadBytes = Math.ceil((candidate.length * 4) / 3) + 1024 * 1024
  let metadata: Record<string, unknown> | undefined
  let registry = ''
  const tarPath = '/candidate.tgz'
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    function json(status: number, body: unknown): void {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    try {
      const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
      requests.push(`${request.method} ${path}`)
      if (request.method === 'GET' && path === '/-/ping') return json(200, {})
      if (request.method === 'GET' && path === tarPath && metadata) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(await readFile(join(root, 'candidate.tgz')))
        return
      }
      if (path !== `/${PUBLIC_PACKAGE_NAME}`) return json(404, { error: 'Local candidate only; no uplinks' })
      if (request.method === 'GET')
        return json(metadata ? 200 : 404, metadata ?? { error: 'Not published locally' })
      if (request.method !== 'PUT') return json(405, { error: 'Method not supported' })
      if (metadata) return json(409, { error: 'Candidate already published' })
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > maxUploadBytes) return json(413, { error: 'Candidate too large' })
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const version = body.versions?.[PUBLIC_PACKAGE_VERSION]
      const attachments = Object.values(body._attachments ?? {}) as { data: string; length: number }[]
      if (
        body.name !== PUBLIC_PACKAGE_NAME ||
        !version ||
        version.name !== PUBLIC_PACKAGE_NAME ||
        version.version !== PUBLIC_PACKAGE_VERSION ||
        Object.keys(body.versions).length !== 1 ||
        attachments.length !== 1
      )
        return json(400, { error: 'Unexpected candidate identity' })
      const tarball = Buffer.from(attachments[0]?.data ?? '', 'base64')
      if (!tarball.length || tarball.length !== attachments[0]?.length)
        return json(400, { error: 'Invalid attachment' })
      const shasum = createHash('sha1').update(tarball).digest('hex')
      const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
      if (
        version.dist?.shasum !== shasum ||
        version.dist?.integrity !== integrity ||
        integrity !== expectedIntegrity
      )
        return json(400, { error: 'Attachment integrity mismatch' })
      version.dist = { shasum, integrity, tarball: `${registry}${tarPath}` }
      const packument = {
        name: body.name,
        'dist-tags': { latest: PUBLIC_PACKAGE_VERSION },
        versions: { [PUBLIC_PACKAGE_VERSION]: version },
      }
      await writeFile(join(root, 'candidate.tgz'), tarball)
      await writeFile(join(root, 'packument.json'), JSON.stringify(packument))
      metadata = packument
      json(201, { ok: true, id: body.name })
    } catch {
      json(400, { error: 'Invalid local publish request' })
    }
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local registry did not bind')
  registry = `http://127.0.0.1:${address.port}`
  return {
    url: registry,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
    },
  }
}
