// Child process for the registry tests: appends `count` revocations to one workspace's registry, retrying
// each one on a revision conflict, and prints how many it was told were saved.
const [module, dataDir, root, tag, count] = process.argv.slice(2)
const { RefinementRegistry } = await import(module)
const registry = new RefinementRegistry(dataDir, root, Date.now)
let saved = 0
for (let i = 0; i < Number(count); i++) {
  for (;;) {
    const snapshot = registry.read()
    try {
      registry.update((draft) => {
        draft.revocations.push({
          sessionKey: tag,
          kind: 'memory',
          entryId: `e${i}`,
          contentHash: `h-${tag}-${i}`,
          action: 'memory-deleted',
          at: i,
        })
      }, snapshot.revision)
      saved++
      break
    } catch (error) {
      if (error?.code !== 'REGISTRY_REVISION_CONFLICT') throw error
    }
  }
}
process.stdout.write(String(saved))
