import { createClient, memoryJournal } from '@agnes/sdk'
import { resolve } from 'node:path'
const profile = process.env.AGNES_PROFILE ?? 'local-dev'
const source = process.env.AGH_SOURCE
if (!source) throw new Error('Set AGH_SOURCE / 请设置 AGH_SOURCE')
const client = createClient({
  transport: {
    kind: 'stdio',
    cmd: [process.execPath, resolve(source, 'agnes.mjs'), 'app-server', '--stdio', '--profile', profile],
  },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
try {
  await client.initialize()
  const state = await client.request('_agnes/v1/applications.get', { profile })
  const preview = await client.request('_agnes/v1/applications.preview', {
    profile,
    packageId: '@agnes-showcase/aerospace-quality',
  })
  const { assets, ...review } = preview
  console.log(JSON.stringify({ revision: state.revision, review, assetKinds: Object.keys(assets) }, null, 2))
  if (process.argv.includes('--adopt')) {
    const adopted = await client.request('_agnes/v1/applications.adopt', {
      profile,
      packageId: preview.packageId,
      expectedRevision: state.revision,
      consentDigest: preview.consentDigest,
      clientId: await client.clientId(),
      commandId: crypto.randomUUID(),
    })
    if (adopted.status !== 'active') throw new Error(`Adoption refused / 采纳被拒绝: ${adopted.reason}`)
    console.log(JSON.stringify({ status: adopted.status, application: adopted.effective?.id }))
  }
} finally {
  await client.close()
}
