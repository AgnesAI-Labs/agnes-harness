import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { RuntimeRecord } from '@agnes/jev-runtime'
import type { DiagnosticsEventsResult, EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createCredentialStore } from '../../packages/host/src/index.js'
import { createClient, memoryJournal, type NodeClient } from '../../packages/sdk/src/index.node.js'

const entry = process.env.AGNES_LOCAL_CLI
const sourceHome = process.env.AGNES_ACCEPTANCE_PROVIDER_HOME
const profile = process.env.AGNES_ACCEPTANCE_PROVIDER_PROFILE ?? 'local-dev'
const endpoint = process.env.AGNES_ACCEPTANCE_LAYA_ENDPOINT

it.skipIf(!entry || !sourceHome || !endpoint)(
  'saved local Laya completes a built daemon tool task with a real language provider after restart',
  async () => {
    if (!entry || !sourceHome || !endpoint) throw new Error('real Laya acceptance inputs missing')
    const root = await mkdtemp(join(tmpdir(), 'agnes-laya-real-'))
    const home = join(root, 'home'),
      cwd = join(root, 'workspace')
    const env: NodeJS.ProcessEnv = { ...process.env, AGH_HOME: home, AGNES_PROFILE: profile, HOME: root }
    for (const key of Object.keys(env))
      if (key.startsWith('AGNES_JEV_') || key === 'TYPESAFE_API_KEY') delete env[key]
    let client: NodeClient | undefined
    let stage = 'configuration'
    const command = (args: string[]) =>
      new Promise<string>((done, reject) => {
        const child = execFile(
          process.execPath,
          [resolve(entry), ...args],
          { cwd, env, timeout: 120_000, maxBuffer: 1024 * 1024 },
          (error, stdout) =>
            error ? reject(new Error(`Laya acceptance CLI failed at ${stage}`)) : done(stdout),
        )
        child.stdin?.end()
      })
    const connect = async () => {
      await command(['sessions', '--json'])
      const owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
      client = createClient({
        transport: { kind: 'unix', path: owner.socketPath },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      await client.initialize()
      return client
    }
    const eventsFor = async (connection: NodeClient, sessionId: string): Promise<EventEnvelope[]> => {
      const events: EventEnvelope[] = []
      let afterSeq = 0
      for (;;) {
        const page = await connection.call<DiagnosticsEventsResult>('_agnes/v1/diagnostics.events', {
          sessionId,
          afterSeq,
          limit: 500,
          maxBytes: 2_097_152,
        })
        events.push(...page.events)
        if (page.nextAfterSeq === null) return events
        if (page.nextAfterSeq <= afterSeq) throw new Error('Laya acceptance ledger did not advance')
        afterSeq = page.nextAfterSeq
      }
    }
    try {
      await mkdir(cwd)
      const source = JSON.parse(
        await readFile(join(sourceHome, 'profiles', profile, 'configuration.json'), 'utf8'),
      )
      const account =
        source.version === 2
          ? source.accounts.find((item: { accountId: string }) => item.accountId === source.defaultAccountId)
          : source.provider
      if (source.profile !== profile || !account?.credentialRef)
        throw new Error('real language account unavailable')
      const credential = await createCredentialStore({ root: sourceHome }).read(account.credentialRef)
      if (credential?.kind !== 'api-key') throw new Error('real language API credential unavailable')
      await createCredentialStore({ root: home }).putApiKey(account.credentialRef, credential.value)
      const configuration = source.version === 2 ? { ...source, accounts: [account] } : source
      const destination = join(home, 'profiles', profile, 'configuration.json')
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, JSON.stringify(configuration), { mode: 0o600 })
      const marker = `LAYA_READ_${randomUUID()}`
      await writeFile(join(cwd, 'fixture.txt'), marker)
      const first = await connect()
      const settings = {
        backend: 'laya' as const,
        transport: 'native' as const,
        endpoint,
        model: 'multilingual',
        authentication: 'none' as const,
        enabled: true,
      }
      stage = 'real Laya connection test'
      expect((await first.config.jevTest({ settings })).verified).toBe(true)
      const before = await first.config.jevGet()
      const saved = await first.config.jevSave({ settings, expectedRevision: before.revision })
      expect(saved.effect).toBe('restart-required')
      await first.close()
      client = undefined
      await command(['daemon', 'stop'])
      stage = 'restarted Laya configuration'
      const restarted = await connect()
      expect((await restarted.config.jevGet()).settings?.backend).toBe('laya')
      expect((await restarted.runtime.list()).items.find((item) => item.id === 'jevloop')?.available).toBe(
        true,
      )
      stage = 'register smoke workspace'
      await restarted.workspace.add(cwd)
      stage = 'create short smoke session'
      const session = await restarted.session.new({ cwd, runtime: 'jevloop' })
      session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
      await session.attach({ filter: { acpUpdates: false } })
      stage = 'real Laya tool turn'
      const result = await session
        .prompt(
          'Use the read tool to read fixture.txt in the current workspace. Reply with exactly its contents. Do not use shell or modify files.',
          { signal: AbortSignal.timeout(240_000) },
        )
        .catch(() => {
          throw new Error('real Laya tool turn failed; inspect its isolated ledger')
        })
      stage = 'verify durable smoke evidence'
      const events = await eventsFor(restarted, session.id)
      const records = events
        .filter((event) => event.type === 'runtime/record')
        .map((event) => (event.data as unknown as { record: RuntimeRecord }).record)
      const requested = records.filter((record) => record.kind === 'model.requested')
      const decisions = requested.filter((record) => record.call.purpose === 'decision')
      console.log(
        JSON.stringify({
          smokeEvidence: 'laya-real',
          terminal: result.reason,
          decisionRequests: decisions.length,
          actionSettlements: records.filter((record) => record.kind === 'action.settled').length,
          languageRequests: requested.filter((record) => record.call.backend === 'agnes-provider').length,
          markerEventTypes: [
            ...new Set(
              events
                .filter((event) => JSON.stringify(event.data).includes(marker))
                .map((event) => event.type),
            ),
          ],
          modelErrors: records.flatMap((record) =>
            record.kind === 'model.settled' && record.settlement.error ? [record.settlement.error.code] : [],
          ),
        }),
      )
      expect(result.reason).toBe('completed')
      expect(decisions.length).toBeGreaterThan(0)
      expect(
        decisions.every((record) => record.call.backend === 'laya' && record.call.endpoint === endpoint),
      ).toBe(true)
      expect(decisions.every((record) => record.call.requestedModel === 'multilingual')).toBe(true)
      const settled = records.filter(
        (record) =>
          record.kind === 'model.settled' &&
          decisions.some((request) => request.id === record.requested) &&
          record.settlement.output &&
          !record.settlement.error,
      )
      expect(settled.length).toBeGreaterThan(0)
      expect(
        records.some((record) => record.kind === 'action.settled' && record.outcome.kind === 'success'),
      ).toBe(true)
      expect(
        records.some(
          (record) => record.kind === 'model.requested' && record.call.backend === 'agnes-provider',
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(marker),
        ),
      ).toBe(true)
      stage = 'unavailable local service'
      const probe = createServer()
      await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
      const address = probe.address()
      await new Promise<void>((done, reject) => probe.close((error) => (error ? reject(error) : done())))
      if (!address || typeof address === 'string') throw new Error('Missing local probe port')
      await expect(
        restarted.config.jevTest({
          settings: {
            ...settings,
            endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
          },
        }),
      ).rejects.toMatchObject({ data: { reason: 'CONFIG_TEST_FAILED' } })
      expect((await restarted.config.jevGet()).settings?.endpoint).toBe(endpoint)
      console.log(
        JSON.stringify({
          smoke: 'laya-real',
          runtime: 'jevloop',
          backend: 'laya',
          model: 'multilingual',
          decisionRequests: decisions.length,
          successfulDecisions: settled.length,
          toolSettlements: records.filter((record) => record.kind === 'action.settled').length,
          languageRequests: records.filter(
            (record) => record.kind === 'model.requested' && record.call.backend === 'agnes-provider',
          ).length,
          turn: result.reason,
          fixtureVerified: true,
          unavailableServiceRejected: true,
        }),
      )
    } catch (error) {
      // Keep diagnostic stage, never reflect upstream bodies or the copied credential.
      const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
      const reason = data && typeof data === 'object' && 'reason' in data ? data.reason : undefined
      const code = typeof reason === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(reason) ? reason : undefined
      throw new Error(`real Laya acceptance failed at ${stage}${code ? ` (${code})` : ''}`, {
        cause: error instanceof Error ? error.name : 'unknown',
      })
    } finally {
      await client?.close().catch(() => undefined)
      await command(['daemon', 'stop']).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  },
  360_000,
)

it.skipIf(!entry || !sourceHome || !endpoint)(
  'both saved targets run consecutive turns on the requested decision backend',
  async () => {
    if (!entry || !sourceHome || !endpoint) throw new Error('real Laya acceptance inputs missing')
    const root = await mkdtemp(join(tmpdir(), 'agnes-laya-turn-'))
    const home = join(root, 'home'),
      cwd = join(root, 'workspace')
    const env: NodeJS.ProcessEnv = { ...process.env, AGH_HOME: home, AGNES_PROFILE: profile, HOME: root }
    for (const key of Object.keys(env))
      if (key.startsWith('AGNES_JEV_') || key === 'TYPESAFE_API_KEY') delete env[key]
    let client: NodeClient | undefined
    let stage = 'configuration'
    const command = (args: string[]) =>
      new Promise<string>((done, reject) => {
        const child = execFile(
          process.execPath,
          [resolve(entry), ...args],
          { cwd, env, timeout: 120_000, maxBuffer: 1024 * 1024 },
          (error, stdout) =>
            error ? reject(new Error(`Turn acceptance CLI failed at ${stage}`)) : done(stdout),
        )
        child.stdin?.end()
      })
    const connect = async () => {
      await command(['sessions', '--json'])
      const owner = JSON.parse(await readFile(join(home, 'data/daemon/owner.json'), 'utf8'))
      client = createClient({
        transport: { kind: 'unix', path: owner.socketPath },
        auth: { kind: 'local' },
        journal: memoryJournal(),
      })
      await client.initialize()
      return client
    }
    try {
      await mkdir(cwd)
      const source = JSON.parse(
        await readFile(join(sourceHome, 'profiles', profile, 'configuration.json'), 'utf8'),
      )
      const account =
        source.version === 2
          ? source.accounts.find((item: { accountId: string }) => item.accountId === source.defaultAccountId)
          : source.provider
      if (!account?.credentialRef) throw new Error('real language account unavailable')
      const credential = await createCredentialStore({ root: sourceHome }).read(account.credentialRef)
      if (credential?.kind !== 'api-key') throw new Error('real language API credential unavailable')
      await createCredentialStore({ root: home }).putApiKey(account.credentialRef, credential.value)
      const configuration = source.version === 2 ? { ...source, accounts: [account] } : source
      const destination = join(home, 'profiles', profile, 'configuration.json')
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, JSON.stringify(configuration), { mode: 0o600 })
      const markerA = `TURN_LAYA_${randomUUID()}`
      const markerB = `TURN_JEV_${randomUUID()}`
      await writeFile(join(cwd, 'fixture-a.txt'), markerA)
      await writeFile(join(cwd, 'fixture-b.txt'), markerB)
      stage = 'save both decision targets'
      const first = await connect()
      await first.config.jevSave({
        settings: {
          backend: 'jev' as const,
          transport: 'native' as const,
          endpoint,
          model: 'jev-latest',
          authentication: 'none' as const,
          enabled: true,
        },
        expectedRevision: 0,
      })
      const dual = await first.config.jevSave({
        settings: {
          backend: 'laya' as const,
          transport: 'native' as const,
          endpoint,
          model: 'multilingual',
          authentication: 'none' as const,
          enabled: true,
        },
        expectedRevision: 1,
      })
      expect(dual.backends?.map((target) => target.backend)).toEqual(['jev', 'laya'])
      expect(dual.backends?.every((target) => target.configured)).toBe(true)
      await first.close()
      client = undefined
      await command(['daemon', 'stop'])
      stage = 'restarted dual-target configuration'
      const restarted = await connect()
      const descriptor = (await restarted.runtime.list()).items.find((item) => item.id === 'jevloop')
      expect(descriptor).toMatchObject({ available: true, defaultDecisionBackend: 'laya' })
      expect(descriptor?.decisionBackends?.every((target) => target.available)).toBe(true)
      await restarted.workspace.add(cwd)
      const session = await restarted.session.new({ cwd, runtime: 'jevloop' })
      session.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
      await session.attach({ filter: { acpUpdates: false } })
      stage = 'turn on Laya'
      const task = (file: string) =>
        `Use the read tool to read ${file} in the current workspace. Reply with exactly its contents. Do not use shell or modify files.`
      const firstTurn = await session.prompt(task('fixture-a.txt'), {
        decisionBackend: 'laya',
        signal: AbortSignal.timeout(240_000),
      })
      expect(firstTurn.reason).toBe('completed')
      stage = 'turn on Jev'
      const secondTurn = await session.prompt(task('fixture-b.txt'), {
        decisionBackend: 'jev',
        signal: AbortSignal.timeout(240_000),
      })
      expect(secondTurn.reason).toBe('completed')
      stage = 'verify per-turn backend evidence'
      const events: EventEnvelope[] = []
      let afterSeq = 0
      for (;;) {
        const page = await restarted.call<DiagnosticsEventsResult>('_agnes/v1/diagnostics.events', {
          sessionId: session.id,
          afterSeq,
          limit: 500,
          maxBytes: 2_097_152,
        })
        events.push(...page.events)
        if (page.nextAfterSeq === null) break
        afterSeq = page.nextAfterSeq
      }
      const records = events
        .filter((event) => event.type === 'runtime/record')
        .map((event) => (event.data as unknown as { record: RuntimeRecord }).record)
      const decisions = records.filter(
        (record) => record.kind === 'model.requested' && record.call.purpose === 'decision',
      )
      const byTurn = new Map<string, string>()
      for (const record of decisions)
        if (record.kind === 'model.requested') byTurn.set(record.turn, record.call.backend)
      const turns = [...byTurn.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      expect(turns.length).toBeGreaterThanOrEqual(2)
      expect(turns[0]?.[1]).toBe('laya')
      expect(turns.at(-1)?.[1]).toBe('jev')
      const bindings = events
        .filter((event) => event.type === 'x/host/jev-loop/turn-decision')
        .map((event) => (event.data as unknown as { selection?: { backend?: string } }).selection?.backend)
      expect(bindings).toEqual(['laya', 'jev'])
      expect(
        events.some(
          (event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(markerA),
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(markerB),
        ),
      ).toBe(true)
      console.log(
        JSON.stringify({
          smoke: 'laya-turn-backend',
          turns: turns.map(([turn, backend]) => ({ turn: turn.split(':').at(-1), backend })),
          decisionRequests: decisions.length,
          defaults: descriptor?.defaultDecisionBackend,
        }),
      )
    } catch (error) {
      const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
      const reason = data && typeof data === 'object' && 'reason' in data ? data.reason : undefined
      const code = typeof reason === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(reason) ? reason : undefined
      throw new Error(`turn acceptance failed at ${stage}${code ? ` (${code})` : ''}`, {
        cause: error instanceof Error ? error.name : 'unknown',
      })
    } finally {
      await client?.close().catch(() => undefined)
      await command(['daemon', 'stop']).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  },
  480_000,
)
