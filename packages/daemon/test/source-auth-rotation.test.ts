import { describe, expect, it } from 'vitest'
import { signSourceAuth, sourceAuthCanonical, verifyAuth } from '../src/local/auth.js'
import { SourceAuthRotation } from '../src/storage/source-auth-rotation.js'
import { sqliteTables } from './sqlite-tables.js'

describe('SourceAuthRotation', () => {
  const sourceCredential = (name: string, secret = [name, 'low', 'entropy', 'key'].join('-')) => ({
    credentialId: `secret://agnes/${name}`,
    secret,
  })

  it('persists rotation start and refuses the previous key after grace across restart', async () => {
    const tables = sqliteTables()
    const initial = new SourceAuthRotation(tables.table('rotation'))
    const old = sourceCredential('old')
    const current = sourceCredential('current')
    initial.configure([old], 1_000)
    const stored = tables
      .table('rotation')
      .get<Record<string, unknown>>('SELECT * FROM source_auth_keyring_v3 WHERE singleton = 1')
    expect(JSON.stringify(stored)).not.toContain(old.secret)
    expect(stored).toMatchObject({ current_credential_id: old.credentialId })
    const oldId = initial.accepted([old], 1_000, 500)[0]?.keyId
    const rotated = new SourceAuthRotation(tables.table('rotation'))
    rotated.configure([current, old], 2_000)
    expect(rotated.accepted([current, old], 2_499, 500).map((key) => key.secret)).toEqual([
      current.secret,
      old.secret,
    ])
    expect(rotated.accepted([current, old], 2_500, 500).map((key) => key.secret)).toEqual([current.secret])
    expect(rotated.accepted([current, old], 2_499, 500)[1]?.keyId).toBe(oldId)
    await tables.close()
  })

  it('does not accept an arbitrary configured previous key that was never current', async () => {
    const tables = sqliteTables()
    const rotation = new SourceAuthRotation(tables.table('rotation'))
    const current = sourceCredential('current')
    rotation.configure([current], 1_000)
    expect(
      rotation.accepted([current, sourceCredential('attacker-chosen')], 1_100, 500).map((key) => key.secret),
    ).toEqual([current.secret])
    await tables.close()
  })

  it('drops the verifier-bearing v2 table during migration', async () => {
    const tables = sqliteTables()
    const table = tables.table('rotation')
    table.exec('CREATE TABLE source_auth_keyring_v2 (singleton INTEGER PRIMARY KEY, current_verifier TEXT)')
    table.exec('INSERT INTO source_auth_keyring_v2 VALUES (1, ?)', ['offline-verifier'])
    new SourceAuthRotation(table)
    expect(
      table.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_auth_keyring_v2'"),
    ).toBeUndefined()
    await tables.close()
  })

  it('does not resurrect a configured previous key when verifier-bearing v2 state is migrated', async () => {
    const tables = sqliteTables()
    const table = tables.table('rotation')
    table.exec('CREATE TABLE source_auth_keyring_v2 (singleton INTEGER PRIMARY KEY, current_verifier TEXT)')
    table.exec('INSERT INTO source_auth_keyring_v2 VALUES (1, ?)', ['unusable-offline-verifier'])
    const rotation = new SourceAuthRotation(table)
    const current = sourceCredential('current')
    const previous = sourceCredential('previous')
    rotation.configure([current, previous], 10_000)
    expect(rotation.accepted([current, previous], 10_001, 60_000).map((key) => key.secret)).toEqual([
      current.secret,
    ])
    await tables.close()
  })

  it('preserves the current opaque principal id while removing the v2 verifier', async () => {
    const tables = sqliteTables()
    const table = tables.table('rotation')
    const existingKeyId = 'a'.repeat(32)
    table.exec(
      'CREATE TABLE source_auth_keyring_v2 (singleton INTEGER PRIMARY KEY, current_verifier TEXT, current_key_id TEXT)',
    )
    table.exec('INSERT INTO source_auth_keyring_v2 VALUES (1, ?, ?)', ['offline-verifier', existingKeyId])
    const rotation = new SourceAuthRotation(table)
    const current = sourceCredential('current')
    rotation.configure([current], 10_000)
    expect(rotation.accepted([current], 10_001, 60_000)[0]?.keyId).toBe(existingKeyId)
    expect(JSON.stringify(table.get('SELECT * FROM source_auth_keyring_v3'))).not.toContain(
      'offline-verifier',
    )
    await tables.close()
  })

  it('re-evaluates previous-key expiry at each authentication in a long-running process', async () => {
    const tables = sqliteTables()
    const rotation = new SourceAuthRotation(tables.table('rotation'))
    const old = sourceCredential('old', 'old')
    const current = sourceCredential('current', 'new')
    rotation.configure([old], 1_000)
    rotation.configure([current, old], 2_000)
    let now = 2_499
    const params: Record<string, unknown> = {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: { 'ai.agnes.harness': { clientId: 'adapter' } },
    }
    const credential = (nonce: string) => ({
      kind: 'source-auth' as const,
      timestamp: 2,
      nonce,
      signature: signSourceAuth('old', 2, nonce, sourceAuthCanonical('adapter', params)),
    })
    const check = (nonce: string) =>
      verifyAuth({
        auth: credential(nonce),
        clientId: 'adapter',
        params,
        config: {
          transport: 'ws',
          sourceAuthKeys: () => rotation.accepted([current, old], now, 500),
        },
        now,
        nonces: { consume: () => true },
      })
    expect(check('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ ok: true })
    now = 2_500
    expect(check('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toMatchObject({ ok: false, reason: 'signature' })
    await tables.close()
  })
})
