import { closeSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

export class BillingConflict extends Error {}
export class BillingRefusal extends Error {}
export function openSettlementOutbox(path: string, authorityId: string) {
  if (!existsSync(dirname(path))) createPrivateDirectorySync(dirname(path))
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const db = new DatabaseSync(path)
  db.exec(
    'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,owner TEXT,stable TEXT UNIQUE,fingerprint TEXT,body TEXT,callback TEXT);',
  )
  db.exec('CREATE TABLE IF NOT EXISTS usage_origins(origin TEXT PRIMARY KEY,entry TEXT NOT NULL);')
  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  function row(id: string, owner: string) {
    const r = db.prepare('SELECT * FROM entries WHERE id=? AND owner=?').get(id, owner)
    if (!r) throw new BillingRefusal('entry absent')
    return r
  }
  function value(body: unknown): W.BillingEntry {
    const checked = validateRuntime('BillingEntry', JSON.parse(String(body)))
    if (!checked.ok) throw new BillingRefusal('corrupt entry')
    return checked.value
  }
  return {
    replay(owner: string, account: W.DomainObjectRef, key: string, fingerprint: string) {
      const stable = canonicalJsonDigest({
        owner,
        authorityId,
        account: { authorityId: account.authorityId, id: account.id },
        key,
      })
      const old = db.prepare('SELECT * FROM entries WHERE stable=?').get(stable)
      if (!old) return undefined
      if (old.fingerprint !== fingerprint) throw new BillingConflict('key input changed')
      return value(old.body)
    },
    prepare(
      owner: string,
      key: string,
      fingerprint: string,
      entry: W.BillingEntry,
      origins: readonly string[] = [],
    ) {
      return tx(() => {
        const stable = canonicalJsonDigest({
          owner,
          authorityId,
          account: { authorityId: entry.accountRef.authorityId, id: entry.accountRef.id },
          key,
        })
        const old = db.prepare('SELECT * FROM entries WHERE stable=?').get(stable)
        if (old) {
          if (old.fingerprint !== fingerprint) throw new BillingConflict('key input changed')
          return { created: false, entry: value(old.body) }
        }
        if (entry.kind === 'charge') {
          if (!origins.length) throw new BillingRefusal('original usage identities absent')
          const legacy = db
            .prepare(
              "SELECT e.id FROM entries e WHERE json_extract(e.body,'$.kind')='charge' AND json_extract(e.body,'$.status')!='rejected' AND NOT EXISTS (SELECT 1 FROM usage_origins o WHERE o.entry=e.id)",
            )
            .get()
          if (legacy) throw new BillingRefusal('original usage identities require migration')
          for (const origin of origins) {
            const old = db
              .prepare('SELECT e.body FROM usage_origins o JOIN entries e ON e.id=o.entry WHERE o.origin=?')
              .get(origin)
            if (old && value(old.body).status !== 'rejected')
              throw new BillingConflict('origin already charged')
          }
          const prior = db
            .prepare('SELECT body FROM entries WHERE owner=?')
            .all(owner)
            .map((r) => value(r.body))
            .filter((e) => e.kind === 'charge' && e.status !== 'rejected')
          if (
            prior.some((e) =>
              e.usageRefs.some((old) =>
                entry.usageRefs.some(
                  (next) => old.authorityId === next.authorityId && old.usageId === next.usageId,
                ),
              ),
            )
          )
            throw new BillingConflict('usage already charged')
        }
        if (entry.kind === 'refund') {
          const charge = value(row(entry.reversesEntryId ?? '', owner).body)
          if (
            charge.kind !== 'charge' ||
            charge.status !== 'posted' ||
            charge.amount.currency !== entry.amount.currency ||
            charge.amount.scale !== entry.amount.scale
          )
            throw new BillingRefusal('refund currency or status')
          const refunds = db
            .prepare('SELECT body FROM entries WHERE owner=?')
            .all(owner)
            .map((r) => value(r.body))
            .filter((r) => r.reversesEntryId === charge.entryId && r.status !== 'rejected')
          if (
            refunds.reduce((n, r) => n + BigInt(r.amount.units), 0n) + BigInt(entry.amount.units) >
            BigInt(charge.amount.units)
          )
            throw new BillingRefusal('refund balance')
        }
        db.prepare('INSERT INTO entries VALUES (?,?,?,?,?,NULL)').run(
          entry.entryId,
          owner,
          stable,
          fingerprint,
          JSON.stringify(entry),
        )
        for (const origin of origins)
          db.prepare(
            'INSERT INTO usage_origins VALUES (?,?) ON CONFLICT(origin) DO UPDATE SET entry=excluded.entry',
          ).run(origin, entry.entryId)
        return { created: true, entry }
      })
    },
    inspect(ref: W.DomainObjectRef, owner: string) {
      if (ref.authorityId !== authorityId || ref.typeId !== 'agh.billing/entry@1' || ref.revision !== 1)
        throw new BillingRefusal('entry reference')
      return value(row(ref.id, owner).body)
    },
    uncertain(id: string, owner: string) {
      tx(() => {
        const e = value(row(id, owner).body)
        if (e.status === 'pending') {
          e.status = 'unknown'
          db.prepare('UPDATE entries SET body=? WHERE id=?').run(JSON.stringify(e), id)
        }
      })
    },
    accept(id: string, owner: string, external: W.BillingEntry, receipt: W.DataRef) {
      return tx(() => {
        const current = row(id, owner),
          entry = value(current.body)
        const immutable = (e: W.BillingEntry) => ({ ...e, status: 'pending', paymentReceipt: null })
        if (
          canonicalJsonDigest(immutable(entry)) !== canonicalJsonDigest(immutable(external)) ||
          !['posted', 'rejected'].includes(external.status)
        )
          throw new BillingConflict('receipt input mismatch')
        const fingerprint = canonicalJsonDigest(external)
        if (current.callback !== null) {
          if (current.callback !== fingerprint) throw new BillingConflict('callback conflict')
          return entry
        }
        entry.status = external.status
        entry.paymentReceipt = receipt
        db.prepare('UPDATE entries SET body=?,callback=? WHERE id=?').run(
          JSON.stringify(entry),
          fingerprint,
          id,
        )
        return entry
      })
    },
    pending(): string[] {
      return db
        .prepare('SELECT id FROM entries WHERE callback IS NULL')
        .all()
        .map((r) => String(r.id))
    },
    close() {
      db.close()
    },
  }
}
