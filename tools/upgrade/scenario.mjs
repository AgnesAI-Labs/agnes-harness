import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { packageId, writePackage } from './fixture.mjs'
import { connect, eventually, packages } from './runtime.mjs'

const [phase, source, home, workspace, baseUrl, marker] = process.argv.slice(2)
const stateFile = join(workspace, 'upgrade-state.json')
const sdk = await connect(source, home)
const admin = await packages(sdk)
let serviceOwner
const scoped = (service, extra = {}) =>
  sdk.call('_agnes/v1/extension.callScoped', { extension: serviceOwner, service, input: {}, ...extra })
const ledgerRows = () => {
  const db = new DatabaseSync(join(home, 'data/sessions.db'), { readOnly: true })
  try {
    return JSON.parse(JSON.stringify(db.prepare('SELECT * FROM events ORDER BY session_key, seq').all()))
  } finally {
    db.close()
  }
}

const verifyManaged = async (state) => {
  if (!state.managed) return
  const status = (await scoped('server.status')).output
  console.info('Managed status after upgrade:', JSON.stringify(status))
  const pending = async () => (await sdk.call('_agnes/v1/profile.decisions.list', {})).decisions
  assert.equal((await pending()).length, 0, 'unexpected managed approval before recovery')
  if (state.marker === 'identity')
    assert.equal(status.state, 'ready', 'dead identity must auto-recover on first start')
  else
    assert.deepEqual(
      status,
      { state: 'failed', code: 'shutdown-unconfirmed' },
      'legacy marker must stay fenced on first start',
    )
  if (status.state !== 'ready') {
    // An unconfirmed shutdown is a native approval boundary, never an automatic replay.
    const operationId = randomUUID()
    const receipt = await scoped('server.reconcile', { operationId })
    assert.equal(receipt.state, 'approval-required', JSON.stringify({ status, receipt }))
    const listed = await sdk.call('_agnes/v1/profile.decisions.list', {})
    assert.equal(listed.decisions.length, 1, 'legacy recovery must raise exactly one native approval')
    const decision = listed.decisions.find((row) => !row.result && !row.invalidation)
    assert.ok(decision, 'missing native managed recovery decision')
    await sdk.call('_agnes/v1/profile.decisions.answer', {
      handle: decision.handle,
      revision: decision.revision,
      commandId: randomUUID(),
      response: { option: 'allowed-once', value: null },
    })
    assert.equal((await scoped('server.reconcile', { operationId })).state, 'completed')
  }
  await eventually(async () => (await scoped('server.status')).output.state === 'ready', 'managed recovery')
  assert.equal((await scoped('server.status')).output.state, 'ready')
  assert.deepEqual((await scoped('server.check')).output, { synthetic: true })
  assert.equal((await pending()).length, 0, 'managed approval must be consumed')
  console.info(
    `Managed recovery: ready on first start; approvals=${state.marker === 'identity' ? 0 : 1}; successful health query`,
  )
}

try {
  if (phase === 'seed') {
    const managed = existsSync(join(source, 'packages/extension-api/src/profile-runtime.ts'))
    await sdk.workspace.add(workspace)
    // A constant synthetic credential is accepted only by this loopback fixture.
    await sdk.config.save({
      providerId: 'deepseek',
      model: 'deepseek-flash',
      baseUrl,
      apiKey: 'upgrade-test',
      expectedRevision: 0,
    })

    const initialPrompt = await sdk.call('_agnes/v1/systemPrompt.get', {})
    await sdk.call('_agnes/v1/systemPrompt.save', {
      config: { personaSuffix: 'Synthetic upgrade persona' },
      expectedRevision: initialPrompt.revision,
    })
    const directory = await writePackage(
      workspace,
      managed,
      marker === 'identity'
        ? {
            loader: import.meta.resolve('tsx'),
            module: import.meta.resolve('@agnes/host-infrastructure/adapters/process-identity-default'),
          }
        : undefined,
      !!JSON.parse(await readFile(join(source, 'packages/protocol/schema/extension-manifest.json'), 'utf8'))
        .$defs.PluginMetadata.properties.category,
    )
    const packageSource = { type: 'file', ref: `file:${directory}` }
    const preview = (
      await admin.complete(await sdk.packages.inspect({ ...(await admin.command()), source: packageSource }))
    ).preview
    assert.ok(preview.capabilityHash)
    serviceOwner = preview.contributions.find((row) => row.kind === 'client')?.id
    assert.ok(serviceOwner, 'inspection must provide the service owner identity')
    await admin.complete(
      await sdk.packages.install({
        ...(await admin.command()),
        source: packageSource,
        expectedIntegrity: preview.integrity,
      }),
    )
    await admin.complete(
      await sdk.packages.trust({
        ...(await admin.command()),
        id: packageId,
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      }),
    )
    await admin.complete(await sdk.packages.enable({ ...(await admin.command()), id: packageId }))
    if (managed)
      await eventually(async () => {
        const status = (await scoped('server.status')).output
        assert.notEqual(status.state, 'failed', `seed managed failure: ${JSON.stringify(status)}`)
        return status.state === 'ready'
      }, 'seed managed readiness')
    const sessions = []
    for (const kind of ['plain', 'tool', 'attachment', 'present', 'queue']) {
      const session = await sdk.session.new({ cwd: workspace, sessionKey: `upgrade-${kind}-${randomUUID()}` })
      let attachment
      if (kind === 'attachment') {
        const bytes = Buffer.from('Synthetic attachment retained across upgrade. 中文')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const uploadId = randomUUID()
        const modernUpload = existsSync(join(source, 'packages/sdk/src/attachment-upload.ts'))
        const scope = modernUpload ? { laneId: 'main', destination: 'original' } : {}
        const call = (operation, data = {}) =>
          sdk.call('_agnes/v1/session.fileUpload', {
            sessionId: session.id,
            uploadId,
            operation,
            ...scope,
            ...data,
          })
        await call('start', { name: 'upgrade.txt', mimeType: 'text/plain', size: bytes.length })
        await call('chunk', { offset: 0, data: bytes.toString('base64'), sha256 })
        const uploaded = await call('finish', { sha256 })
        assert.ok(uploaded.attachment)
        attachment = uploaded.attachment
        await session.prompt([{ type: 'text', text: 'upgrade attachment' }, uploaded.attachment])
      } else {
        if (kind === 'tool') await writeFile(join(workspace, 'input.txt'), 'Synthetic tool input')
        if (kind === 'present')
          await writeFile(join(workspace, 'report.html'), '<h1>Synthetic deliverable</h1>')
        await session.prompt(`upgrade ${kind}`)
      }
      if (kind === 'queue') {
        // Pause is an operation control: establish an open turn before requesting it.
        void session.prompt('upgrade hold').catch(() => undefined)
        await eventually(async () => (await session.projectUI()).opState !== null, 'queue turn admission')
        await session.pause()
        await session.followUp('Synthetic queued message')
        assert.match(JSON.stringify(await session.controls()), /Synthetic queued message/)
      }
      const timeline = await session.projectUI(undefined, { surface: 'web' })
      assert.ok(
        JSON.stringify(timeline).includes('Synthetic upgrade reply'),
        'seed assistant history missing',
      )
      if (kind === 'tool')
        assert.ok(
          JSON.stringify(timeline).includes('Synthetic tool input'),
          'read tool result missing from history',
        )
      if (kind === 'present')
        assert.ok(
          JSON.stringify(timeline).includes('Upgrade report'),
          'present deliverable missing from history',
        )
      if (kind === 'attachment')
        assert.ok(JSON.stringify(timeline).includes('upgrade.txt'), 'attachment missing from history')
      sessions.push({ kind, id: session.id, timeline, attachment })
    }
    // The pre-watermark distribution supplies the existing-fork upgrade fixture. The recent
    // baseline cannot create forks because its artifact parser rejects valid null inbox resets.
    if (!managed) {
      const forkAt = sessions[0].timeline.turns.at(-1).endSeq
      assert.ok(forkAt, 'plain turn must have a durable completed boundary')
      const fork = await sdk.session.fork(sessions[0].id, forkAt)
      await sdk.session.load(fork.id, { cwd: workspace })
      await fork.prompt('upgrade fork')
      sessions.push({
        kind: 'fork',
        id: fork.id,
        timeline: await fork.projectUI(undefined, { surface: 'web' }),
      })
    }
    assert.equal(
      new Set(sessions.map((row) => row.id)).size,
      managed ? 5 : 6,
      'fixture sessions must be distinct',
    )
    const schedule = await sdk.call('_agnes/v1/schedules.upsert', {
      title: 'Synthetic upgrade schedule',
      prompt: 'upgrade scheduled',
      selector: { every_seconds: 86400 },
      target: { kind: 'new-session', cwd: workspace },
    })
    const trigger = {
      id: 'upgrade-trigger',
      enabled: false,
      provider: 'generic',
      auth: 'bearer',
      secretRef: 'secret://webhooks/synthetic',
      event: 'created',
      filters: {},
      workspace,
      agent: 'default',
      bundles: [],
      template: '{{$.title}}',
      timestampPath: '$.time',
      windowSeconds: 300,
      ratePerMinute: 10,
    }
    await sdk.call('_agnes/v1/admin.triggers', { action: 'upsert', rule: trigger })
    const roster = await sdk.clientModules.list('local-dev')
    assert.ok(
      roster.rows.some((row) => row.packageId === packageId && row.phase === 'ready'),
      JSON.stringify(roster),
    )
    const inventory = await sdk.packages.list({ profile: 'local-dev' })
    await writeFile(
      stateFile,
      JSON.stringify({
        managed,
        marker,
        serviceOwner,
        ledger: ledgerRows(),
        sessions,
        schedule,
        trigger,
        config: await sdk.config.get(),
        inventory,
        roster,
        prompt: await sdk.call('_agnes/v1/systemPrompt.get', {}),
      }),
    )
    console.info(
      `Seed complete: ${sessions.length} distinct sessions; managed=${managed}; package client, config, schedule, disabled trigger`,
    )
  } else if (phase === 'managed') {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    serviceOwner = state.serviceOwner
    await verifyManaged(state)
  } else {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    serviceOwner = state.serviceOwner
    const rows = new Map(ledgerRows().map((row) => [`${row.session_key}:${row.seq}`, row]))
    for (const row of state.ledger)
      assert.deepEqual(rows.get(`${row.session_key}:${row.seq}`), row, 'historical event was rewritten')
    const { effect: _currentEffect, ...currentConfig } = await sdk.config.get()
    const { effect: _previousEffect, ...previousConfig } = state.config
    // `effect` is runtime strategy. Older stores derive the new execution revision from their revision.
    assert.deepEqual(currentConfig, {
      ...previousConfig,
      executionRevision: previousConfig.executionRevision ?? previousConfig.revision,
    })
    const prompt = await sdk.call('_agnes/v1/systemPrompt.get', {})
    assert.equal(prompt.config.personaSuffix, state.prompt.config.personaSuffix)
    const schedules = await sdk.call('_agnes/v1/schedules.list', { scope: 'all', includeArchived: true })
    assert.deepEqual(
      schedules.schedules.find((row) => row.id === state.schedule.id),
      state.schedule,
    )
    const triggers = await sdk.call('_agnes/v1/admin.triggers', { action: 'list' })
    assert.deepEqual(
      triggers.snapshot.rules.find((row) => row.id === state.trigger.id),
      state.trigger,
    )
    for (const { id, kind, timeline, attachment } of state.sessions) {
      const session = await sdk.session.load(id, { cwd: workspace })
      const opening = await session.projectUI(undefined, { surface: 'web' })
      assert.ok(opening.nodes.length >= timeline.nodes.length, `${kind}: missing history`)
      assert.match(JSON.stringify(opening), /Synthetic upgrade reply/)
      for (const node of timeline.nodes.filter((row) => ['user', 'assistant'].includes(row.kind))) {
        const rendered = opening.nodes.find((row) => row.id === node.id)
        assert.ok(rendered, `${kind}: history node disappeared`)
        assert.deepEqual(rendered.content, node.content, `${kind}: rendered history changed`)
        assert.equal(rendered.text, node.text, `${kind}: rendered assistant text changed`)
      }
      if (kind === 'present') {
        const expected = Buffer.from('<h1>Synthetic deliverable</h1>')
        const artifact = {
          sha256: createHash('sha256').update(expected).digest('hex'),
          size: expected.length,
          mime: 'text/html',
        }
        const download = await sdk.call('_agnes/v1/artifact.read', {
          sessionId: id,
          laneId: 'main',
          artifact,
        })
        assert.equal(download.ok, true, 'presented deliverable unavailable after upgrade')
        assert.deepEqual(Buffer.from(download.base64, 'base64'), expected)
      }
      if (attachment?.attachment?.artifact) {
        const bytes = await sdk.call('_agnes/v1/artifact.read', {
          sessionId: id,
          laneId: 'main',
          artifact: attachment.attachment.artifact,
        })
        assert.equal(bytes.ok, true, 'uploaded original unavailable after upgrade')
        assert.equal(
          Buffer.from(bytes.base64, 'base64').toString(),
          'Synthetic attachment retained across upgrade. 中文',
        )
      } else if (attachment) {
        // The oldest upload contract materialized workspace files, before original-store intake.
        const match = /^agnes-upload:\/\/([a-f0-9]{64})\/([a-f0-9]{64})\/\d+\/([a-f0-9-]{36})$/.exec(
          attachment.uri,
        )
        assert.ok(match)
        assert.equal(
          await readFile(join(workspace, '.agnes-attachments', match[1], match[3], match[2]), 'utf8'),
          'Synthetic attachment retained across upgrade. 中文',
        )
      }
      if (kind === 'queue') {
        assert.match(JSON.stringify(await session.controls()), /Synthetic queued message/)
        if ((await session.controls()).paused) await session.resume()
        await eventually(async () => {
          const after = await session.projectUI()
          const queued = after.nodes.find(
            (row) =>
              row.kind === 'user' && row.content?.some((block) => block.text === 'Synthetic queued message'),
          )
          return (
            after.opState === null &&
            queued &&
            after.turns.some((turn) => turn.status === 'completed' && turn.nodeIds.includes(queued.id))
          )
        }, 'queued input completes after explicit resume')
      }
      // A real successful turn is stronger than a read-only history preview.
      const continuation = `Continue upgraded ${kind}`
      const result = await session.prompt(continuation)
      assert.equal(result.reason, 'completed', `${kind}: cannot continue`)
      await eventually(async () => {
        const after = await session.projectUI(undefined, { surface: 'web' })
        const user = after.nodes.find(
          (row) => row.kind === 'user' && row.content?.some((block) => block.text === continuation),
        )
        return (
          after.upto > timeline.upto &&
          user &&
          after.turns.some((turn) => turn.status === 'completed' && turn.nodeIds.includes(user.id))
        )
      }, `${kind}: persisted completed continuation`)
      console.info(`Upgrade session ${kind}: history + continuation passed`)
    }
    const inventory = await sdk.packages.list({ profile: 'local-dev' })
    const presentationRoster = await sdk.clientModules.list('local-dev')
    for (const name of ['goal-ui', 'interaction-ui', 'deliverables-ui']) {
      const id = `@agnes/${name}`
      const current = inventory.packages.find((row) => row.id === id)
      assert.ok(current, `${id}: missing after previous-build upgrade`)
      assert.equal(current.trusted, true, `${id}: not trusted`)
      assert.equal(current.desired, 'enabled', `${id}: not enabled`)
      assert.equal(current.actual, 'running', `${id}: not published/running`)
      assert.deepEqual(current.blockers, [], `${id}: blocked`)
      assert.ok(
        presentationRoster.rows.some((row) => row.packageId === id && row.phase === 'ready'),
        `${id}: presentation not available`,
      )
    }
    let unchangedGrantDefaults = 0
    for (const old of state.inventory.packages) {
      const current = inventory.packages.find((row) => row.id === old.id)
      assert.ok(current, `lost package ${old.id}`)
      assert.equal(current.trusted, true, `${old.id}: lost trust`)
      assert.equal(current.desired, 'enabled', `${old.id}: disabled`)
      assert.deepEqual(current.blockers, [], `${old.id}: package blocked`)
      assert.equal(current.actual, 'running', `${old.id}: not running`)
      if (old.id === packageId) {
        assert.equal(current.integrity, old.integrity)
        assert.equal(
          current.capabilityHash,
          old.capabilityHash,
          'upgrade must not silently grant client streams',
        )
      } else if (old.id.startsWith('@agnes/')) {
        const candidate = (
          await admin.complete(
            await sdk.packages.inspect({ ...(await admin.command()), source: current.source }),
          )
        ).preview
        if (old.capabilityHash === candidate.capabilityHash) {
          unchangedGrantDefaults++
          assert.equal(current.integrity, candidate.integrity, `${old.id}: bundled default stayed stale`)
          assert.equal(current.version, candidate.version, `${old.id}: bundled version stayed stale`)
        } else {
          // Changed authority needs a reviewed update; discovery must offer the shipped candidate.
          const offered = await sdk.packages.catalog.get({ profile: 'local-dev', id: old.id })
          assert.equal(offered.integrity, candidate.integrity, `${old.id}: missing bundled update offer`)
          assert.equal(offered.version, candidate.version)
          assert.equal(current.capabilityHash, old.capabilityHash)
        }
      }
    }
    assert.ok(unchangedGrantDefaults > 0, 'fixture must exercise an automatic bundled-default refresh')
    console.info('Upgrade packages: enabled, trusted, running; bundled bytes match distribution')
    const currentRows = (await sdk.clientModules.list('local-dev')).rows.filter(
      (row) => row.packageId === packageId,
    )
    const previousRows = state.roster.rows.filter((row) => row.packageId === packageId)
    const stableRow = ({ binding: _binding, clientId: _clientId, ...row }) => row
    assert.deepEqual(currentRows.map(stableRow), previousRows.map(stableRow))
    for (const row of currentRows) {
      const prior = previousRows.find((old) => old.rowId === row.rowId)
      // The current roster adds an explicit client identity; this fixture has no authored id.
      assert.equal(row.clientId, prior.clientId ?? prior.rowId)
      if (prior.binding) assert.deepEqual(row.binding, prior.binding)
      else
        assert.deepEqual(
          row.binding && {
            packageId: row.binding.packageId,
            integrity: row.binding.integrity,
            profileId: row.binding.profileId,
            availability: row.binding.availability,
          },
          {
            packageId,
            integrity: inventory.packages.find((item) => item.id === packageId).integrity,
            profileId: 'local-dev',
            availability: 'active',
          },
        )
    }
    await verifyManaged(state)
  }
} finally {
  await sdk.close()
}
