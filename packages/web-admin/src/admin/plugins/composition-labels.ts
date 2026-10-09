import type { AdminLoop } from '@agnes/protocol'

export const identity = (entry: { id: string; version: string }) => JSON.stringify([entry.id, entry.version])
export const label = (entry: Pick<AdminLoop, 'id' | 'version' | 'label'>) =>
  `${entry.label ?? entry.id} · ${entry.version}`
