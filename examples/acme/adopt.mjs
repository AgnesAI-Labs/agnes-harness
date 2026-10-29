// Run with the matching source-preview SDK; see README.md. Preview never adopts implicitly.
import { createClient, memoryJournal } from '@agnes/sdk'

const source = process.env.AGH_SOURCE
if (!source) throw new Error('Set AGH_SOURCE to the built source checkout')
const profile = process.env.AGNES_PROFILE ?? 'local-dev'
const client = createClient({
  transport: {
    kind: 'stdio',
    cmd: [process.execPath, `${source}/agnes.mjs`, 'app-server', '--stdio', '--profile', profile],
  },
  auth: { kind: 'local' },
  journal: memoryJournal('acme-adoption'),
})
try {
  await client.initialize()
  const state = await client.request('_agnes/v1/applications.get', { profile })
  const preview = await client.request('_agnes/v1/applications.preview', {
    profile,
    packageId: '@acme/operations',
  })
  // Asset bytes are omitted from terminal output; the UI preview shows them.
  const { assets, ...review } = preview
  console.log(
    JSON.stringify(
      { revision: state.revision, current: state.status, preview: review, assetKinds: Object.keys(assets) },
      null,
      2,
    ),
  )
  if (process.env.ACME_ADOPT === '1') {
    const adopted = await client.request('_agnes/v1/applications.adopt', {
      profile,
      packageId: preview.packageId,
      expectedRevision: state.revision,
      consentDigest: preview.consentDigest,
      clientId: await client.clientId(),
      commandId: crypto.randomUUID(),
    })
    if (adopted.status !== 'active') throw new Error(`Application unavailable: ${adopted.reason}`)
    console.log(JSON.stringify({ status: adopted.status, application: adopted.effective?.id }))
  }
} finally {
  await client.close()
}
