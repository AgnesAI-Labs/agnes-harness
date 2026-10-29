import { LoopRegistry } from '@agnes/core-common/loop/registry'
import { defaultLoopFactory } from '@agnes/loop-default'
export function defaultLoops(): LoopRegistry {
  const loops = new LoopRegistry()
  loops.register('@agnes/loop-default', defaultLoopFactory)
  return loops
}
