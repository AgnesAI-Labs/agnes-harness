import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES, type RedactRules, redact, redactText } from '../src/redact.js'

// Keep synthetic credentials and user paths out of the repository's literal scanner while still
// exercising the exact runtime shapes the redactor must catch.
const posixHome = ['/', 'home', '/', 'alice'].join('')
const macHome = ['/', 'Users', '/', 'alice'].join('')
const workspaceRoot = `${posixHome}/proj`
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const githubToken = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('')

const rules: RedactRules = {
  ...DEFAULT_RULES,
  paths: { home: posixHome, workspaceRoot, username: 'alice' },
}

describe('redactText', () => {
  it('masks every built-in secret family and counts repeated hits', () => {
    const result = redactText(
      [
        `aws ${awsKey}`,
        `github ${githubToken}`,
        'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
        'keys sk-abcdefghijklmnop and sk-qrstuvwxyzABCDEF',
      ].join(' '),
      rules,
    )

    expect(result.text).toBe(
      'aws [REDACTED:aws] github [REDACTED:github] jwt [REDACTED:jwt] keys [REDACTED:sk] and [REDACTED:sk]',
    )
    expect(result.hits).toEqual({ aws: 1, github: 1, jwt: 1, sk: 2 })
  })

  it('preserves secret references and masks only assigned values', () => {
    const result = redactText(
      'secret://plain is a reference; secret://shell = hunter2; "secret://json": "value with spaces"',
      rules,
    )
    expect(result.text).toBe(
      'secret://plain is a reference; secret://shell = [REDACTED:secret]; "secret://json": "[REDACTED:secret]"',
    )
    expect(result.hits).toEqual({ secret: 2 })
  })

  it('normalizes the most specific paths first and masks PII', () => {
    const result = redactText(
      `see ${workspaceRoot}/src/a.ts, ${posixHome}/.ssh, ${macHome}/x; mail a.b@example.com phone 13812345678 id 11010119900101123X`,
      rules,
    )
    expect(result.text).toBe(
      'see <workspace>/src/a.ts, ~/.ssh, ~/x; mail [REDACTED:email] phone [REDACTED:phone] id [REDACTED:id]',
    )
    expect(result.hits).toMatchObject({ email: 1, phone: 1, id: 1 })
  })

  it('does not normalize a path whose username merely shares a prefix', () => {
    const lookalikes = `${posixHome}2/file ${macHome}2/file`
    expect(redactText(lookalikes, rules).text).toBe(lookalikes)
  })

  it('honours disabled groups and applies custom rules last', () => {
    const custom: RedactRules = {
      secrets: false,
      paths: false,
      pii: false,
      custom: [{ pattern: 'acme-\\d+', flags: 'gi', replace: '[ACME]' }],
    }
    const result = redactText(`sk-abcdefghijklmnop ${posixHome} a@b.com ACME-12 acme-13`, custom)
    expect(result.text).toBe(`sk-abcdefghijklmnop ${posixHome} a@b.com [ACME] [ACME]`)
    expect(result.hits).toEqual({ 'custom:acme-\\d+': 2 })
  })
})

describe('redact', () => {
  it.each([
    ['C:\\Users\\Alice\\项目 [a]', 'c:/users/ALICE/项目 [a]'],
    ['C:/Users/Alice/project/', 'C:\\Users\\Alice\\project'],
    ['\\\\server\\share\\work', '\\\\SERVER\\share\\work'],
  ])('redacts raw and JSON-escaped Windows paths for %s without corrupting JSON', (root, spelling) => {
    const windowsRules = { ...rules, paths: { workspaceRoot: root } }
    const input = { path: `${spelling}\\secret.txt`, exact: spelling }
    const serialized = JSON.stringify(input)
    const output = redactText(serialized, windowsRules)
    expect(JSON.parse(output.text)).toEqual({ path: '<workspace>\\secret.txt', exact: '<workspace>' })
    expect(output.hits['path:workspace']).toBe(2)
    expect(redact(input, windowsRules)).toEqual({ path: '<workspace>\\secret.txt', exact: '<workspace>' })
    expect(redactText(`${spelling}/file`, windowsRules).text).toBe('<workspace>/file')
    const lookalike = `${spelling}-other/file`
    expect(redactText(lookalike, windowsRules).text).toBe(lookalike)
    expect(JSON.parse(redactText(JSON.stringify({ path: lookalike }), windowsRules).text)).toEqual({
      path: lookalike,
    })
  })

  it('keeps POSIX path case sensitivity while handling Windows home prefixes', () => {
    expect(redactText('/Home/Alice/x', { ...rules, paths: { home: '/home/alice' } }).text).toBe(
      '/Home/Alice/x',
    )
    expect(redactText('"c:\\USERS\\alice"', { ...rules, paths: { home: 'C:\\Users\\Alice\\' } }).text).toBe(
      '"~"',
    )
  })
  it('recurses through JSON values without changing keys or the input', () => {
    const input = {
      'a.b@example.com': ['token: ACME-12345', 1, true, null],
      nested: { value: `${workspaceRoot}/private.txt` },
    }
    const output = redact(input, {
      ...rules,
      custom: [{ pattern: 'ACME-\\d+', replace: '[ACME]' }],
    })

    expect(output).toEqual({
      'a.b@example.com': ['token: [ACME]', 1, true, null],
      nested: { value: '<workspace>/private.txt' },
    })
    expect(input.nested.value).toBe(`${workspaceRoot}/private.txt`)
  })
})
