import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConfig, DEFAULT_LIMITS, parseArgs } from '../src/config.js'

describe('agnesd config', () => {
  it('parses argv and subcommands', () => {
    expect(parseArgs(['--profile', 'enterprise', '--workspace', '/d/x', '--ws', '0.0.0.0:8443'])).toEqual({
      profile: 'enterprise',
      workspace: '/d/x',
      ws: '0.0.0.0:8443',
    })
    expect(parseArgs(['stop', '--profile', 'local-dev'])).toEqual({ profile: 'local-dev', command: 'stop' })
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/)
    expect(() => parseArgs([])).toThrow(/--profile/)
  })
  it('derives paths and merges profile limits over defaults', () => {
    const profile = {
      name: 'local-dev',
      hash: 'h',
      presets: { default: 'standard', allowed: ['standard'] },
      limits: { 'worker.idle_evict_ms': 1000 },
      transports: [],
    }
    const c = buildConfig({
      args: parseArgs(['--profile', 'local-dev']),
      profile: profile as never,
      home: '/home/u/.agh',
      ipc: 'unix',
    })
    expect(c.socketPath).toBe(join('/home/u/.agh', 'daemon', 'agnesd.sock'))
    expect(c.workersSocketPath).toBe(join('/home/u/.agh', 'daemon', 'workers.sock'))
    expect(c.limits).toEqual({ ...DEFAULT_LIMITS, workerIdleEvictMs: 1000 })
    const w = buildConfig({
      args: parseArgs(['--profile', 'local-dev']),
      profile: profile as never,
      home: 'C:\\u\\.agh',
      ipc: 'pipe',
    })
    expect(w.socketPath.startsWith('\\\\.\\pipe\\agnes-')).toBe(true)
  })
  it('surfaces a ws-tls transport, letting --ws override the configured listen address', () => {
    const profile = {
      name: 'enterprise',
      hash: 'h',
      presets: { default: 'standard', allowed: ['standard'] },
      limits: {},
      transports: [
        {
          kind: 'ws-tls',
          listen: '127.0.0.1:9443',
          tls: { cert: 'secret://tls/cert', key: 'secret://tls/key' },
        },
      ],
    }
    const c = buildConfig({
      args: parseArgs(['--profile', 'enterprise']),
      profile: profile as never,
      home: '/home/u/.agh',
      ipc: 'unix',
    })
    expect(c.ws).toEqual({ addr: '127.0.0.1:9443', cert: 'secret://tls/cert', key: 'secret://tls/key' })
    const overridden = buildConfig({
      args: parseArgs(['--profile', 'enterprise', '--ws', '0.0.0.0:8443']),
      profile: profile as never,
      home: '/home/u/.agh',
      ipc: 'unix',
    })
    expect(overridden.ws).toEqual({
      addr: '0.0.0.0:8443',
      cert: 'secret://tls/cert',
      key: 'secret://tls/key',
    })
    const loopback = buildConfig({
      args: parseArgs(['--profile', 'enterprise']),
      profile: { ...profile, transports: [{ ...profile.transports[0], listen: undefined }] } as never,
      home: '/tmp/fixture-home',
      ipc: 'unix',
    })
    expect(loopback.ws?.addr).toBe('127.0.0.1:0')
  })
  it('rejects a missing --profile with a clear error and accepts a well-formed one', () => {
    expect(() => parseArgs(['--socket', '/tmp/x.sock'])).toThrow(/--profile/)
    expect(parseArgs(['--profile', 'local-dev'])).toEqual({ profile: 'local-dev' })
  })
})

describe('shared worker limits', () => {
  it('leaves the shared worker session idle limit to the worker', () => {
    const c = buildConfig({
      args: parseArgs(['--profile', 'local-dev']),
      profile: {
        name: 'local-dev',
        hash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        limits: { 'worker.session_idle_close_ms': 5_000 },
        transports: [],
      } as never,
      home: '/srv/agh',
      ipc: 'unix',
    })
    expect(c.limits).toEqual(DEFAULT_LIMITS)
  })
})
