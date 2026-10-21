import { type EventEnvelope, readSessionTitle } from '@agnes/protocol'
import { sidebarMessageTime } from '../src/storage/sidebar-message.js'
import type { TableHandle } from '../src/storage/table.js'

/** The projection's per-event fold before batching: one row read and one UPDATE for every event it
 * changes. `unconditional` writes even when the row already holds the event. */
export function sequential(
  table: TableHandle,
  key: string,
  event: EventEnvelope,
  generation: number,
  unconditional = false,
) {
  const row = table.get<{
    createdAt: string | null
    lastSeq: number
    generation: number
    preset: string | null
    profileHash: string | null
    title: string | null
    lastActiveAt: string | null
    messageAt: number | null
    messageSeq: number
    sortAt: number
  }>(
    'SELECT created_at AS createdAt, last_seq AS lastSeq, generation, preset, profile_hash AS profileHash, title, last_active_at AS lastActiveAt, message_at AS messageAt, message_seq AS messageSeq, sidebar_sort_at AS sortAt FROM session_workspaces WHERE session_key = ?',
    [key],
  )
  if (!row) return
  const created0 = row.createdAt ? Date.parse(row.createdAt) : Number.NaN
  if (
    !unconditional &&
    row.createdAt &&
    row.title !== '' &&
    row.lastActiveAt !== '' &&
    event.seq <= row.lastSeq &&
    event.seq <= row.messageSeq &&
    generation <= row.generation &&
    row.sortAt === (row.messageAt ?? (Number.isFinite(created0) ? created0 : 0))
  )
    return
  let createdAt = row.createdAt ?? ''
  let preset = row.preset
  let profileHash = row.profileHash
  let title = row.title || undefined
  let lastActiveAt = row.lastActiveAt || undefined
  const messageAt = sidebarMessageTime(event) ?? null
  if (event.seq > row.lastSeq) {
    const generated = readSessionTitle(event)
    if (generated?.status === 'generated') title = generated.title
    if (event.type === 'session/start' && (event.data as { key?: string })?.key === key) title = undefined
    if (event.type === 'user/message') lastActiveAt = event.ts
  }
  const data = event.data as { preset?: unknown; resolvedProfileHash?: unknown; to?: unknown; loop?: unknown }
  if (event.type === 'session/start' && (event.seq > row.lastSeq || !createdAt)) {
    const loop = data?.loop as { id?: unknown; version?: unknown } | undefined
    const pin =
      loop && typeof loop.id === 'string' && loop.id && typeof loop.version === 'string' && loop.version
        ? { id: loop.id, version: loop.version }
        : null
    table.exec('UPDATE session_workspaces SET loop_pin = ? WHERE session_key = ?', [JSON.stringify(pin), key])
    if (!createdAt) createdAt = event.ts
    preset = typeof data?.preset === 'string' ? data.preset : null
    profileHash = typeof data?.resolvedProfileHash === 'string' ? data.resolvedProfileHash : null
  } else if (event.seq > row.lastSeq && event.type === 'x/core/preset-switch' && typeof data?.to === 'string')
    preset = data.to
  table.exec(
    `UPDATE session_workspaces
     SET created_at = ?, last_seq = CASE WHEN last_seq < ? THEN ? ELSE last_seq END,
         generation = CASE WHEN generation < ? THEN ? ELSE generation END,
         preset = ?, profile_hash = ?, title = ?, last_active_at = ?,
         message_at = CASE WHEN ? > message_seq AND ? IS NOT NULL THEN MAX(COALESCE(message_at, ?), ?) ELSE message_at END,
         sidebar_sort_at = CASE WHEN ? > message_seq AND ? IS NOT NULL
           THEN MAX(COALESCE(message_at, ?), ?) ELSE COALESCE(message_at, ?) END,
         message_seq = CASE WHEN ? = message_seq + 1 THEN ? ELSE message_seq END
     WHERE session_key = ?`,
    [
      createdAt || null,
      event.seq,
      event.seq,
      generation,
      generation,
      preset,
      profileHash,
      title ?? null,
      lastActiveAt ?? null,
      event.seq,
      messageAt,
      messageAt,
      messageAt,
      event.seq,
      messageAt,
      messageAt,
      messageAt,
      Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : 0,
      event.seq,
      event.seq,
      key,
    ],
  )
}
