import type { LoopCheckpoint, LoopContext, LoopDriver, LoopFactory } from '@agnes/extension-api'
import { defaultLoopFactory } from '@agnes/loop-default'
import { expect, it } from 'vitest'
import { createReactLoop } from '../../../examples/loops/react-loop/index.mjs'
import { verifyLoopExecutionContract } from './author/loop-contract.js'

// Exercise legitimate class/prototype implementations as well as the default's object factory.
class ReactFactory implements LoopFactory {
  #factory = createReactLoop()
  get id() {
    return this.#factory.id
  }
  get version() {
    return this.#factory.version
  }
  get codec() {
    return this.#factory.codec
  }
  get capabilities() {
    return this.#factory.capabilities
  }
  async create(ctx: LoopContext) {
    return new Driver(await this.#factory.create(ctx))
  }
  async resume(ctx: LoopContext, saved: LoopCheckpoint) {
    return new Driver(await this.#factory.resume(ctx, saved))
  }
}
class Driver implements LoopDriver {
  constructor(private base: LoopDriver) {}
  step(stop: AbortSignal) {
    return this.base.step(stop)
  }
  checkpoint() {
    return this.base.checkpoint()
  }
  cancel() {
    return this.base.cancel()
  }
  dispose() {
    return this.base.dispose()
  }
}

const factories = [defaultLoopFactory, new ReactFactory()]
const core = [
  'cost-settlement',
  'missing-usage',
  'cancel',
  'approval-rejection',
  'unknown-outcome',
  'cold-restore',
  'stale-scope',
  'parallel-generations',
]
const sideCall = [
  'side-call',
  'side-call-deadline',
  'side-call-cancel',
  'side-call-revocation',
  'side-call-estimated-cost',
]

it.each(factories)(
  '$id passes the public execution contract',
  async (factory) => {
    const result = await verifyLoopExecutionContract(factory)
    // A loop that does not ask for the side-call cases is checked exactly as before.
    expect(result.checks).toEqual(core)
  },
  30_000,
)

it.each(factories)(
  '$id passes the side-call cases of the public execution contract',
  async (factory) => {
    const result = await verifyLoopExecutionContract(factory, { sideCall: true })
    expect(result.checks).toEqual([...core, ...sideCall])
  },
  30_000,
)
