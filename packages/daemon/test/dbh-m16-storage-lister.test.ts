import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspaceDirectory } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionWorkspaceIndex, StorageLister } from '../src/storage/lister.js'
import { ensure } from '../src/storage/table.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'
import { openTestHost } from './host.js'
import { sqliteTables } from './sqlite-tables.js'

// Deep Bug Hunt M-16, shared-daemon lister (supervisor.ts StorageLister). The binding is written
// through the production WorkspaceCatalog.validate + bindSession (the session/new write path, which
// canonicalises with Host's resolveWorkspaceDirectory); the query goes through the endpoint's
// `_agnes/v1/session.list` with the cwd a user typed. Oracle: sdk client.ts (a caller cwd gets the
// same canonicalization as session.new). Tests assert correct behaviour; a failure reproduces the defect.

const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS events (
  session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, id TEXT NOT NULL,
  type TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'main', actor TEXT NOT NULL, origin TEXT NOT NULL,
  trust TEXT NOT NULL, register TEXT, ignorable INTEGER, surface_op TEXT, source_event_seqs TEXT,
  data TEXT NOT NULL, PRIMARY KEY (session_key, seq)
)`
const CLAIMS_DDL =
  'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT, until INTEGER, generation INTEGER)'

const request = (id: number, method: string, params: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('dbh M-16: session.list over StorageLister vs canonical workspace binding', () => {
  it('a session bound through WorkspaceCatalog is listed for the cwd the user typed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dbh-m16-lister-'))
    tmp.push(base)
    const dir = join(base, 'work')
    const alias = join(base, 'alias')
    const gone = join(base, 'gone')
    const other = join(base, 'other')
    mkdirSync(dir)
    mkdirSync(gone)
    mkdirSync(other)
    symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const canonical = realpathSync(dir)
    const goneCanonical = realpathSync(gone)
    const tables = sqliteTables()
    const fixture = await openTestHost()
    const ownerEndpoint = fixture.endpoint()
    const events = tables.table('events')
    ensure(events, EVENTS_DDL)
    ensure(tables.table('writer_claims'), CLAIMS_DDL)
    const index = new SessionWorkspaceIndex(tables.table('session_workspaces'))
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), index, resolveWorkspaceDirectory)
    const endpoint = fixture.endpoint({
      lister: new StorageLister(events, tables.table('writer_claims'), index),
      workspaces: catalog,
    })
    try {
      await endpoint.handle(
        request(1, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          _meta: { 'ai.agnes.harness': { clientId: 'dbh-m16' } },
        }),
      )
      await ownerEndpoint.handle(
        request(2, 'initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          _meta: { 'ai.agnes.harness': { clientId: 'dbh-m16-owner' } },
        }),
      )
      let requestId = 1
      const bind = async (key: string, path: string, ts: number) => {
        const created = (await ownerEndpoint.handle(
          request(++requestId, 'session/new', {
            cwd: fixture.dataDir,
            mcpServers: [],
            _meta: { 'ai.agnes.harness': { sessionKey: key } },
          }),
        )) as { result?: { sessionId?: string } }
        expect(created).toMatchObject({ result: { sessionId: key } })
        await catalog.add(path)
        await catalog.authorizeAndBind(key, path)
        events.exec(
          'INSERT INTO events (session_key, seq, ts, id, type, lane, actor, origin, trust, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            key,
            1,
            ts,
            `id-${ts}`,
            'session/start',
            'main',
            '{}',
            'system',
            'trusted',
            '{"preset":"standard"}',
          ],
        )
        // The wire result requires a live generation.
        tables
          .table('writer_claims')
          .exec('INSERT INTO writer_claims (session_key, run_id, until, generation) VALUES (?, ?, ?, ?)', [
            key,
            'run',
            0,
            1,
          ])
      }
      const key = 'agnes:local:default:cli:dm:dbh-m16'
      const goneKey = 'agnes:local:default:cli:dm:dbh-m16-gone'
      await bind(key, dir, 1001)
      await bind(goneKey, gone, 1002)
      rmSync(gone, { recursive: true, force: true })
      const listed = async (cwd: string) => {
        const r = (await endpoint.handle(
          request(++requestId, '_agnes/v1/session.list', { q: { cwd }, limit: 10 }),
        )) as {
          result?: { items: Array<{ sessionId: string }> }
        }
        return r.result?.items.map((i) => i.sessionId)
      }
      const workspaceList = async () => {
        const r = (await endpoint.handle(request(++requestId, '_agnes/v1/workspace.list', {}))) as {
          result?: unknown
        }
        return r.result
      }
      const workspacesBefore = await workspaceList()

      // Controls: the binding stored the canonical path, and the canonical query finds it.
      expect(index.get(key)).toBe(canonical)
      expect(await listed(canonical)).toEqual([key])

      expect({
        aliasDiffers: alias !== canonical,
        alias: await listed(alias),
        trailingSlash: await listed(`${canonical}/`),
      }).toEqual({ aliasDiffers: true, alias: [key], trailingSlash: [key] })

      // Preserved: a workspace directory that no longer exists still lists its sessions by the path they
      // were bound to; a directory no session was created in lists none, and listing it registers no
      // workspace.
      expect(await listed(goneCanonical)).toEqual([goneKey])
      expect(await listed(other)).toEqual([])
      expect(await workspaceList()).toEqual(workspacesBefore)
    } finally {
      await ownerEndpoint.close()
      await endpoint.close()
      await fixture.close()
      await tables.close()
    }
  })
})
