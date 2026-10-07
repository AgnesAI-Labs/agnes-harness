import { defaultLoopFactory } from '@agnes/loop-default'
import { LoopRegistry } from '../src/loop/registry.js'
export function defaultLoops(): LoopRegistry {
  const loops = new LoopRegistry()
  loops.register('@agnes/loop-default', defaultLoopFactory)
  return loops
}
