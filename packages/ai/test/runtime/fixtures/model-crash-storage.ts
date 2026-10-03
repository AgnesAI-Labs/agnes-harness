import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs'
/** Restricted durable owner; actual bytes survive provider SIGKILL before its save promise resumes. */
export function persistModelCrashFacts(file: string, body: string) {
  const temporary = `${file}.writing`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, file)
}
