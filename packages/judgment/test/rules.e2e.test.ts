import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { installedJudgmentPage } from '../../judgment-ui/test/helpers/installed-page.js'
import { CALLER, judgmentDaemon, MODEL, PACKAGE, PROFILE } from './helpers/daemon.js'

const data = (row: { data: unknown }) => row.data as Record<string, any>
let fixture: Awaited<ReturnType<typeof judgmentDaemon>>
let page: Awaited<ReturnType<typeof installedJudgmentPage>> | undefined
beforeAll(async () => {
  fixture = await judgmentDaemon({ scriptedTool: true })
}, 180_000)
afterAll(async () => {
  await page?.dispose()
  await fixture?.close()
}, 35_000)
const enabled = {
  judge: { route: 'jev-a', model: MODEL },
  uses: {
    rules: {
      enabled: true,
      items: [{ id: 'review', text: 'A synthetic record requires review before action.', tools: ['read'] }],
    },
  },
}
it('installs one package, reminds, projects audited cost, renders and withdraws the browser page', async () => {
  await fixture.configure(enabled)
  fixture.respond({}, 0.9)
  const session = await fixture.session('rules')
  const first = await fixture.turn(session, 'Read the synthetic sample file.')
  expect(first.events.filter((row) => row.type === 'x/plugin/524280817e87343c/rules.reminded')).toHaveLength(
    1,
  )
  expect(
    first.events
      .filter((row) => row.type === 'tool/result')
      .map((row) => JSON.stringify(row.data))
      .join(''),
  ).toContain('Untrusted rule reminder')
  const costs = first.events.filter((row) => row.type === 'cost/ledger' && data(row).caller === CALLER)
  expect(costs).toHaveLength(1)
  expect(first.ui.nodes.find((node) => node.kind === 'cost' && node.caller === CALLER)).toMatchObject({
    purpose: 'side-call',
    caller: CALLER,
    label: 'judgment.rules',
  })
  expect(
    first.ui.turns?.flatMap((turn) => turn.usage.calls).find((call) => call.caller === CALLER),
  ).toMatchObject({ purpose: 'side-call', caller: CALLER, label: 'judgment.rules' })
  const sent = fixture.fake.seen[0]!.body as any
  expect(JSON.stringify(sent.state)).toContain('synthetic-rule.txt')
  expect(JSON.stringify(sent.state)).toContain('Synthetic record')
  const count = fixture.fake.seen.length
  const second = await fixture.turn(session, 'Read that synthetic file again.')
  expect(second.events.filter((row) => row.type === 'x/plugin/524280817e87343c/rules.reminded')).toHaveLength(
    0,
  )
  expect(fixture.fake.seen.length).toBe(count)
  const roster = await fixture.sdk.clientModules.list(PROFILE)
  const row = roster.rows.find((row) => row.packageId === PACKAGE)
  expect(row).toMatchObject({
    enabled: true,
    phase: 'ready',
    services: ['judgment.status'],
    binding: { lifetime: 'profile' },
  })
  if (!row?.entryUrl) throw new Error('installed browser entry unavailable')
  const asset = await fixture.sdk.clientModules.read(PROFILE, row.entryUrl)
  expect(asset.found).toBe(true)
  if (!asset.found) throw new Error('installed browser bytes unavailable')
  expect(Buffer.from(asset.base64, 'base64').toString()).toBe(
    readFileSync(
      new URL('../../package-manager/bundled-plugins/judgment/src/client.js', import.meta.url),
      'utf8',
    ),
  )
  const output = await fixture.sdk.extensions.callScoped({
    extension: 'plugin/524280817e87343c',
    service: 'judgment.status',
    input: {},
  })
  expect(output).toMatchObject({
    output: { version: 1, hookTimeout: 'unknown', uses: { rules: { enabled: true } } },
  })
  if (!row.binding || !row.revision) throw new Error('installed browser binding unavailable')
  page = await installedJudgmentPage(
    Buffer.from(asset.base64, 'base64').toString(),
    {
      packageId: PACKAGE,
      rowId: row.rowId,
      revision: row.revision,
      services: row.services ?? [],
      binding: row.binding,
    },
    async (_identity, service, input) => {
      expect(input).toEqual({})
      return fixture.sdk.extensions.callScoped({ extension: 'plugin/524280817e87343c', service, input: {} })
    },
  )
  expect(page.text()).toContain('判断')
  expect(page.text()).toContain('当前实例')

  const context = { profile: PROFILE, clientId: await fixture.sdk.clientId(), id: PACKAGE }
  const checkUnavailable = async () => {
    const roster = await fixture.sdk.clientModules.list(PROFILE)
    expect(roster.rows.filter((row) => row.packageId === PACKAGE && row.phase === 'ready')).toEqual([])
    await expect(
      fixture.sdk.extensions.callScoped({
        extension: 'plugin/524280817e87343c',
        service: 'judgment.status',
        input: {},
      }),
    ).rejects.toThrow()
  }
  await fixture.operation(await fixture.sdk.packages.disable({ ...context, commandId: 'rule-disable' }))
  await checkUnavailable()
  await page!.withdraw()
  expect(page!.text()).toContain('不可用')
  await fixture.operation(await fixture.sdk.packages.enable({ ...context, commandId: 'rule-enable' }))
  const installed = (await fixture.sdk.packages.list({ profile: PROFILE })).packages.find(
    (pkg) => pkg.id === PACKAGE,
  )!
  if (!installed.integrity || !installed.capabilityHash)
    throw new Error('installed trust binding unavailable')
  await fixture.operation(
    await fixture.sdk.packages.untrust({
      ...context,
      commandId: 'rule-untrust',
      expectedIntegrity: installed.integrity,
      capabilityHash: installed.capabilityHash,
    }),
  )
  await checkUnavailable()
  await fixture.operation(await fixture.sdk.packages.remove({ ...context, commandId: 'rule-remove' }))
  await checkUnavailable()
}, 180_000)
