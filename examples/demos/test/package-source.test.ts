import { validatePackageAdminData } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'

const dialect = vi.hoisted(() => ({
  absolute: undefined as string | undefined,
  separator: undefined as string | undefined,
}))

vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>()
  return {
    ...actual,
    resolve: (...parts: string[]) => dialect.absolute ?? actual.resolve(...parts),
    get sep() {
      return dialect.separator ?? actual.sep
    },
  }
})

const runtimeUrl = new URL('../runtime.mjs', import.meta.url).href
const { install } = await import(runtimeUrl)
afterEach(() => {
  dialect.absolute = undefined
  dialect.separator = undefined
})

it.each([
  {
    platform: 'Windows',
    absolute: 'C:\\demo source\\中文 # literal%20',
    separator: '\\',
    ref: 'file:C:/demo source/中文 # literal%20',
  },
  {
    platform: 'POSIX',
    absolute: '/tmp/demo source/中文 # literal%20',
    separator: '/',
    ref: 'file:/tmp/demo source/中文 # literal%20',
  },
])('install emits a valid, literal file source for $platform paths', async (input) => {
  dialect.absolute = input.absolute
  dialect.separator = input.separator
  let source: unknown
  const inspected = new Error('inspection boundary reached')
  const client = {
    clientId: async () => 'demo-source-test',
    packages: {
      inspect: async (params: { source: unknown }) => {
        source = params.source
        throw inspected
      },
    },
  }
  await expect(install({ client }, 'source')).rejects.toBe(inspected)
  expect(validatePackageAdminData('PackageSource', source).ok).toBe(true)
  expect(source).toEqual({ type: 'file', ref: input.ref })
})
