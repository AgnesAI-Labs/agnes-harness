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
it('grants only standard device literals and preserves explicit denies and workspace writes', () => {
  const args = seatbeltDenyNetworkArgv(['echo', 'a b'], {
    allowPaths: ['/w'],
    denyPaths: ['/w/secret', '/dev/null'],
    readPaths: ['/w'],
  })
  expect(args[0]).toBe('/usr/bin/sandbox-exec')
  expect(args.slice(-2)).toEqual(['echo', 'a b'])
  expect(args[2]).toContain('(deny file-read* file-write* (subpath "/w/secret"))')
  expect(args[2]).not.toContain('/private/tmp')
  expect(args[2]).toContain('(ioctl-command TIOCSPGRP)')
  expect(args[2]).toContain('(allow file-read* file-write* (literal "/dev/null"))')
  for (const device of ['zero', 'random', 'urandom']) {
    expect(args[2]).toContain(`(allow file-read* (literal "/dev/${device}"))`)
  }
  const deviceGrants = args[2]
    ?.split('\n')
    .filter((line) => line.startsWith('(allow file-') && line.includes('/dev/'))
  expect(deviceGrants).toHaveLength(5) // Four exact device grants and the existing TTY ioctl.
  expect(deviceGrants?.join('\n')).not.toMatch(/\(subpath "\/dev(?:\/|"|\))/)
  expect(args[2]).not.toContain('(allow file-read*)')
  expect(args[2]).toContain('(allow file-write* (subpath "/w"))')
  expect(args[2]).toContain('(deny file-read* file-write* (subpath "/dev/null"))')
  expect(args[2]).toContain('(deny network*)')
})
