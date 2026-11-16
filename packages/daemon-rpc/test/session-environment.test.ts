import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledAppProof } from '@agnes/daemon-foundation/local/bundled-app'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemorySessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import type { SessionEnvironment } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { type AuthConfig, authGate } from '../src/local/auth.js'
import * as acp from '../src/local/methods/acp.js'
import type { SessionEnvironmentAuthority } from '../src/local/methods/session-environment.js'

const KEY = 'a'.repeat(64)
const APP = 'bundled-app:@agnes/superagent/superagent'
const ENVIRONMENT: SessionEnvironment = {
  pathPrepend: ['/state/worker-bin'],
  set: {
    GIT_CONFIG_GLOBAL: '/state/worker-gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  },
  unset: ['GH_TOKEN', 'GITHUB_TOKEN'],
}
const nonces = { consume: () => true }
/** The bundled application's own sessions, as the daemon composition names them. */
const owns = (key: string) => key.startsWith('superagent:')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A connection through the auth gate with `auth` as its credential; resolves to the endpoint or the error. */
async function connect(clientId: string, auth: Record<string, unknown> | undefined, config: AuthConfig) {
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  ep.register(
    'initialize',
    authGate(ep, { config, nonces, clock: () => 0 }, async (_params, cx) => {
      cx.conn.initialized = true
      return { protocolVersion: 1 }
    }),
  )
  const response = (await ep.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: { 'ai.agnes.harness': { clientId, ...(auth ? { auth } : {}) } },
    },
  })) as { error?: { message: string; data?: { reason?: string } } }
  return { ep, error: response.error }
}

describe("the bundled application's connection", () => {
  const unix: AuthConfig = { transport: 'unix', bundledAppKey: KEY }

  it('is marked only by the proof for its client id under the key the daemon minted', async () => {
    const marked = await connect(APP, { kind: 'local', bundledApp: bundledAppProof(KEY, APP) }, unix)
    expect(marked.error).toBeUndefined()
    expect(marked.ep.conn.bundledApp).toBe(true)
    const plain = await connect(APP, { kind: 'local' }, unix)
    expect(plain.error).toBeUndefined()
    expect(plain.ep.conn.bundledApp).toBeUndefined()
  })

  it('fails the handshake for a wrong proof, a proof for another client, another client id, the Web listener or no key', async () => {
    const refused = [
      await connect(APP, { kind: 'local', bundledApp: bundledAppProof('b'.repeat(64), APP) }, unix),
      await connect(APP, { kind: 'local', bundledApp: bundledAppProof(KEY, `${APP}-other`) }, unix),
      await connect('owner-cli', { kind: 'local', bundledApp: bundledAppProof(KEY, 'owner-cli') }, unix),
      await connect(
        APP,
        { kind: 'local', bundledApp: bundledAppProof(KEY, APP) },
        { transport: 'ws', localWeb: true, bundledAppKey: KEY },
      ),
      await connect(APP, { kind: 'local', bundledApp: bundledAppProof(KEY, APP) }, { transport: 'unix' }),
    ]
    for (const { ep, error } of refused) {
      expect(error).toMatchObject({ message: 'AUTH_INVALID', data: { reason: 'bundled app proof invalid' } })
      expect(ep.conn.initialized).toBe(false)
      expect(ep.conn.bundledApp).toBeUndefined()
    }
  })
})

describe('session/new with an environment', () => {
  async function create(
    conn: Record<string, unknown>,
    environment: unknown,
    { openFails = false, sessionKey = 'superagent:k' }: { openFails?: boolean; sessionKey?: string } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'agnes-session-env-'))
    roots.push(root)
    const workspaces = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async (path) => ({ path, name: 'test' }),
    )
    await workspaces.add(root)
    const order: string[] = []
    const records: SessionEnvironmentAuthority = {
      owns,
      write: async (key, value) => {
        order.push(`write ${key} ${JSON.stringify(value)}`)
      },
      release: async (key) => {
        order.push(`release ${key}`)
      },
    }
    const cx = {
      host: { profile: { presets: { allowed: [] } } },
      workspaces,
      sessionOwnership: new MemorySessionPrincipalOwnership(),
      auth: { config: { transport: 'unix' } },
      sessionEnvironment: records,
      registry: {
        get: () => undefined,
        open: async ({ key }: { key: string }) => {
          order.push(`open ${key}`)
          if (openFails) throw new Error('open failed')
          return { key }
        },
      },
    }
    const call = { conn: { principalId: 'local', ...conn }, signal: new AbortController().signal }
    const result = await acp
      .createSessionInternal(
        cx as never,
        { cwd: root, mcpServers: [], _meta: { 'ai.agnes.harness': { sessionKey, environment } } },
        call as never,
      )
      .catch((error: unknown) => error)
    return { result, order }
  }

  it("is kept for the bundled application's client before the session opens", async () => {
    const { result, order } = await create({ bundledApp: true }, ENVIRONMENT)
    expect(result).toEqual({ sessionId: 'superagent:k' })
    expect(order).toEqual([`write superagent:k ${JSON.stringify(ENVIRONMENT)}`, 'open superagent:k'])
  })

  it('is refused to every other client, before anything is kept or opened', async () => {
    for (const conn of [{}, { localListener: 'web' }, { localListener: 'unix', clientId: APP }]) {
      const { result, order } = await create(conn, ENVIRONMENT)
      expect(result).toMatchObject({
        message: 'CAPABILITY_DENIED',
        data: { code: 'SESSION_ENVIRONMENT_DENIED' },
      })
      expect(order).toEqual([])
    }
  })

  it("is refused for a session that is not the bundled application's own, before anything is kept or opened", async () => {
    // The owner's own sessions, and a key chosen by the daemon, never take an environment from the bundled app.
    for (const sessionKey of ['owner-notes', 'agnes:local:local-dev:cli:workspace:0123', 'xsuperagent:k']) {
      const { result, order } = await create({ bundledApp: true }, ENVIRONMENT, { sessionKey })
      expect(result, sessionKey).toMatchObject({
        message: 'CAPABILITY_DENIED',
        data: { code: 'SESSION_ENVIRONMENT_DENIED' },
      })
      expect(order).toEqual([])
    }
  })

  it('is refused when it would set anything but git configuration, prompts and locale, or is too large', async () => {
    for (const environment of [
      // Credentials, and the variables that load code into a program or move its configuration.
      { set: { GH_TOKEN: 'x' } },
      { set: { NPM_AUTH_TOKEN: 'x' } },
      { set: { AWS_SECRET_ACCESS_KEY: 'x' } },
      { set: { NODE_OPTIONS: '--require /tmp/x.js' } },
      { set: { LD_PRELOAD: '/tmp/x.so' } },
      { set: { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' } },
      { set: { BASH_ENV: '/tmp/x.sh' } },
      { set: { HOME: '/tmp' } },
      { set: { GH_CONFIG_DIR: '/tmp/gh' } },
      { set: { GIT_SSH_COMMAND: 'ssh -i /tmp/key' } },
      { set: { GIT_ASKPASS: '/tmp/askpass' } },
      { set: { PATH: '/bin' } },
      { set: { AGNES_SECRET_X: 'x' } },
      { unset: ['PATH'] },
      { pathPrepend: ['relative/bin'] },
      { pathPrepend: ['/a:/b'] },
      { set: { LANG: 'C' }, unset: ['LANG'] },
      { set: Object.fromEntries(Array.from({ length: 33 }, (_, at) => [`LC_V${at}`, 'x'])) },
      { set: { LANG: 'x'.repeat(4097) } },
      { other: 1 },
    ]) {
      const { result, order } = await create({ bundledApp: true }, environment)
      expect(result, JSON.stringify(environment)).toMatchObject({
        message: 'SEMANTIC_REJECTED',
        data: { code: 'SESSION_ENVIRONMENT_INVALID' },
      })
      expect(order).toEqual([])
    }
  })

  it('is released when the new session does not open', async () => {
    const { result, order } = await create({ bundledApp: true }, ENVIRONMENT, { openFails: true })
    expect(result).toBeInstanceOf(Error)
    expect(order).toEqual([
      `write superagent:k ${JSON.stringify(ENVIRONMENT)}`,
      'open superagent:k',
      'release superagent:k',
    ])
  })
})

describe('opening a session with an environment', () => {
  async function open(conn: Record<string, unknown>, sessionId = 'superagent:owned') {
    const kept: string[] = []
    const entry = {
      key: sessionId,
      generation: 1,
      session: { lastSeq: 0, latest: () => null, verifyHistory: async () => 0 },
    }
    const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
    ep.conn.initialized = true
    Object.assign(ep.conn, conn)
    const feeds = new Map<string, acp.Feed>()
    acp.registerAcp(
      ep,
      {
        sessionOwnership: { resolve: () => ({ principalId: 'owner' }) },
        workspaces: { restoreBinding: async () => ({ canonicalRoot: '/synthetic' }) },
        sessionEnvironment: {
          owns,
          write: async (key: string) => {
            kept.push(`write ${key}`)
          },
          release: async () => {},
        },
        registry: {
          get: () => undefined,
          open: async () => {
            kept.push('open')
            return entry
          },
          subscribe: () => () => {},
          subscribePreview: () => () => {},
          previewSnapshot: async () => [],
        },
      } as unknown as acp.LocalContext,
      feeds,
      new Map(),
    )
    try {
      const response = await ep.handle({
        jsonrpc: '2.0',
        id: 1,
        method: '_agnes/v1/session.open',
        params: {
          sessionId,
          requestId: 'r1',
          _meta: { 'ai.agnes.harness': { environment: ENVIRONMENT } },
        },
      })
      return { response, kept }
    } finally {
      acp.disposeFeeds(feeds)
      await ep.close()
    }
  }

  it("replaces the session's environment for the bundled application's client, as it opens", async () => {
    const { response, kept } = await open({ bundledApp: true })
    expect(response).toMatchObject({ result: {} })
    expect(kept).toEqual(['write superagent:owned', 'open'])
  })

  it("is refused to any other client, and for the owner's own sessions, which opens nothing", async () => {
    const owner = await open({ bundledApp: true }, 'owner-notes')
    expect(owner.response).toMatchObject({
      error: { message: 'CAPABILITY_DENIED', data: { code: 'SESSION_ENVIRONMENT_DENIED' } },
    })
    expect(owner.kept).toEqual([])
    const { response, kept } = await open({})
    expect(response).toMatchObject({
      error: { message: 'CAPABILITY_DENIED', data: { code: 'SESSION_ENVIRONMENT_DENIED' } },
    })
    expect(kept).toEqual([])
  })
})
