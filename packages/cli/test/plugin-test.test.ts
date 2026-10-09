import { expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { commandHelp } from '../src/command-help.js'
import { pluginTestEnvironment, pluginTestInvocation } from '../src/commands/plugin-test.js'

it('forwards author runner args and resolves the plugin directory without backend flags', () => {
  const parsed = parseArgs(['plugin', 'test', 'example', '--', '--test-name-pattern', 'approval'])
  expect(parsed.command).toBe('plugin')
  expect(pluginTestInvocation(parsed.rest, '/workspace')).toEqual({
    directory: '/workspace/example',
    runnerArgs: ['--test-name-pattern', 'approval'],
  })
  expect(pluginTestInvocation(['test'], '/workspace').directory).toBe('/workspace')
  expect(() => pluginTestInvocation(['test', 'a', 'b'], '/workspace')).toThrow('usage')
  expect(() => pluginTestInvocation(['test', '--connect'], '/workspace')).toThrow('usage')
  expect(commandHelp('plugin')).toContain('agh plugin test')
})

it('isolates author HOME and strips model keys and Node injection options', () => {
  expect(
    pluginTestEnvironment(
      {
        PATH: '/bin',
        HOME: '/real-home',
        AGH_HOME: '/real-home/.agh',
        OPENAI_API_KEY: 'synthetic-private-value',
        NODE_OPTIONS: '--require unsafe.js',
        npm_config_registry: 'https://private.invalid',
      },
      '/test-home',
    ),
  ).toMatchObject({
    PATH: '/bin',
    HOME: '/test-home',
    USERPROFILE: '/test-home',
    AGH_HOME: '/test-home/.agh',
    npm_config_offline: 'true',
  })
  expect(
    JSON.stringify(pluginTestEnvironment({ API_KEY: 'synthetic-private-value' }, '/test-home')),
  ).not.toContain('synthetic-private-value')
})
