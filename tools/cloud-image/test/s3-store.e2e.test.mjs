import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createStore } from '../sync/s3-store.mjs'

test('S3 adapter signs with the current STS on every operation, handles missing manifests and cancels stalled requests', async (t) => {
  const objects = new Map(),
    seen = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({ token: request.headers['x-amz-security-token'], auth: request.headers.authorization })
    const path = request.url.split('?')[0]
    if (path.endsWith('/stall')) return
    if (path.endsWith('/denied')) {
      response.writeHead(403, { 'content-type': 'application/xml' })
      response.end('<Error><Code>AccessDenied</Code><Message>provider-secret-diagnostic</Message></Error>')
    } else if (request.method === 'PUT') {
      objects.set(path, Buffer.concat(chunks))
      response.writeHead(200).end()
    } else if (objects.has(path)) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(objects.get(path))
    } else {
      response
        .writeHead(404, { 'content-type': 'application/xml' })
        .end('<Error><Code>NoSuchKey</Code></Error>')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  let credential = {
    tmp_secret_id: 'fixture-id',
    tmp_secret_key: 'fixture-secret',
    session_token: 'fixture-token',
  }
  // The production configuration validator requires HTTPS. Only this local protocol fixture uses HTTP.
  const store = createStore(
    {
      bucket: 'fixture-bucket',
      region: 'ap-shanghai',
      endpoint: `http://127.0.0.1:${server.address().port}`,
    },
    async () => credential,
  )
  t.after(() => store.close())
  assert.equal(await store.get('epochs/1/missing'), undefined)
  await store.put('epochs/1/manifest.json', { complete: true })
  credential = {
    tmp_secret_id: 'rotated-id',
    tmp_secret_key: 'rotated-secret',
    session_token: 'rotated-token',
  }
  assert.deepEqual(await store.get('epochs/1/manifest.json'), { complete: true })
  assert.equal(seen.at(-1).token, 'rotated-token')
  assert.match(seen.at(-1).auth, /Credential=rotated-id\//)
  assert.ok(seen.every((row) => !row.auth.includes('fixture-secret') && !row.auth.includes('rotated-secret')))
  await assert.rejects(store.put('oversized', { data: 'a'.repeat(16 * 1024 * 1024) }), {
    message: 'SYNC_OBJECT_WRITE_FAILED',
  })
  await assert.rejects(store.get('denied'), { message: 'SYNC_OBJECT_READ_FAILED' })
  await assert.rejects(store.put('denied', {}), { message: 'SYNC_OBJECT_WRITE_FAILED' })
  await assert.rejects(store.get('stall', AbortSignal.timeout(100)), { message: 'SYNC_OBJECT_READ_FAILED' })
})
