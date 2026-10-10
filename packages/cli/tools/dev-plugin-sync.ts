import { cp, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { PackageOperation, PackagePreview } from '@agnes/protocol'
import { createClient, memoryJournal, type NodeClient } from '@agnes/sdk'

/**
 * Development launcher helper: after `make dev` rebuilds the runtime, the profile's installed
 * plugin snapshots still hold the previous build — the daemon serves those, so source changes to
 * a bundled plugin stay invisible until the snapshot is refreshed. This tool stages the freshly
 * built bundled jev-web payload into the daemon workspace (relative `file:./` sources resolve
 * there), compares integrity with the installed entry, and runs one authorized
 * `packages.update` — with activation re-trust, since the new payload has a new integrity — so
 * the Web plugin tracks the build without a manual install/trust dance.
 *
 * Never installs: a profile without the plugin keeps its own choice; only in-place refresh.
 * Staging is one directory per build tag and never deleted by this tool (see below).
 */

const flag = (name: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`missing --${name}`)
  return value
}

const PACKAGE_ID = '@agnes/jev-web'

function commandId(kind: string): string {
  return `dev-plugin-sync:${kind}:${Date.now()}`
}

async function waitTerminal(
  client: NodeClient,
  receipt: { operationId: string },
  profile: string,
): Promise<PackageOperation> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const operation = await client.packages.operation.get({
      profile,
      operationId: receipt.operationId,
    })
    if (['completed', 'failed', 'cancelled', 'rolled-back'].includes(operation.state)) return operation
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`package operation ${receipt.operationId} did not finish`)
}

async function main(): Promise<void> {
  const socket = flag('socket')
  const profile = flag('profile')
  const runtime = flag('runtime')
  const workspace = flag('workspace')

  // bundled-plugins carries the package directory without the scope: bundled-plugins/jev-web.
  const bundled = join(runtime, 'bundled-plugins', PACKAGE_ID.split('/')[1] ?? '')
  if (!PACKAGE_ID.split('/')[1]) throw new Error(`unexpected package id ${PACKAGE_ID}`)
  // One staging directory per build tag, never deleted in place: this runs inside the operator's
  // workspace, and an rm-based refresh of a shared path is a destructive act this tool must not
  // perform unattended. Stale directories from older builds are inert (the daemon only reads the
  // ref it is handed) and can be pruned by hand.
  const buildTag = basename(dirname(runtime)) || 'build'
  const stage = join(workspace, '.agnes-dev', `jev-web-${buildTag}`)
  await mkdir(stage, { recursive: true })
  await cp(bundled, stage, { recursive: true })
  const stageRef = `file:./.agnes-dev/jev-web-${buildTag}`

  const client = createClient({
    transport: { kind: 'unix', path: socket },
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  try {
    await client.initialize()
    const clientId = await client.clientId()
    const source = { type: 'file', ref: stageRef } as const
    const installed = (await client.packages.list({ profile })).packages.find((row) => row.id === PACKAGE_ID)
    if (!installed) {
      process.stdout.write(`dev plugin sync: ${PACKAGE_ID} is not installed; leaving the profile as-is.\n`)
      return
    }
    const inspect = await client.packages.inspect({
      profile,
      clientId,
      commandId: commandId('inspect'),
      source,
    })
    const inspected = await waitTerminal(client, inspect, profile)
    if (inspected.state !== 'completed' || !inspected.preview)
      throw new Error(`inspect ${inspected.state}: ${JSON.stringify(inspected.error ?? {})}`)
    const preview = inspected.preview as PackagePreview
    if (preview.integrity === installed.integrity) {
      process.stdout.write(`dev plugin sync: ${PACKAGE_ID} snapshot already matches this build.\n`)
      return
    }
    const update = await client.packages.update({
      profile,
      clientId,
      commandId: commandId('update'),
      id: PACKAGE_ID,
      source,
      expectedIntegrity: preview.integrity,
      activation: {
        expectedInstalledIntegrity: installed.integrity,
        expectedActiveIntegrity: installed.integrity,
        trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash ?? '' },
      },
    })
    const done = await waitTerminal(client, update, profile)
    if (done.state !== 'completed')
      throw new Error(`update ${done.state}: ${JSON.stringify(done.error ?? {})}`)
    process.stdout.write(
      `dev plugin sync: ${PACKAGE_ID} refreshed to this build (${preview.integrity.slice(0, 19)}…).\n`,
    )
  } finally {
    await client.close().catch(() => undefined)
  }
}

await main()
