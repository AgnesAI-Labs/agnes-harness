// Runs unchanged in plain Node and an injected SEA; each also loads the addon in a worker isolate.
function verify(addonPath) {
  const assert = require('node:assert/strict')
  const { createHash } = require('node:crypto')
  const fs = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join } = require('node:path')
  const loaded = { exports: {} }
  process.dlopen(loaded, addonPath)
  const api = loaded.exports
  assert.equal(api.abiVersion, 1)
  const root = fs.mkdtempSync(join(tmpdir(), 'agnes-native-crypto-'))
  try {
    for (const size of [0, 1, 64, 65536, 65537, 300000]) {
      const bytes = Buffer.alloc(size, 0xa5)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const relative = `${hash.slice(0, 2)}/${hash}`
      fs.mkdirSync(join(root, hash.slice(0, 2)), { recursive: true, mode: 0o700 })
      const path = join(root, relative)
      fs.writeFileSync(path, Buffer.from('incorrect contents'), { mode: 0o600 })
      assert.throws(() => api.deletePrivateArtifact(root, relative, hash), { code: 'EINVAL' })
      assert.equal(fs.existsSync(path), true)
      fs.writeFileSync(path, bytes)
      assert.equal(api.deletePrivateArtifact(root, relative, hash), BigInt(size))
      assert.equal(fs.existsSync(path), false)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const { isSea } = require('node:sea')
const { Worker } = require('node:worker_threads')
const addon = process.argv[2]
if (!addon) throw new Error('Expected an absolute native addon path')
verify(addon)
const worker = new Worker(`(${verify.toString()})(require('node:worker_threads').workerData)`, {
  eval: true,
  workerData: addon,
})
worker.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
worker.once('exit', (code) => {
  if (code !== 0) process.exitCode = 1
  else console.log(`${process.version}: ${isSea() ? 'SEA' : 'Node'} SHA-256, refusal and worker smoke passed`)
})
