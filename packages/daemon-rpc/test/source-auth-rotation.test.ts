import { SourceAuthRotation } from '@agnes/daemon-foundation/storage/source-auth-rotation'
import { describe, expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { signSourceAuth, sourceAuthCanonical, verifyAuth } from '../src/local/auth.js'

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

  it('refuses a data dir that still holds the verifier-bearing v2 keyring', async () => {
    const tables = sqliteTables()
    const table = tables.table('rotation')
    table.exec('CREATE TABLE source_auth_keyring_v2 (id INTEGER PRIMARY KEY)')
    expect(() => new SourceAuthRotation(table)).toThrow(/^E_DATA_DIR_STALE: /)
    expect(
      table.get("SELECT 1 AS found FROM sqlite_master WHERE name = 'source_auth_keyring_v3'"),
    ).toBeUndefined()
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
