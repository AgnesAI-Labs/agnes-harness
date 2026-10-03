import { openInstallerApplyFixture } from './installer-apply.js'

const directory = process.env.INSTALLER_APPLY_DIRECTORY!
const kind = process.env.INSTALLER_APPLY_KIND === 'reference' ? 'reference' : 'default'
const operation = process.env.INSTALLER_APPLY_OPERATION === 'resource' ? 'resource' : 'install'
const pause = process.env.INSTALLER_APPLY_PAUSE
const f = await openInstallerApplyFixture(
  kind,
  directory,
  operation,
  async (phase) => {
    if (phase === pause) {
      process.send?.({ phase, proposalId: f.request.requestId })
      await new Promise<void>(() => {
        process.on('message', () => {})
      })
    }
  },
  process.env.INSTALLER_APPLY_BUILD === '1' ? {} : undefined,
)
try {
  const accepted = await f.subject.requestChange(f.request, f.call)
  if (!accepted.ok) throw new Error(accepted.error.detailCode)
  if (process.env.INSTALLER_APPLY_READ === '1') {
    const status = await f.query.subject.proposalStatus(
      { proposalId: accepted.value.proposalId },
      { ...f.call, invocationId: 'reconnected-client' },
    )
    process.stdout.write(
      JSON.stringify({
        status,
        record: f.journal.read(accepted.value.proposalId),
        snapshot: f.assembly.snapshot(),
      }),
    )
  } else {
    const linked = await f.approved()
    const applied = await f.controller.apply(linked.proposalId, linked.revision, f.call)
    if (!applied.ok) throw new Error(applied.error.detailCode)
    process.send?.({ phase: 'done', proposalId: applied.value.proposalId })
    if (pause === 'done')
      await new Promise<void>(() => {
        process.on('message', () => {})
      })
  }
} finally {
  await f.close()
}
