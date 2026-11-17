import { createClient, memoryJournal, type NodeClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createTuiMcpLogin } from '../../src/mcp-login/tui-port.js'
import type { TuiMcpLogin } from '../../src/tui/app.js'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { scriptedEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const COLUMNS = 100
const ROWS = 30
const AUTHORIZATION_URL = 'https://auth.example/authorize?client_id=c1&state=s1'
const CALLBACK_URL = 'http://localhost:4567/callback?code=abc&state=s1'

type Mount = Awaited<ReturnType<typeof mount>>

async function mount(
  mcpLogin: TuiMcpLogin | undefined,
  extra: Partial<ConstructorParameters<typeof TuiApp>[0]> = {},
) {
  const client = createClient({
    transport: { kind: 'inproc', endpoint: scriptedEndpoint() },
    journal: memoryJournal(),
  })
  const session = await client.session.new({ cwd: '/w' })
  const term = new FakeTerminal({ columns: COLUMNS, rows: ROWS })
  const copied: string[] = []
  const execute = vi.fn(async () => ({ text: 'resource listing' }))
  const app = new TuiApp({
    session,
    term,
    header: 'Agnes',
    profile: 'work',
    copy: (text) => void copied.push(text),
    resourceController: { execute },
    ...(mcpLogin ? { mcpLogin } : {}),
    ...extra,
  })
  await app.start()
  const screen = async () => (await screenOf(term, COLUMNS, ROWS)).join('\n')
  const run = (line: string) => {
    term.feed(line)
    term.feed('\r')
  }
  const stop = async () => {
    await app.stop()
    await client.close()
  }
  return { app, term, copied, execute, screen, run, stop }
}

async function withApp(
  mcpLogin: TuiMcpLogin | undefined,
  body: (m: Mount) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof TuiApp>[0]> = {},
) {
  const m = await mount(mcpLogin, extra)
  try {
    await body(m)
  } finally {
    await m.stop()
  }
}

/** A port whose login shows the address and then waits for a paste; `outcome` is what the sign-in ends with. */
function waitingPort(outcome: Awaited<ReturnType<TuiMcpLogin['login']>> = { kind: 'signed-in' }) {
  const pasted: (string | undefined)[] = []
  const signals: AbortSignal[] = []
  const login = vi.fn<TuiMcpLogin['login']>(async ({ serverId, ui, signal }) => {
    signals.push(signal)
    ui.progress(`Starting ${serverId}`)
    ui.show({ serverId, authorizationUrl: AUTHORIZATION_URL })
    pasted.push(await ui.paste(signal))
    return signal.aborted ? { kind: 'cancelled' } : outcome
  })
  const port: TuiMcpLogin = { candidates: async () => [], login, logout: async () => {} }
  return { port, login, pasted, signals }
}

describe('/mcp login and /mcp logout in the TUI', () => {
  it('/mcp login X shows the URL and the paste box', async () => {
    const { port, login } = waitingPort()
    await withApp(port, async ({ run, screen, term, copied }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain(AUTHORIZATION_URL))
      expect(login).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work', serverId: 'x' }))
      const shown = await screen()
      expect(shown).toContain('Sign in to x')
      expect(shown).toContain('Address:')
      expect(shown).toContain('esc cancel')
      // Ctrl-Y hands the address to the clipboard path, whole.
      term.feed('\x19')
      expect(copied).toEqual([AUTHORIZATION_URL])
    })
  })

  it('pasting completes and shows signed in', async () => {
    const { port, pasted } = waitingPort()
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('Address:'))
      term.feed(`\x1b[200~${CALLBACK_URL}\x1b[201~`)
      await vi.waitFor(async () => expect(await screen()).toContain(CALLBACK_URL))
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain('Signed in to x.'))
      expect(pasted).toEqual([CALLBACK_URL])
      expect(await screen()).not.toContain('Address:')
    })
  })

  it('an empty paste is handed over as an empty answer, which cancels the sign-in', async () => {
    const { port, pasted } = waitingPort({ kind: 'cancelled' })
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('Address:'))
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain('Sign-in cancelled.'))
      expect(pasted).toEqual([''])
    })
  })

  it('Esc cancels and stops the login', async () => {
    const { port, signals, pasted } = waitingPort()
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('Address:'))
      expect(signals[0]?.aborted).toBe(false)
      term.feed('\x1b')
      await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true))
      await vi.waitFor(async () => expect(await screen()).toContain('Sign-in cancelled.'))
      expect(await screen()).not.toContain('Address:')
      expect(pasted).toEqual([undefined])
    })
  })

  it('a sign-in that ends after Esc does not reopen the panel', async () => {
    const { port } = waitingPort({ kind: 'signed-in' })
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('Address:'))
      term.feed('\x1b')
      await vi.waitFor(async () => expect(await screen()).toContain('Sign-in cancelled.'))
      expect(await screen()).not.toContain('Address:')
    })
  })

  it('a timed out sign-in is reported', async () => {
    const { port } = waitingPort({ kind: 'timed-out' })
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('Address:'))
      term.feed(`\x1b[200~${CALLBACK_URL}\x1b[201~`)
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain('timed out after 5 minutes'))
    })
  })

  it('shows the failure text the sign-in gave, and keeps it until closed', async () => {
    const failure = 'the authorization server refused the sign-in code (it may have expired or been used)'
    const port: TuiMcpLogin = {
      candidates: async () => [],
      login: async () => {
        throw new Error(failure)
      },
      logout: async () => {},
    }
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain(failure))
      term.feed('\x1b')
      await vi.waitFor(async () => expect(await screen()).not.toContain(failure))
    })
  })

  it('says why when the sign-in is saved but the server did not come back', async () => {
    const { port } = waitingPort({ kind: 'signed-in', reconnectFailed: 'the operation was cancelled' })
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('Address:'))
      term.feed(`\x1b[200~${CALLBACK_URL}\x1b[201~`)
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain('the operation was cancelled'))
      expect(await screen()).toContain('saved')
    })
  })

  it('shows control characters in server text inert', async () => {
    const port: TuiMcpLogin = {
      candidates: async () => [],
      login: async () => {
        throw new Error('bad\x1b]52;c;c2VjcmV0\x07 reply')
      },
      logout: async () => {},
    }
    await withApp(port, async ({ run, screen, term }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('reply'))
      expect(term.writes.join('')).not.toContain('\x1b]52;')
    })
  })

  it('/mcp login without a name picks from servers that need sign-in', async () => {
    const { port, login } = waitingPort()
    const candidates = vi.fn(async () => ['alpha', 'beta'])
    await withApp({ ...port, candidates }, async ({ run, screen, term }) => {
      run('/mcp login')
      await vi.waitFor(async () => expect(await screen()).toContain('beta'))
      expect(candidates).toHaveBeenCalledWith('work')
      expect(await screen()).toContain('alpha')
      expect(login).not.toHaveBeenCalled()
      term.feed('\x1b[B')
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain(AUTHORIZATION_URL))
      expect(login).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'beta' }))
    })
  })

  it('/mcp login without a name says so when no server needs sign-in', async () => {
    const { port, login } = waitingPort()
    await withApp({ ...port, candidates: async () => [] }, async ({ run, screen }) => {
      run('/mcp login')
      await vi.waitFor(async () => expect(await screen()).toContain('No MCP server needs sign-in'))
      expect(login).not.toHaveBeenCalled()
    })
  })

  it('/mcp logout X runs without the confirm queue', async () => {
    const logout = vi.fn(async () => {})
    await withApp(
      { candidates: async () => [], login: waitingPort().login, logout },
      async ({ run, screen, execute, app }) => {
        run('/mcp logout x')
        await vi.waitFor(async () => expect(await screen()).toContain('Signed out of x.'))
        expect(logout).toHaveBeenCalledWith('work', 'x')
        expect(execute).not.toHaveBeenCalled()
        expect(await screen()).not.toContain('Pending resource operation')
        expect(app.takeResourceConfirmation('mcp')).toBeUndefined()
      },
    )
  })

  it('/mcp logout shows the failure text when signing out fails', async () => {
    const logout = vi.fn(async () => {
      throw new Error('"x" is not an HTTP server')
    })
    await withApp(
      { candidates: async () => [], login: waitingPort().login, logout },
      async ({ run, screen }) => {
        run('/mcp logout x')
        await vi.waitFor(async () => expect(await screen()).toContain('"x" is not an HTTP server'))
      },
    )
  })

  it('/mcp logout without a name shows the usage', async () => {
    const logout = vi.fn(async () => {})
    await withApp(
      { candidates: async () => [], login: waitingPort().login, logout },
      async ({ run, screen }) => {
        run('/mcp logout')
        await vi.waitFor(async () => expect(await screen()).toContain('usage: /mcp logout <server>'))
        expect(logout).not.toHaveBeenCalled()
      },
    )
  })

  it('the other /mcp actions still go through the resource commands', async () => {
    const { port, login } = waitingPort()
    await withApp(port, async ({ run, screen, execute }) => {
      run('/mcp')
      await vi.waitFor(async () => expect(await screen()).toContain('resource listing'))
      expect(execute).toHaveBeenCalledTimes(1)
      expect(login).not.toHaveBeenCalled()
    })
  })

  it('says it cannot sign in where no sign-in is wired', async () => {
    await withApp(undefined, async ({ run, screen }) => {
      run('/mcp login x')
      await vi.waitFor(async () => expect(await screen()).toContain('cannot sign in'))
    })
  })

  it('speaks Chinese when the locale is Chinese', async () => {
    const { port } = waitingPort()
    await withApp(
      port,
      async ({ run, screen, term }) => {
        run('/mcp login x')
        await vi.waitFor(async () => expect(await screen()).toContain('登录 x'))
        term.feed(`\x1b[200~${CALLBACK_URL}\x1b[201~`)
        term.feed('\r')
        await vi.waitFor(async () => expect(await screen()).toContain('已登录 x'))
      },
      { locale: 'zh-CN' },
    )
  })

  it('closing the app ends a sign-in in progress', async () => {
    const { port, signals } = waitingPort()
    const m = await mount(port)
    m.run('/mcp login x')
    await vi.waitFor(async () => expect(await m.screen()).toContain('Address:'))
    await m.stop()
    expect(signals[0]?.aborted).toBe(true)
  })
})

describe('the sign-in port of the TUI', () => {
  const serverRow = (serverId: string, extra: Record<string, unknown> = {}) => ({
    kind: 'mcp',
    serverId,
    desired: 'enabled',
    transportKind: 'http',
    secretBindingKind: 'oauth',
    authorizationStatus: 'authorized',
    ...extra,
  })
  const clientWith = (rows: readonly Record<string, unknown>[], definition?: unknown) =>
    ({
      mcp: {
        servers: {
          list: async ({ cursor }: { cursor?: string }) =>
            cursor
              ? { items: [serverRow('late', { authorizationStatus: 'pending' })] }
              : { items: rows, nextCursor: '1' },
          get: async () => ({ revision: 'r', definition }),
        },
      },
    }) as unknown as NodeClient

  it('offers HTTP servers that need sign-in, across pages', async () => {
    const port = createTuiMcpLogin(
      clientWith([
        serverRow('pending', { authorizationStatus: 'pending' }),
        serverRow('signed-in'),
        serverRow('expired', { authorizationStatus: 'needs-reconnect' }),
        serverRow('asked', {
          secretBindingKind: 'none',
          authorizationStatus: null,
          lastSafeError: { code: 'MCP_AUTH_REQUIRED', message: 'x' },
        }),
        serverRow('bearer', { secretBindingKind: 'http-bearer', authorizationStatus: 'pending' }),
        serverRow('local', {
          transportKind: 'stdio',
          secretBindingKind: 'none',
          authorizationStatus: 'pending',
        }),
        serverRow('off', { authorizationStatus: 'pending', desired: 'disabled' }),
      ]),
    )
    await expect(port.candidates('work')).resolves.toEqual(['pending', 'expired', 'asked', 'off', 'late'])
  })

  it('a stdio server is not an HTTP server', async () => {
    const port = createTuiMcpLogin(
      clientWith([], { transport: { kind: 'stdio', command: 'x' }, secretBinding: { kind: 'none' } }),
    )
    const login = port.login({
      profile: 'work',
      serverId: 'local',
      ui: { show() {}, paste: async () => undefined, progress() {} },
      signal: new AbortController().signal,
    })
    await expect(login).rejects.toThrow('"local" is not an HTTP server')
  })

  it('in the panel, a stdio server shows the sign-in text "not an HTTP server"', async () => {
    const port = createTuiMcpLogin(
      clientWith([], { transport: { kind: 'stdio', command: 'x' }, secretBinding: { kind: 'none' } }),
    )
    await withApp(port, async ({ run, screen }) => {
      run('/mcp login local')
      await vi.waitFor(async () => expect(await screen()).toContain('"local" is not an HTTP server'))
    })
  })

  it('a failure message reaches the user without control characters', async () => {
    const client = {
      mcp: {
        servers: {
          get: async () => {
            throw new Error('refused\x1b[31m by server')
          },
        },
      },
    } as unknown as NodeClient
    const port = createTuiMcpLogin(client)
    await expect(port.logout('work', 'x')).rejects.toThrow('refused [31m by server')
  })
})
