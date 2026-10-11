import { CoreError, type Event } from '@agnes/core-common/types'
import type { PersistenceDerivedRegisterWrite } from '@agnes/extension-api'
import { jcs } from '@agnes/protocol'
import { type DecisionState, reduceDecision } from '../reduce/decision.js'
import type { CommitTx, RegisterRow } from './storage.js'

export function expectedRegisterChecks(tx: Pick<CommitTx,'expectedRegisterSeq'|'expectedRegisters'>): {register:string;key:string;seq:number|null}[] {
  const checks=[...(tx.expectedRegisterSeq ? [tx.expectedRegisterSeq] : []),...(tx.expectedRegisters ?? [])]
  const keys=new Set<string>()
  for (const check of checks) {
    const key=jcs([check.register,check.key])
    if (keys.has(key)) throw new CoreError('E_CAS','duplicate expected register')
    keys.add(key)
    if (!check.register || !check.key || (check.seq !== null && (!Number.isSafeInteger(check.seq)||check.seq<1)))
      throw new CoreError('E_CAS','invalid expected register')
  }
  return checks
}
/** Adapters derive state from canonical rows inside their transaction; caller writes are only assertions. */
export function decisionRegisterWrites(events: readonly Event[], rows: readonly RegisterRow[], supplied?: readonly PersistenceDerivedRegisterWrite[]): RegisterRow[] {
  const states=new Map(rows.filter(r=>r.register==='decision/state').map(r=>[r.key,r.data as DecisionState]))
  const touched=new Set<string>()
  for (const event of events) {
    if (event.type === 'session/start' && (event.data as {parent?:unknown}).parent) states.clear()
    if (['decision/requested','decision/resolved','decision/invalidated','decision/consumed'].includes(event.type)) {
      const id=(event.data as {decisionId:string}).decisionId
      states.set(id,reduceDecision(states.get(id),event));touched.add(id)
      if (event.type==='decision/consumed') {
        const data=event.data as {disposition:string;effectId:string|null;operationId:string}
        if (data.disposition==='execute' && !events.some(e=>e.type==='effect/intent' && (e.data as {effectId:string}).effectId===data.effectId))
          throw new CoreError('E_RELATION','decision consumption requires same-batch effect intent')
        if (data.disposition!=='execute' && !events.some(e=>e.type==='x/core/loop-checkpoint'))
          throw new CoreError('E_RELATION','decision consumption requires same-batch checkpoint')
      }
    }
    if (event.type==='x/core/decision-outbox-receipt') throw new CoreError('E_UNSUPPORTED','DECISION_CONTINUATION_BLOCKED: outbox is unavailable')
    if (event.register?.startsWith('decision/')) throw new CoreError('E_RELATION','decision registers are derived, never event payloads')
  }
  const writes=[...touched].map(key=>({register:'decision/state',key,seq:events.at(-1)?.seq ?? 0,data:states.get(key)!}))
  if (supplied !== undefined) {
    if (supplied.length!==writes.length || new Set(supplied.map(r=>jcs([r.register,r.key]))).size!==supplied.length || supplied.some(r=>!writes.some(w=>w.register===r.register&&w.key===r.key&&jcs(w.data)===jcs(r.data))))
      throw new CoreError('E_RELATION','derived registers differ from canonical decision fold')
  }
  return writes
}
