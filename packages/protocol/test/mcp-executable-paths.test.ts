import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { validateResourceControlData } from '../src/index.js'

const require = createRequire(import.meta.url)
const Ajv = require('ajv/dist/2020') as typeof Ajv2020
const ajv = new Ajv({ strict: false })
const schema = JSON.parse(readFileSync(new URL('../schema/resource-control.json', import.meta.url), 'utf8'))
ajv.addSchema(schema)
const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/McpStdioTransport` })

describe('MCP executable paths preserve the protocol boundary', () => {
  const accepted = [
    'node',
    '/usr/bin/node',
    '/opt/My Tools/node',
    String.raw`C:\Program Files\nodejs\node.exe`,
    'C:/中文 Tools/node.exe',
    String.raw`\\server\Shared Tools\node.exe`,
    `C:/${'a'.repeat(509)}`,
  ]
  const rejected = [
    '',
    'node --version',
    `C:/${'a'.repeat(510)}`,
    ...['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].flatMap((name) => [
      name,
      name.toUpperCase(),
      `/bin/${name}`,
      `C:/Program Files/${name.toUpperCase()}.EXE`,
      `C:\\Tools\\${name}.exe`,
    ]),
    ...[0, 7, 9, 10, 13, 31, 127].flatMap((code) => [
      `node${String.fromCharCode(code)}`,
      `C:/My Tools/node${String.fromCharCode(code)}.exe`,
    ]),
  ]
  for (const [expected, values] of [
    [true, accepted],
    [false, rejected],
  ] as const) {
    it.each(values)(`${expected ? 'accepts' : 'rejects'} %j in both validators`, (executable) => {
      const transport = { kind: 'stdio', executable, args: [] }
      expect(validate(transport)).toBe(expected)
      expect(validateResourceControlData('McpStdioTransport', transport).ok).toBe(expected)
    })
  }
})
