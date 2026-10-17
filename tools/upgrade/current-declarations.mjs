import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Real reviewed update after boot: new sessions resolve current declarations, old pins stay sealed. */
export async function verifyCurrentDeclarations(sdk, admin, workspace) {
  const directory = join(workspace, 'current-snapshot-plugin')
  await mkdir(directory)
  const launch = {
    title: { en: 'Upgrade agent' },
    description: { en: 'Synthetic upgrade agent' },
    preset: 'upgrade',
  }
  const application = {
    id: 'upgrade',
    brand: { name: { en: 'Upgrade application' } },
    defaultAgent: 'acme/legacy#work',
    agents: ['acme/legacy#work'],
  }
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'acme/legacy',
      version: '2.0.0',
      license: 'MIT',
      dependencies: { 'acme/parent': '^1.0.0' },
      exports: './index.mjs',
      agnes: {
        plugins: [{ id: 'ext:acme/legacy', export: 'runtime', apiRange: '^4.0.0', runtime: 'in-process' }],
        bundles: { work: { presets: { upgrade: { name: 'upgrade', extends: 'standard' } }, launch } },
        application,
      },
    }),
  )
  await writeFile(
    join(directory, 'index.mjs'),
    "export const runtime = { apply() {} }; export default () => 'current-v2-bytes'\n",
  )
  const source = { type: 'file', ref: `file:${directory}` }
  const preview = (await admin.complete(await sdk.packages.inspect({ ...(await admin.command()), source })))
    .preview
  await admin.complete(
    await sdk.packages.update({
      ...(await admin.command()),
      id: 'acme/legacy',
      source,
      expectedIntegrity: preview.integrity,
    }),
  )
  await admin.complete(
    await sdk.packages.trust({
      ...(await admin.command()),
      id: 'acme/legacy',
      expectedIntegrity: preview.integrity,
      capabilityHash: preview.capabilityHash,
    }),
  )
  for (const id of ['acme/parent', 'acme/legacy'])
    await admin.complete(await sdk.packages.enable({ ...(await admin.command()), id }))
  const inventory = await sdk.packages.list({ profile: 'local-dev' })
  const current = inventory.packages.find((row) => row.id === 'acme/legacy')
  assert.deepEqual(current.agents, [{ ref: 'acme/legacy#work', launch }])
  assert.deepEqual(current.application, application)
  const app = await sdk.call('_agnes/v1/applications.preview', {
    profile: 'local-dev',
    packageId: 'acme/legacy',
  })
  assert.deepEqual(app.declaration, application)
  const plan = await sdk.call('_agnes/v1/agents.resolve', { ref: 'acme/legacy#work' })
  assert.deepEqual(plan.launch, launch)
  const session = await sdk.session.new({
    cwd: workspace,
    agent: 'acme/legacy#work',
    agentDigest: plan.digest,
  })
  assert.equal((await session.prompt('upgrade current agent')).reason, 'completed')
  // Reopening the captured turn pin is checked by verifyRuntimeSnapshotFixture after this update.
}
