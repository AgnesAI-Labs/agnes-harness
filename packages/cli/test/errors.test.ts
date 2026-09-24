import { STOP_REASON_TABLE, type TurnEndReason } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BootError,
  CommandError,
  ExitCode,
  exitCodeForReason,
  REASON_EXIT_CODES,
  UsageError,
} from '../src/errors.js'

// Every expected number is written out here as a literal, independently of the table under test.
// A test that re-derived them from REASON_EXIT_CODES would agree with any implementation.
const EXPECTED: ReadonlyArray<readonly [TurnEndReason, number]> = [
  ['completed', 0],
  ['error', 1],
  ['parked', 3],
  ['budget', 4],
  ['blocked', 4],
  ['max_steps', 5],
  ['aborted', 130],
  ['interrupted', 1],
]

// The live set of reasons the protocol admits, read at runtime rather than copied. STOP_REASON_TABLE
// covers every reason but 'error' (which has no ACP stop reason), and protocol's own codec test pins
// its key set against schema/session-v1.json.
const protocolReasons = (): Set<string> => new Set([...Object.keys(STOP_REASON_TABLE), 'error'])

describe('exit codes', () => {
  it.each(EXPECTED)('%s maps to %d', (reason, code) => {
    expect(exitCodeForReason(reason)).toBe(code)
  })

  it('the closed set is exactly these nine numbers under these nine names', () => {
    expect(ExitCode).toEqual({
      OK: 0,
      ERROR: 1,
      USAGE: 2,
      PARKED: 3,
      BUDGET: 4,
      MAX_STEPS: 5,
      SIGINT: 130,
      SIGTERM: 143,
      SIGHUP: 129,
    })
  })

  it('every mapped code is a member of the closed set', () => {
    const closed = new Set<number>(Object.values(ExitCode))
    for (const [reason] of EXPECTED) expect(closed.has(exitCodeForReason(reason)), reason).toBe(true)
  })

  it('the mapping is total over the reasons the protocol admits, with nothing extra', () => {
    expect(new Set(Object.keys(REASON_EXIT_CODES))).toEqual(protocolReasons())
  })

  it('a reason outside the table fails closed to ERROR rather than to undefined', () => {
    expect(exitCodeForReason('not_a_reason' as TurnEndReason)).toBe(ExitCode.ERROR)
    expect(exitCodeForReason('toString' as TurnEndReason)).toBe(ExitCode.ERROR)
  })

  it('UsageError and BootError both carry the usage code, and BootError keeps its cause', () => {
    expect(new UsageError('bad flag').code).toBe(2)
    expect(new UsageError('bad flag')).toBeInstanceOf(Error)
    const inner = new Error('x')
    const boot = new BootError('no host', inner)
    expect(boot.code).toBe(2)
    expect(boot.cause).toBe(inner)
    expect(boot.name).toBe('BootError')
  })

  it('CommandError carries the generic ERROR code, not the usage code', () => {
    const command = new CommandError('one or more pin releases failed')
    expect(command.code).toBe(ExitCode.ERROR)
    expect(command).toBeInstanceOf(Error)
    expect(command.name).toBe('CommandError')
  })
})

// The totality check above compares against a table imported from protocol. If protocol grew a
// reason and that comparison did not notice, the check would be decoration. Proven by adding a
// reason to the live table at runtime and requiring the comparison to reject, then removing it and
// requiring it to accept -- the same treatment daemon gave the method table.
describe('the totality check reacts to the live protocol table', () => {
  const table = STOP_REASON_TABLE as unknown as Record<string, string>
  afterEach(() => {
    delete table.invented_reason
  })

  it('rejects while an extra reason is present and accepts once it is gone', () => {
    const keys = new Set(Object.keys(REASON_EXIT_CODES))
    table.invented_reason = 'end_turn'
    expect(protocolReasons().has('invented_reason')).toBe(true)
    expect(keys).not.toEqual(protocolReasons())
    delete table.invented_reason
    expect(keys).toEqual(protocolReasons())
  })
})
