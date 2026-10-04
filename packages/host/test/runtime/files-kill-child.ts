import {
  ACQUIRE_ID,
  BODY,
  callFor,
  FILE_NAME,
  loadProfile,
  openFiles,
  type RenamedReport,
  WRITE_ID,
} from './files-kill-fixture.js'

const kind = process.argv[2]
const directory = process.argv[3]
if ((kind !== 'default' && kind !== 'reference') || !directory) {
  process.stderr.write('usage: files-kill-child <default|reference> <directory>\n')
  process.exit(2)
}

let report: RenamedReport | undefined
const opened = openFiles(kind, directory, () => {
  // process.send issues the pipe write before it returns. Park in the hook so the receipt is never sent.
  if (!report || process.send?.(report) !== true) process.stderr.write('rename report was not delivered\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})

const profile = loadProfile(directory)
const bound = await opened.workspace.bind(profile.workspaceId, opened.work)
if (!bound.ok) {
  process.stderr.write(`${bound.error.detailCode}\n`)
  process.exit(1)
}
const acquired = await opened.workspace.acquire(
  { workspaceId: profile.workspaceId, mode: 'write', expectedRevision: null },
  callFor(profile, ACQUIRE_ID),
)
if (!acquired.ok) {
  process.stderr.write(`${acquired.error.detailCode}\n`)
  process.exit(1)
}
const staged = await opened.files.stageBytes(Buffer.from(BODY))
if (!staged.ok) {
  process.stderr.write(`${staged.error.detailCode}\n`)
  process.exit(1)
}
report = {
  stage: 'renamed',
  mountRef: acquired.value.mountRef,
  bytesRef: staged.value,
  invocationId: WRITE_ID,
  path: FILE_NAME,
}
const wrote = await opened.files.write(
  {
    mountRef: acquired.value.mountRef,
    path: FILE_NAME,
    bytesRef: staged.value,
    expectedVersion: { kind: 'absent' },
  },
  callFor(profile, WRITE_ID),
)
process.send?.({
  stage: 'receipt',
  ok: wrote.ok,
  detail: wrote.ok ? null : wrote.error.detailCode,
})
opened.close()
