import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ChannelTargetActionEvent,
  ChannelTargetMessageEvent,
  ManagedInputAdmission,
  ManagedInputReason,
  ManagedInputResult,
  ManagedSessionStartInput,
  ManagedSessions,
} from '../src/index.js'

type Branch<S extends ManagedInputResult['state']> = Extract<ManagedInputResult, { state: S }>

describe('owner input admission contract', () => {
  it('pins the four result shapes', () => {
    type Held = Branch<
      'queued' | 'enqueued' | 'retained' | 'needsOwner' | 'waitingQuestion' | 'recoveryUnknown'
    >
    expectTypeOf<Held['state']>().toEqualTypeOf<
      'queued' | 'enqueued' | 'retained' | 'needsOwner' | 'waitingQuestion' | 'recoveryUnknown'
    >()
    expectTypeOf<keyof Held>().toEqualTypeOf<'state' | 'inputId' | 'version' | 'reason' | 'reviewLocation'>()
    expectTypeOf<keyof Branch<'consumed'>>().toEqualTypeOf<
      'state' | 'inputId' | 'version' | 'reason' | 'reviewLocation' | 'turn' | 'seq'
    >()
    expectTypeOf<Branch<'consumed'>['turn']>().toEqualTypeOf<number>()
    expectTypeOf<Branch<'consumed'>['seq']>().toEqualTypeOf<number>()
    expectTypeOf<keyof Branch<'legacySend'>>().toEqualTypeOf<'state' | 'delivery'>()
    expectTypeOf<Branch<'legacySend'>['delivery']>().toEqualTypeOf<'consumed' | 'pending' | 'unknown'>()
    expectTypeOf<keyof Branch<'absent'>>().toEqualTypeOf<'state' | 'historyCoverage'>()
    expectTypeOf<Branch<'absent'>['historyCoverage']>().toEqualTypeOf<'complete' | 'partial'>()
    expectTypeOf<ManagedInputResult['state']>().toEqualTypeOf<
      | 'queued'
      | 'enqueued'
      | 'retained'
      | 'needsOwner'
      | 'waitingQuestion'
      | 'recoveryUnknown'
      | 'consumed'
      | 'legacySend'
      | 'absent'
    >()
  })

  it('names exactly eleven reasons', () => {
    const all: Record<ManagedInputReason, true> = {
      eligible: true,
      busy: true,
      questionOpen: true,
      legacySourceUnknown: true,
      recoveryUnverified: true,
      receiptUnknown: true,
      pairingChanged: true,
      grantRevoked: true,
      sessionArchived: true,
      ownerRetained: true,
      ownerDiscarded: true,
    }
    expect(Object.keys(all)).toHaveLength(11)
    expectTypeOf<ManagedInputReason>().toEqualTypeOf<keyof typeof all>()
  })

  it('pins the admission request and the two methods', () => {
    expectTypeOf<keyof ManagedInputAdmission>().toEqualTypeOf<'key' | 'target' | 'input'>()
    expectTypeOf<ManagedInputAdmission['target']>().toEqualTypeOf<{
      readonly taskId: string
      readonly taskGeneration: number
      readonly startKey: string
    }>()
    type Input = ManagedInputAdmission['input']
    expectTypeOf<Input['kind']>().toEqualTypeOf<
      'ownerMessage' | 'recoveryContinuation' | 'legacyOwnerMessage'
    >()
    expectTypeOf<Extract<Input, { kind: 'ownerMessage' }>>().toEqualTypeOf<{
      readonly kind: 'ownerMessage'
      readonly receiptId: string
    }>()
    expectTypeOf<Extract<Input, { kind: 'recoveryContinuation' }>>().toEqualTypeOf<{
      readonly kind: 'recoveryContinuation'
      readonly turnEndSeq: number
    }>()
    expectTypeOf<Extract<Input, { kind: 'legacyOwnerMessage' }>>().toEqualTypeOf<{
      readonly kind: 'legacyOwnerMessage'
      readonly text: string
      readonly originalInbox: string | null
    }>()
    expectTypeOf<ManagedSessions['admitInput']>().toEqualTypeOf<
      (sessionId: string, input: ManagedInputAdmission) => Promise<ManagedInputResult>
    >()
    expectTypeOf<ManagedSessions['inputResult']>().toEqualTypeOf<
      (sessionId: string, input: { key: string }) => Promise<ManagedInputResult>
    >()
  })

  it('keeps taskBinding and receiptId optional', () => {
    expectTypeOf<ManagedSessionStartInput['taskBinding']>().toEqualTypeOf<
      { readonly id: string; readonly generation: number } | undefined
    >()
    expectTypeOf<Pick<ManagedSessionStartInput, 'taskBinding'>>().toEqualTypeOf<{
      readonly taskBinding?: { readonly id: string; readonly generation: number }
    }>()
    expectTypeOf<ChannelTargetMessageEvent['receiptId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ChannelTargetActionEvent['receiptId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Pick<ChannelTargetMessageEvent, 'receiptId'>>().toEqualTypeOf<{
      readonly receiptId?: string
    }>()
  })
})
