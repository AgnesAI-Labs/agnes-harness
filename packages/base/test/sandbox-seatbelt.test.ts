import { expect, it } from 'vitest'
import { seatbeltDenyNetworkArgv } from '../src/sandbox-seatbelt.js'

it.each(['relative', '/bad\npath', '/bad\0path', '/bad\x7fpath'])(
  'refuses invalid path %j without echo',
  (path) => {
    expect(() => seatbeltDenyNetworkArgv(['true'], { allowPaths: [path], denyPaths: [] })).toThrow(
      /^invalid sandbox policy$/,
    )
  },
)
it('does not grant implicit temp/device writes and denies both reads and writes', () => {
  const args = seatbeltDenyNetworkArgv(['echo', 'a b'], { allowPaths: ['/w'], denyPaths: ['/w/secret'] })
  expect(args[0]).toBe('/usr/bin/sandbox-exec')
  expect(args.slice(-2)).toEqual(['echo', 'a b'])
  expect(args[2]).toContain('(deny file-read* file-write* (subpath "/w/secret"))')
  expect(args[2]).not.toContain('/private/tmp')
  expect(args[2]).not.toContain('/dev')
  expect(args[2]).toContain('(deny network*)')
})
