import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { command, complete, install, prompt, result, results, runtime, say, waitFor } from './runtime.mjs'

const name = process.argv[2]
assert.ok(['business-agent', 'hot-upgrade', 'growing-skills'].includes(name))
assert.ok(
  process.argv.slice(3).every((arg) => arg === '--check'),
  'Only --check is accepted',
)
const rt = await runtime(process.argv.includes('--check'))
const bundle = '@agnes-fde/support-triage#support-triage'
async function begin() {
  const session = await rt.session({ bundles: [bundle] })
  await prompt(session, 'Triage synthetic ticket T-100 and draft a reply.', 'parked')
  assert.deepEqual((await session.capabilities()).loop.value, { id: 'fde.support-triage', version: '4.0.0' })
  assert.equal((await result(session, 'fde_support_classify')).priority, 'urgent')
  return session
}
async function finish(session) {
  const page = await session.uiRead()
  const record = page.surfaces.findLast(
    (record) =>
      record.status === 'open' && record.surface.actions.some((action) => action.tool === 'ui_submit'),
  )
  assert.ok(record)
  assert.ok(
    await rt.confirm('Continue the synthetic workflow from its saved review question?'),
    'Workflow continuation declined',
  )
  await session.uiAction({
    surfaceId: record.surface.id,
    revision: record.surface.revision,
    actionId: 'submit',
    commandId: randomUUID(),
    input: { answers: { proceed: 'Proceed' } },
    selection: {},
  })
  await waitFor(
    () => result(session, 'fde_support_send').catch(() => null),
    Boolean,
    'Surface answer workflow',
  )
  return result(session, 'fde_support_send')
}
try {
  await rt.connect()
  if (name === 'business-agent') {
    say('1. Install the existing support-triage business bundle after capability review.')
    const preview = await install(rt, 'examples/fde/support-triage')
    const business = await begin()
    const normal = await rt.session({ bundles: [] })
    assert.ok((await business.tools()).tools.some((t) => t.name === 'fde_support_send'))
    assert.equal(
      (await normal.tools()).tools.some((t) => t.name.startsWith('fde_support_')),
      false,
    )
    assert.deepEqual((await normal.capabilities()).loop.value, { id: 'agnes.default', version: '1.0.0' })
    await prompt(normal, 'Say hello; this is the default Agent.')
    say('2. Business session classifies T-100 as urgent; parallel default Agent has zero business tools.')
    const receipt = await finish(business)
    assert.equal(receipt.status, 'simulated-sent')
    say(`3. Approved business result: ${JSON.stringify(receipt)}`)
    await complete(
      rt.client,
      await rt.client.packages.disable({ ...(await command(rt.client)), id: preview.id }),
    )
    const fresh = await rt.session({ bundles: [] })
    assert.equal(
      (await fresh.tools()).tools.some((t) => t.name.startsWith('fde_support_')),
      false,
    )
    await assert.rejects(rt.session({ bundles: [bundle] }))
    const pin = (await business.capabilities()).codePin.generationId
    await rt.restart()
    const restored = await rt.client.session.load(business.id, {
      cwd: rt.workspace,
      onPermissionRequest: rt.allow,
    })
    await restored.attach()
    assert.equal((await restored.capabilities()).codePin.generationId, pin)
    const coldFresh = await rt.session({ bundles: [] })
    assert.equal(
      (await coldFresh.tools()).tools.some((t) => t.name.startsWith('fde_support_')),
      false,
    )
    await prompt(restored, 'Triage the next synthetic ticket.', 'parked')
    assert.equal((await finish(restored)).status, 'simulated-sent')
    say(
      '4. Disabled: new sessions lose the bundle; existing business session still completes on pinned code after daemon restart.',
    )
  } else if (name === 'hot-upgrade') {
    say('1. Start a multi-step workflow on v1; stop at its durable review question.')
    const directory = join(rt.workspace, 'support-v1')
    await cp('examples/fde/support-triage', directory, {
      recursive: true,
      filter: (source) => !source.includes('node_modules'),
    })
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    const source = await readFile(join(directory, 'index.mjs'), 'utf8')
    manifest.version = '1.1.1'
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    await writeFile(
      join(directory, 'index.mjs'),
      source.replace('receipt: `support:${id}`', 'receipt: `support-v1:${id}`'),
    )
    await install(rt, directory)
    const old = await begin()
    manifest.version = '1.1.2'
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    await writeFile(
      join(directory, 'index.mjs'),
      source.replace('receipt: `support:${id}`', 'receipt: `support-v2:${id}`'),
    )
    await install(rt, directory)
    const fresh = await begin()
    assert.equal((await finish(fresh)).receipt, 'support-v2:T-100')
    assert.equal((await results(old, 'fde_support_send')).length, 0)
    const before = await old.projectUI()
    say('2. Published v2 mid-workflow: new session sends v2; old session is still awaiting review.')
    await rt.restart()
    const resumed = await rt.client.session.load(old.id, { cwd: rt.workspace, onPermissionRequest: rt.allow })
    await resumed.attach()
    assert.deepEqual((await resumed.projectUI()).nodes, before.nodes)
    assert.equal((await finish(resumed)).receipt, 'support-v1:T-100')
    assert.equal((await results(resumed, 'fde_support_send')).length, 1)
    assert.equal((await results(resumed, 'fde_support_ticket')).length, 1)
    assert.equal((await results(resumed, 'fde_support_classify')).length, 1)
    say(
      '3. Restarted mid-task: persisted review and prior tool results recovered; v1 finished with exactly one send receipt, one read and one classification.',
    )
  } else {
    say('1. Ask the Agent to create a text statistics plugin through the installed authoring helper.')
    const author = await rt.session({ preset: 'full-access', bundles: [] })
    await prompt(author, 'Create a plugin that counts characters and words in text.')
    const draft = await result(author, 'plugin_helper_create')
    assert.equal(draft.state, 'draft')
    const manifest = JSON.parse(draft.files.find((file) => file.path === 'package.json').after)
    const source = draft.files.find((file) => file.path === 'index.mjs').after
    assert.equal(manifest.name, 'my-agh-plugin')
    assert.ok(source.includes('my_text_stats'))
    assert.equal(
      (await rt.client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === manifest.name),
      false,
    )
    say('Generated source for review:\n' + source)
    await prompt(
      author,
      `call plugin_helper_install ${JSON.stringify({ action: 'test', proposalId: draft.candidateId })}`,
    )
    await prompt(
      author,
      `call plugin_helper_install ${JSON.stringify({ action: 'commit', proposalId: draft.candidateId })}`,
    )
    const reviewed = await rt.client.request('_agnes/v1/plugins.candidates.show', {
      profile: 'local-dev',
      candidateId: draft.candidateId,
    })
    assert.equal(reviewed.state, 'review')
    assert.equal(reviewed.tests.state, 'passed')
    assert.equal(reviewed.tests.hash, draft.candidateHash)
    assert.ok(
      await rt.confirm(
        `Publish reviewed ${manifest.name}@${manifest.version}; candidate=${draft.candidateHash}; review=${reviewed.reviewHash}`,
      ),
      'Publication declined',
    )
    await rt.client.request('_agnes/v1/plugins.candidates.approve', {
      ...(await command(rt.client)),
      candidateId: draft.candidateId,
      expectedHash: draft.candidateHash,
      reviewHash: reviewed.reviewHash,
    })
    say('2. Source and passing tests reviewed; the human published the exact candidate hash.')
    await waitFor(
      () => rt.client.packages.list({ profile: 'local-dev' }),
      (value) => value.packages.some((p) => p.id === 'my-agh-plugin' && p.actual === 'running'),
      'Authored plugin activation',
    )
    const provenance = await rt.client.call('_agnes/v1/packages.provenance', {
      profile: 'local-dev',
      id: 'my-agh-plugin',
    })
    assert.equal(provenance.installer, 'agent')
    const next = await rt.session({ preset: 'full-access', bundles: [] })
    await prompt(next, 'call my_text_stats {"text":"hello world"}')
    assert.deepEqual(await result(next, 'my_text_stats'), { characters: 11, words: 2 })
    say(
      '3. Human publication of the reviewed hash completed; next session invokes the real tool: characters=11, words=2; provenance installer=agent.',
    )
  }
  say(`PASS ${name}: every claim verified against persisted backend results.`)
} finally {
  await rt.dispose()
}
