import { test } from 'node:test'

// The built-in runner works before dependency installation and executes this in a child process.
test('report the test-runner child runtime', () => {
  console.log(
    `AGH_TOOLCHAIN_RUNTIME ${JSON.stringify({ version: process.version, execPath: process.execPath })}`,
  )
})
