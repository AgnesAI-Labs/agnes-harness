import { expect, it } from 'vitest'
import { seatbeltDenyNetworkArgv } from '../src/sandbox-seatbelt.js'

// The trust agent serves a login session; a LaunchDaemon's commands ask the system trust daemon instead.
const TRUST_LOOKUP =
  '(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd"))'

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
    // Only an open network reaches a Mach service: the certificate trust services, nothing else.
    if ('network' in network) expect(args[2]).toContain(TRUST_LOOKUP)
    else expect(args[2]).not.toContain('mach-lookup')
  },
)

it('adds only the trust service lookup to an open network and keeps every other rule of the profile', () => {
  const policy = { allowPaths: ['/w'], denyPaths: ['/w/secret'], readPaths: ['/w'] }
  const lines = (network: object) =>
    (seatbeltDenyNetworkArgv(['true'], { ...policy, ...network })[2] ?? '').split('\n')
  const shared = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/zero"))',
    '(allow file-read* (literal "/dev/random"))',
    '(allow file-read* (literal "/dev/urandom"))',
    '(allow file-ioctl (require-all (regex #"^/dev/tty(s[0-9]+)?$") (ioctl-command TIOCSPGRP)))',
    '(allow file-read-metadata (literal "/"))',
    '(allow file-read* (literal "/"))',
    '(allow file-read* (subpath "/w"))',
    '(allow file-write* (subpath "/w"))',
    '(deny file-read* file-write* (subpath "/w/secret"))',
    '(deny file-write-unlink (literal "/"))',
    '(deny file-write-unlink (literal "/w"))',
    '(deny file-write* (regex #"^/private/tmp/agh-loopback-[^/]*(/|$)"))',
    '(deny file-write-unlink (literal "/") (literal "/private") (literal "/private/tmp"))',
  ]
  expect(lines({ network: 'allow' })).toEqual([...shared, '(allow network*)', TRUST_LOOKUP])
  expect(lines({})).toEqual([...shared, '(deny network*)'])
  expect(lines({ network: 'deny' })).toEqual([...shared, '(deny network*)'])
  expect(lines({ loopbackServe: true })).toEqual([
    ...shared,
    '(allow network-inbound (local tcp "localhost:*"))',
    '(allow network-inbound (local unix-socket))',
    '(deny network-bind)',
  ])
})

it('omits only the terminal job-control grant when asked, and keeps every other rule', () => {
  const policy = { allowPaths: ['/w'], denyPaths: ['/w/secret'] }
  const full = seatbeltDenyNetworkArgv(['true'], policy)[2] ?? ''
  const compat = seatbeltDenyNetworkArgv(['true'], { ...policy, jobControl: false })[2] ?? ''
  expect(full).toContain('(ioctl-command TIOCSPGRP)')
  expect(compat).not.toContain('TIOCSPGRP')
  expect(compat.split('\n')).toEqual(full.split('\n').filter((line) => !line.includes('TIOCSPGRP')))
})
