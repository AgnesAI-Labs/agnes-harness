import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import type { CreateClientOptions } from './client.js'
import { memoryJournal, randomId } from './journal.js'
import { fileJournal } from './journal-file.node.js'

function directoryName(clientId: string): string {
  try {
    if (typeof clientId !== 'string' || !clientId) throw new Error()
    const encoded = encodeURIComponent(clientId).replace(
      /[!'()*~.]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    return encoded.length <= 200 ? encoded : `~${createHash('sha256').update(clientId).digest('hex')}`
  } catch {
    throw new Error('invalid journal identity')
  }
}
export function defaultNodeJournal(options: CreateClientOptions) {
  if (options.journal) return options.journal
  const clientId = options.clientId ?? randomId()
  if (options.transport.kind === 'inproc') return memoryJournal(clientId)
  return fileJournal(join(homedir(), AGH_DIR, 'sdk', directoryName(clientId)), clientId)
}
