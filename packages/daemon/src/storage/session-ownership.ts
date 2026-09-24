import { types as utilTypes } from 'node:util'
import type { TableHandle } from './table.js'

const MAX_IDENTITY_LENGTH = 512

export type ActiveSessionPrincipal = Readonly<{ active: true; principalId: string }>

/** Private server-owned binding. Both values come from authenticated server state, never payloads. */
export interface SessionPrincipalOwnership {
  bindNew(sessionId: string, principalId: string): boolean
  ownsNewReservation(sessionId: string, principalId: string): boolean
  activateNew(sessionId: string, principalId: string): boolean
  inherit(parentSessionId: string, childSessionId: string, principalId: string, boundarySeq: number): boolean
  activateFork(
    parentSessionId: string,
    childSessionId: string,
    principalId: string,
    boundarySeq: number,
  ): boolean
  resolve(sessionId: string): ActiveSessionPrincipal | undefined
  activeSessionIds(principalId: string): readonly string[]
}

type ReservationKind = 'new' | 'fork'
type ReservationState = 'pending' | 'active'
type OwnershipRow = {
  principal_id: unknown
  reservation_kind: unknown
  reservation_state: unknown
  parent_session_id: unknown
  boundary_seq: unknown
}
type Reservation = Readonly<{
  principalId: string
  kind: ReservationKind
  state: ReservationState
  parentSessionId?: string
  boundarySeq?: number
}>

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_LENGTH &&
    value === value.normalize('NFC') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f
    })
  )
}

function unavailable(): Error {
  return new Error('session principal ownership unavailable')
}

/** Durable insert-only ownership. Existing rows can be read or inherited, never reassigned. */
export class SessionPrincipalOwnershipIndex implements SessionPrincipalOwnership {
  private readonly table: TableHandle

  constructor(capability: TableHandle) {
    try {
      if (!capability || typeof capability !== 'object' || utilTypes.isProxy(capability)) throw unavailable()
      const descriptors = Object.getOwnPropertyDescriptors(capability)
      const method = (name: 'exec' | 'get' | 'all' | 'transaction') => {
        const value = descriptors[name]?.value
        if (typeof value !== 'function' || utilTypes.isProxy(value)) throw unavailable()
        return value.bind(capability)
      }
      this.table = Object.freeze({
        exec: method('exec'),
        get: method('get'),
        all: method('all'),
        transaction: method('transaction'),
      }) as TableHandle
      this.table.exec(
        `CREATE TABLE IF NOT EXISTS session_principal_ownership (
          session_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          reservation_kind TEXT NOT NULL,
          reservation_state TEXT NOT NULL,
          parent_session_id TEXT,
          boundary_seq INTEGER
        )`,
      )
    } catch {
      throw unavailable()
    }
  }

  bindNew(sessionId: string, principalId: string): boolean {
    if (!validIdentity(sessionId) || !validIdentity(principalId)) return false
    try {
      return this.table.transaction(() => {
        const current = this.read(sessionId)
        if (current !== undefined) return current.principalId === principalId && current.kind === 'new'
        this.table.exec(
          `INSERT INTO session_principal_ownership
           (session_id, principal_id, reservation_kind, reservation_state, parent_session_id, boundary_seq)
           VALUES (?, ?, 'new', 'pending', NULL, NULL)`,
          [sessionId, principalId],
        )
        return true
      })
    } catch {
      throw unavailable()
    }
  }

  ownsNewReservation(sessionId: string, principalId: string): boolean {
    if (!validIdentity(sessionId) || !validIdentity(principalId)) return false
    try {
      const current = this.read(sessionId)
      return current?.principalId === principalId && current.kind === 'new'
    } catch {
      throw unavailable()
    }
  }

  activateNew(sessionId: string, principalId: string): boolean {
    return this.activate({ sessionId, principalId, kind: 'new' })
  }

  inherit(
    parentSessionId: string,
    childSessionId: string,
    principalId: string,
    boundarySeq: number,
  ): boolean {
    if (
      !validIdentity(parentSessionId) ||
      !validIdentity(childSessionId) ||
      !validIdentity(principalId) ||
      parentSessionId === childSessionId ||
      !Number.isSafeInteger(boundarySeq) ||
      boundarySeq < 1
    )
      return false
    try {
      return this.table.transaction(() => {
        const parent = this.read(parentSessionId)
        if (parent?.principalId !== principalId || parent.state !== 'active') return false
        const childOwner = this.read(childSessionId)
        if (childOwner !== undefined)
          return (
            childOwner.principalId === principalId &&
            childOwner.kind === 'fork' &&
            childOwner.parentSessionId === parentSessionId &&
            childOwner.boundarySeq === boundarySeq
          )
        this.table.exec(
          `INSERT INTO session_principal_ownership
           (session_id, principal_id, reservation_kind, reservation_state, parent_session_id, boundary_seq)
           VALUES (?, ?, 'fork', 'pending', ?, ?)`,
          [childSessionId, principalId, parentSessionId, boundarySeq],
        )
        return true
      })
    } catch {
      throw unavailable()
    }
  }

  activateFork(
    parentSessionId: string,
    childSessionId: string,
    principalId: string,
    boundarySeq: number,
  ): boolean {
    if (!validIdentity(parentSessionId) || !Number.isSafeInteger(boundarySeq) || boundarySeq < 1) return false
    return this.activate({
      sessionId: childSessionId,
      principalId,
      kind: 'fork',
      parentSessionId,
      boundarySeq,
    })
  }

  resolve(sessionId: string): ActiveSessionPrincipal | undefined {
    if (!validIdentity(sessionId)) return undefined
    try {
      const reservation = this.read(sessionId)
      return reservation?.state === 'active'
        ? Object.freeze({ active: true, principalId: reservation.principalId })
        : undefined
    } catch {
      throw unavailable()
    }
  }

  activeSessionIds(principalId: string): readonly string[] {
    if (!validIdentity(principalId)) return []
    try {
      return Object.freeze(
        this.table
          .all<OwnershipRow & { session_id: unknown }>(
            `SELECT session_id, principal_id, reservation_kind, reservation_state,
                    parent_session_id, boundary_seq FROM session_principal_ownership
             WHERE principal_id = ? AND reservation_state = 'active' ORDER BY session_id`,
            [principalId],
          )
          .map((row) => {
            if (!validIdentity(row.session_id)) throw unavailable()
            const reservation = this.decode(row)
            if (reservation.principalId !== principalId || reservation.state !== 'active') throw unavailable()
            return row.session_id
          }),
      )
    } catch {
      throw unavailable()
    }
  }

  private activate(input: {
    sessionId: string
    principalId: string
    kind: ReservationKind
    parentSessionId?: string
    boundarySeq?: number
  }): boolean {
    if (!validIdentity(input.sessionId) || !validIdentity(input.principalId)) return false
    try {
      return this.table.transaction(() => {
        const current = this.read(input.sessionId)
        if (
          !current ||
          current.principalId !== input.principalId ||
          current.kind !== input.kind ||
          current.parentSessionId !== input.parentSessionId ||
          current.boundarySeq !== input.boundarySeq
        )
          return false
        if (current.state === 'active') return true
        this.table.exec(
          "UPDATE session_principal_ownership SET reservation_state = 'active' WHERE session_id = ? AND reservation_state = 'pending'",
          [input.sessionId],
        )
        return this.read(input.sessionId)?.state === 'active'
      })
    } catch {
      throw unavailable()
    }
  }

  private read(sessionId: string): Reservation | undefined {
    const row = this.table.get<OwnershipRow>(
      `SELECT principal_id, reservation_kind, reservation_state, parent_session_id, boundary_seq
       FROM session_principal_ownership WHERE session_id = ?`,
      [sessionId],
    )
    if (!row) return undefined
    return this.decode(row)
  }

  private decode(row: OwnershipRow): Reservation {
    if (
      !validIdentity(row.principal_id) ||
      (row.reservation_kind !== 'new' && row.reservation_kind !== 'fork') ||
      (row.reservation_state !== 'pending' && row.reservation_state !== 'active')
    )
      throw unavailable()
    if (row.reservation_kind === 'new') {
      if (row.parent_session_id !== null || row.boundary_seq !== null) throw unavailable()
      return { principalId: row.principal_id, kind: 'new', state: row.reservation_state }
    }
    if (
      !validIdentity(row.parent_session_id) ||
      !Number.isSafeInteger(row.boundary_seq) ||
      (row.boundary_seq as number) < 1
    )
      throw unavailable()
    return {
      principalId: row.principal_id,
      kind: 'fork',
      state: row.reservation_state,
      parentSessionId: row.parent_session_id,
      boundarySeq: row.boundary_seq as number,
    }
  }
}

/** Embedded/local form with the same insert-only semantics. */
export class MemorySessionPrincipalOwnership implements SessionPrincipalOwnership {
  private readonly owners = new Map<string, Reservation>()

  bindNew(sessionId: string, principalId: string): boolean {
    if (!validIdentity(sessionId) || !validIdentity(principalId)) return false
    const current = this.owners.get(sessionId)
    if (current !== undefined) return current.principalId === principalId && current.kind === 'new'
    this.owners.set(sessionId, { principalId, kind: 'new', state: 'pending' })
    return true
  }

  ownsNewReservation(sessionId: string, principalId: string): boolean {
    if (!validIdentity(sessionId) || !validIdentity(principalId)) return false
    const current = this.owners.get(sessionId)
    return current?.principalId === principalId && current.kind === 'new'
  }

  activateNew(sessionId: string, principalId: string): boolean {
    return this.activate({ sessionId, principalId, kind: 'new' })
  }

  inherit(
    parentSessionId: string,
    childSessionId: string,
    principalId: string,
    boundarySeq: number,
  ): boolean {
    if (
      !validIdentity(parentSessionId) ||
      !validIdentity(childSessionId) ||
      !validIdentity(principalId) ||
      parentSessionId === childSessionId ||
      !Number.isSafeInteger(boundarySeq) ||
      boundarySeq < 1 ||
      this.owners.get(parentSessionId)?.principalId !== principalId ||
      this.owners.get(parentSessionId)?.state !== 'active'
    )
      return false
    const childOwner = this.owners.get(childSessionId)
    if (childOwner !== undefined)
      return (
        childOwner.principalId === principalId &&
        childOwner.kind === 'fork' &&
        childOwner.parentSessionId === parentSessionId &&
        childOwner.boundarySeq === boundarySeq
      )
    this.owners.set(childSessionId, {
      principalId,
      kind: 'fork',
      state: 'pending',
      parentSessionId,
      boundarySeq,
    })
    return true
  }

  activateFork(
    parentSessionId: string,
    childSessionId: string,
    principalId: string,
    boundarySeq: number,
  ): boolean {
    if (!validIdentity(parentSessionId) || !Number.isSafeInteger(boundarySeq) || boundarySeq < 1) return false
    return this.activate({
      sessionId: childSessionId,
      principalId,
      kind: 'fork',
      parentSessionId,
      boundarySeq,
    })
  }

  resolve(sessionId: string): ActiveSessionPrincipal | undefined {
    if (!validIdentity(sessionId)) return undefined
    const reservation = this.owners.get(sessionId)
    return reservation?.state === 'active'
      ? Object.freeze({ active: true, principalId: reservation.principalId })
      : undefined
  }

  activeSessionIds(principalId: string): readonly string[] {
    if (!validIdentity(principalId)) return []
    return Object.freeze(
      [...this.owners.entries()]
        .filter(
          ([, reservation]) => reservation.principalId === principalId && reservation.state === 'active',
        )
        .map(([sessionId]) => sessionId)
        .sort(),
    )
  }

  private activate(input: {
    sessionId: string
    principalId: string
    kind: ReservationKind
    parentSessionId?: string
    boundarySeq?: number
  }): boolean {
    if (!validIdentity(input.sessionId) || !validIdentity(input.principalId)) return false
    const current = this.owners.get(input.sessionId)
    if (
      !current ||
      current.principalId !== input.principalId ||
      current.kind !== input.kind ||
      current.parentSessionId !== input.parentSessionId ||
      current.boundarySeq !== input.boundarySeq
    )
      return false
    this.owners.set(input.sessionId, { ...current, state: 'active' })
    return true
  }
}
