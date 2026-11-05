import { join } from 'node:path'
import { expect, it } from 'vitest'
import { marketEndpoint } from './helpers/market-endpoint.js'

it('passes the owned Windows pipe identity and never treats the pipe namespace as a directory', () => {
  expect(
    marketEndpoint({ socketPath: '\\\\.\\pipe\\agnes-test', pid: 17, processStartId: 'start-17' }),
  ).toEqual({
    transport: {
      kind: 'unix',
      path: '\\\\.\\pipe\\agnes-test',
      serverIdentity: { pid: 17, processStartId: 'start-17' },
    },
    socketDirectory: undefined,
  })
})

it('retains the source daemon Unix socket directory for isolated-home cleanup', () => {
  const directory = join('owned-home', 'daemon')
  expect(
    marketEndpoint({ socketPath: join(directory, 'agnesd.sock'), pid: 18, processStartId: 'start-18' }),
  ).toEqual({
    transport: { kind: 'unix', path: join(directory, 'agnesd.sock') },
    socketDirectory: directory,
  })
})
