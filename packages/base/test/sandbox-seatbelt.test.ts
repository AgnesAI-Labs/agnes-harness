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
it.each([{}, { network: 'allow' as const }, { loopbackServe: true }])(
  'preserves reserved paths, explicit denies and workspace writes with network policy %j',
  (network) => {
    const args = seatbeltDenyNetworkArgv(['echo', 'a b'], {
      ...network,
      allowPaths: ['/w'],
      denyPaths: ['/w/secret', '/dev/null'],
      readPaths: ['/w'],
    })
    expect(args[0]).toBe('/usr/bin/sandbox-exec')
    expect(args.slice(-2)).toEqual(['echo', 'a b'])
    expect(args[2]).toContain('(deny file-read* file-write* (subpath "/w/secret"))')
    expect(args[2]).not.toContain('(allow file-write* (subpath "/private/tmp"))')
    expect(args[2]).toContain('(deny file-write* (regex #"^/private/tmp/agh-loopback-[^/]*(/|$)"))')
    expect(args[2]).toContain(
      '(deny file-write-unlink (literal "/") (literal "/private") (literal "/private/tmp"))',
    )
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
    if ('network' in network) expect(args[2]).toContain('(allow network*)')
    else if ('loopbackServe' in network) expect(args[2]).toContain('(deny network-bind)')
    else expect(args[2]).toContain('(deny network*)')
  },
)

it('omits only the terminal job-control grant when asked, and keeps every other rule', () => {
  const policy = { allowPaths: ['/w'], denyPaths: ['/w/secret'] }
  const full = seatbeltDenyNetworkArgv(['true'], policy)[2] ?? ''
  const compat = seatbeltDenyNetworkArgv(['true'], { ...policy, jobControl: false })[2] ?? ''
  expect(full).toContain('(ioctl-command TIOCSPGRP)')
  expect(compat).not.toContain('TIOCSPGRP')
  expect(compat.split('\n')).toEqual(full.split('\n').filter((line) => !line.includes('TIOCSPGRP')))
})
