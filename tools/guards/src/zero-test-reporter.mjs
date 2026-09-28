export default class ZeroTestReporter {
  queuedModules = new Map()
  collectedModules = new Set()
  emptyModules = new Set()

  onTestModuleQueued(testModule) {
    this.queuedModules.set(testModule.moduleId, testModule)
  }

  onTestModuleCollected(testModule) {
    this.collectedModules.add(testModule.moduleId)
    if ([...testModule.children.allTests()].length === 0) this.emptyModules.add(testModule.moduleId)
  }

  onTestRunEnd() {
    const empty = [...this.queuedModules.keys()].filter(
      (moduleId) => !this.collectedModules.has(moduleId) || this.emptyModules.has(moduleId),
    )
    if (empty.length === 0) return

    process.exitCode = 1
    console.error(`Test files collected no test cases:\n${empty.join('\n')}`)
  }
}
