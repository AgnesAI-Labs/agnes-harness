import { redact } from '@agnes/error-sanitization'
import { describe, expect, it, vi } from 'vitest'
import { REDACTED, redactDiagnostic, redactDiagnosticText } from '../src/diagnostics-redact.js'

// Wraps the real implementation by default (every existing test keeps exercising real redaction);
// only the fail-closed test below overrides it for a single call via mockImplementationOnce.
vi.mock('@agnes/error-sanitization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/error-sanitization')>()
  return { ...actual, redact: vi.fn(actual.redact) }
})

// Fake secrets are always built by concatenation (never a literal secret-shaped string in source),
// so this file itself stays clean of the repository's secrets guard.
const FAKE_SK = 'sk-' + 'a'.repeat(24)
const FAKE_SLACK = 'xox' + 'b-' + '1'.repeat(14)
const FAKE_GOOGLE = 'AI' + 'za' + 'Q'.repeat(30)
const FAKE_BEARER_TOKEN = 'x'.repeat(30)
const FAKE_API_KEY_VALUE = 'v'.repeat(10)
const FAKE_PASSWORD_VALUE = 'p'.repeat(8)
const FAKE_CLOUD_KEY = `agh_sk_${'abc_DEF-123'.repeat(3)}`
const FAKE_CLOUD_TICKET = `m0ck.${'t'.repeat(22)}.${'Ab_1-'.repeat(8)}xyz`
const REMOTE_ACCESS = '/_agnes/remote-access/'
const PEM_BODY = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----'

function joinedUrls(count: number, separator: string): string {
  return Array.from({ length: count }, (_, i) => `https://example.com/p/${i}`).join(separator)
}

describe('redactDiagnostic (structured)', () => {
  it('redacts a plain string value under a secret-shaped key', () => {
    expect(redactDiagnostic({ apiKey: 'plain' })).toEqual({ apiKey: REDACTED })
  })

  it('keeps a bare secret:// reference key untouched', () => {
    const input = { credentialRef: 'secret://p/x', AGH_CLOUD_KEY: 'secret://generic/cloud-key' }
    expect(redactDiagnostic(input)).toEqual(input)
  })

  it('does not let a secret:// prefix launder trailing prose containing a real secret', () => {
    const tok = 'x'.repeat(30)
    const result = redactDiagnostic({
      note: `secret://p/x resolved; Authorization: Bearer ${tok}`,
    }) as { note: string }
    expect(result.note).not.toContain(tok)
  })

  it('does not let a secret:// prefix launder an assignment appended after it', () => {
    const sk = 'sk-' + 'a'.repeat(24)
    const result = redactDiagnostic(['secret://openai/default = ' + sk]) as string[]
    expect(result[0]).not.toContain(sk)
  })

  it('does not let a secret:// prefix launder an api_key= value appended after it', () => {
    const value = 'v'.repeat(10)
    const result = redactDiagnostic({ text: `secret://p/x api_key=${value}` }) as { text: string }
    expect(result.text).not.toContain(value)
  })

  it('fully redacts a secret-keyed value that is not a bare reference, even if it starts with secret://', () => {
    const sk = 'sk-' + 'a'.repeat(24)
    const value = `secret://p/x ${sk}`
    expect(redactDiagnostic({ apiKey: value })).toEqual({ apiKey: REDACTED })
  })

  it('redacts a nested secret-shaped key inside a plain-named parent object', () => {
    expect(redactDiagnostic({ auth: { token: 'x' } })).toEqual({ auth: { token: REDACTED } })
  })

  it('leaves count- and reference-shaped keys that merely contain "token"/"key" untouched', () => {
    const input = { maxTokens: 5, sessionKey: 'k', inputTokens: 3 }
    expect(redactDiagnostic(input)).toEqual(input)
  })

  it('strips userinfo and query from a baseUrl value', () => {
    expect(redactDiagnostic({ baseUrl: 'https://u:p@h.example/v1?key=abc' })).toEqual({
      baseUrl: 'https://h.example/v1',
    })
  })

  it('strips the fragment from a baseUrl value', () => {
    expect(redactDiagnostic({ baseUrl: 'https://h.example/v1#frag' })).toEqual({
      baseUrl: 'https://h.example/v1',
    })
  })

  it('redacts a cloud Key field even when its value has no recognizable credential shape', () => {
    expect(
      redactDiagnostic({ env: { AGH_CLOUD_KEY: FAKE_API_KEY_VALUE, AGH_CLOUD_KEY_FILE: '/tmp/key' } }),
    ).toEqual({
      env: { AGH_CLOUD_KEY: REDACTED, AGH_CLOUD_KEY_FILE: '/tmp/key' },
    })
  })

  it.each(['AGH_CLOUD_KEY', 'AGH_API_KEY'])('masks scalar values under the exact %s field', (field) => {
    for (const value of [1234567, true, null]) {
      expect(redactDiagnostic({ [field]: value, firstToken: 12, AGH_CLOUD_KEY_FILE: '/tmp/key' })).toEqual({
        [field]: REDACTED,
        firstToken: 12,
        AGH_CLOUD_KEY_FILE: '/tmp/key',
      })
    }
    const reference = 'secret://generic/cloud-key'
    expect(redactDiagnostic({ [field]: reference })).toEqual({ [field]: reference })
  })

  it('redacts a ticket from a structured endpoint after stripping its query and fragment', () => {
    const endpoint = `https://h.example${REMOTE_ACCESS}${FAKE_CLOUD_TICKET}/_agnes/plugin-stream/open`
    expect(redactDiagnostic({ endpoint: `${endpoint}?view=debug#frag` })).toEqual({
      endpoint: `https://h.example${REMOTE_ACCESS}${REDACTED}/_agnes/plugin-stream/open`,
    })
  })

  it('redacts cloud credentials in property names without losing colliding entries', () => {
    const endpoint = (ticket: string) => `https://h.example${REMOTE_ACCESS}${ticket}/health`
    const maskedEndpoint = endpoint(REDACTED)
    const reference = 'secret://generic/cloud-key'
    const ordinaryUrl = 'https://h.example/health'
    const result = redactDiagnostic({
      [endpoint(FAKE_CLOUD_TICKET)]: 21,
      [endpoint(FAKE_CLOUD_TICKET.replace('m0ck', 'm0ck2'))]: 22,
      [maskedEndpoint]: 23,
      [`${maskedEndpoint} (2)`]: 24,
      [FAKE_CLOUD_KEY]: 25,
      [reference]: 26,
      [ordinaryUrl]: 27,
    })
    expect(result).toMatchObject({
      [maskedEndpoint]: 23,
      [`${maskedEndpoint} (2)`]: 24,
      [reference]: 26,
      [ordinaryUrl]: 27,
    })
    expect(
      Object.entries(result)
        .filter(([key]) => key.startsWith(maskedEndpoint))
        .map(([, value]) => value)
        .sort(),
    ).toEqual([21, 22, 23, 24])
    expect(result[REDACTED]).toBe(25)
    expect(Object.keys(result)).toHaveLength(7)
    expect(redactDiagnostic(result)).toEqual(result)
  })

  it('recurses through arrays and nested objects', () => {
    const input = { items: [{ apiKey: 'a' }, { nested: { password: 'b' } }, 'plain'] }
    expect(redactDiagnostic(input)).toEqual({
      items: [{ apiKey: REDACTED }, { nested: { password: REDACTED } }, 'plain'],
    })
  })

  it('does not throw on a circular reference and redacts the cyclic point', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    let result: unknown
    expect(() => {
      result = redactDiagnostic(cyclic)
    }).not.toThrow()
    expect((result as { self: unknown }).self).toBe(REDACTED)
    expect((result as { name: unknown }).name).toBe('root')
  })

  it('still redacts a sibling occurrence of a shared (non-cyclic) object reference', () => {
    const shared = { apiKey: 'shared-secret' }
    const input = { first: shared, second: shared }
    expect(redactDiagnostic(input)).toEqual({ first: { apiKey: REDACTED }, second: { apiKey: REDACTED } })
  })
})

describe('redactDiagnosticText (string patterns)', () => {
  it('redacts an Authorization Bearer token while keeping the prefix', () => {
    const text = `Authorization: Bearer ${FAKE_BEARER_TOKEN}`
    expect(redactDiagnosticText(text)).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  it('redacts an api_key=value assignment while keeping the key name', () => {
    const text = `api_key=${FAKE_API_KEY_VALUE}`
    expect(redactDiagnosticText(text)).toBe(`api_key=${REDACTED}`)
  })

  it('redacts a JSON "password": "value" pair while keeping the surrounding braces', () => {
    const text = `{"password":"${FAKE_PASSWORD_VALUE}"}`
    expect(redactDiagnosticText(text)).toBe(`{"password":"${REDACTED}"}`)
  })

  it('redacts a Slack token, a Google API key and an sk- token (base rule marker accepted)', () => {
    for (const secret of [FAKE_SLACK, FAKE_GOOGLE, FAKE_SK]) {
      expect(redactDiagnosticText(secret)).not.toContain(secret)
    }
  })

  it('redacts a standalone cloud Key in prose and retains the surrounding text', () => {
    expect(redactDiagnosticText(`got (${FAKE_CLOUD_KEY}), rejected`)).toBe(`got (${REDACTED}), rejected`)
  })

  it('redacts a standalone cloud Key and a rootless ticket path after JSON-escaped whitespace', () => {
    const path = REMOTE_ACCESS.slice(1)
    const line = (key: string, ticket: string) =>
      JSON.stringify({ message: `error:\n${key}\t${path}${ticket}/health` })
    expect(redactDiagnosticText(line(FAKE_CLOUD_KEY, FAKE_CLOUD_TICKET))).toBe(line(REDACTED, REDACTED))
  })

  it.each([
    ["export AGH_CLOUD_KEY='", "'"],
    ['{"AGH_CLOUD_KEY":"', '"}'],
    ["{'AGH_CLOUD_KEY': '", "', 'region': 'east'}"],
    ["{'AGH_CLOUD_KEY': \"", '"}'],
    ["'AGH_CLOUD_KEY': ", ''],
  ])('redacts cloud Key assignments after %j', (before, after) => {
    expect(redactDiagnosticText(`${before}${FAKE_API_KEY_VALUE}${after}`)).toBe(
      `${before}${REDACTED}${after}`,
    )
  })

  it('keeps the single-quoted dictionary intact when its cloud Key contains an escaped quote', () => {
    const assignment = (key: string) => `{'AGH_CLOUD_KEY': '${key}', 'region': 'east'}`
    expect(redactDiagnosticText(assignment(String.raw`value\'remainder`))).toBe(assignment(REDACTED))
  })

  it.each(['"AGH_CLOUD_KEY"', "'AGH_CLOUD_KEY'"])(
    'redacts a double-quoted value for %s inside a JSON log message',
    (field) => {
      const line = (key: string) =>
        JSON.stringify({ message: `{${field}: ${JSON.stringify(key)}, "region": "east"}` })
      const result = JSON.parse(redactDiagnosticText(line('value"with\\escapes')))
      expect(result.message.replaceAll(' ', '')).toBe(`{${field}:"${REDACTED}","region":"east"}`)
    },
  )

  it.each(['https://h.example/deployment', 'wss://h.example', '', '.'])(
    'redacts only the ticket segment for a connection path with prefix %j',
    (prefix) => {
      const endpoint = '/_agnes/remote-frontend/ws'
      const makeText = (ticket: string) => `GET (${prefix}${REMOTE_ACCESS}${ticket}${endpoint}), retrying`
      expect(redactDiagnosticText(makeText(FAKE_CLOUD_TICKET))).toBe(makeText(REDACTED))
    },
  )

  it('covers a rootless relative path and a ticket path with no endpoint', () => {
    const path = REMOTE_ACCESS.slice(1)
    expect(redactDiagnosticText(`GET ${path}${FAKE_CLOUD_TICKET}/health`)).toBe(
      `GET ${path}${REDACTED}/health`,
    )
    expect(redactDiagnosticText(`see ${REMOTE_ACCESS}${FAKE_CLOUD_TICKET}.`)).toBe(
      `see ${REMOTE_ACCESS}${REDACTED}.`,
    )
  })

  it.each(['\\/', '\\u002f'])('redacts tickets in JSON paths with %s separators', (separator) => {
    const endpoint = (ticket: string) => `https://h.example${REMOTE_ACCESS}${ticket}/health`
    const escaped = JSON.stringify({ endpoint: endpoint(FAKE_CLOUD_TICKET) }).replaceAll('/', separator)
    expect(JSON.parse(redactDiagnosticText(escaped))).toEqual({ endpoint: endpoint(REDACTED) })
    const nested = JSON.parse(redactDiagnosticText(JSON.stringify({ message: escaped })))
    expect(JSON.parse(nested.message)).toEqual({ endpoint: endpoint(REDACTED) })
  })

  it('preserves backslash separators when masking a normalized HTTP URL', () => {
    const endpoint = (ticket: string) =>
      `https://h.example${REMOTE_ACCESS.replaceAll('/', '\\')}${ticket}\\health`
    expect(new URL(endpoint(FAKE_CLOUD_TICKET)).pathname).toBe(`${REMOTE_ACCESS}${FAKE_CLOUD_TICKET}/health`)
    expect(redactDiagnosticText(endpoint(FAKE_CLOUD_TICKET))).toBe(endpoint(REDACTED))
  })

  it.each(['\\u002F', '\\u005c'])('preserves %s separators in JSON after a log prefix', (separator) => {
    const line = (ticket: string) =>
      `request failed: ${JSON.stringify({ endpoint: `https://h.example${REMOTE_ACCESS}${ticket}/health` }).replaceAll('/', separator)}`
    expect(redactDiagnosticText(line(FAKE_CLOUD_TICKET))).toBe(line(REDACTED))
  })

  it('redacts a deeply indented JSON field and keeps ordinary URLs and credential references', () => {
    const text = `{"AGH_CLOUD_KEY":\n${' '.repeat(24)}"${FAKE_API_KEY_VALUE}", "url":"https://h.example/health", "ref":"secret://generic/cloud-key"}`
    expect(JSON.parse(redactDiagnosticText(text))).toEqual({
      AGH_CLOUD_KEY: REDACTED,
      url: 'https://h.example/health',
      ref: 'secret://generic/cloud-key',
    })
  })

  it('keeps a quoted value with its preceding secret label in mixed logs', () => {
    const record = '{"message":"next record"}'
    const endpoint = (ticket: string) => JSON.stringify(`https://h.example${REMOTE_ACCESS}${ticket}/health`)
    const escaped = endpoint(FAKE_CLOUD_TICKET).replaceAll('/', '\\u002f')
    const text = `AGH_CLOUD_KEY:\n  "${FAKE_API_KEY_VALUE}"\nendpoint follows\n${escaped}\n${record}`
    expect(redactDiagnosticText(text)).toBe(
      `AGH_CLOUD_KEY:\n  "${REDACTED}"\nendpoint follows\n${endpoint(REDACTED)}\n${record}`,
    )
  })

  it('keeps exact JSON number text while masking secrets in the same record', () => {
    const nearMarker = '\u00000:0'
    const text =
      `{"AGH_CLOUD_KEY":"${FAKE_API_KEY_VALUE}","op":9007199254740993,"metrics":[1e400,-0,1.2300],` +
      `"label":${JSON.stringify(nearMarker)},${JSON.stringify(nearMarker)}:9007199254740993}`
    const result = redactDiagnosticText(text)
    expect(result).toBe(text.replace(FAKE_API_KEY_VALUE, REDACTED))
    expect(redactDiagnosticText(result)).toBe(result)
  })

  it('masks a JSON number in a Key field even when JSON is embedded in prose', () => {
    const payload = '{"AGH_CLOUD_KEY":91736120540719032764,"operationId":9007199254740993}'
    const expected = `{"AGH_CLOUD_KEY":"${REDACTED}","operationId":9007199254740993}`
    expect(redactDiagnosticText(payload)).toBe(expected)
    expect(redactDiagnosticText(`output: ${payload}`)).toBe(`output: ${expected}`)
    expect(redactDiagnosticText(`output: ${payload.replace('":', '":\n                        ')}`)).toBe(
      `output: ${expected.replace('":', '":\n                        ')}`,
    )
  })

  it('keeps nested log JSON valid while masking the ticket and query value', () => {
    const endpoint = (ticket: string, path: string) =>
      `https://h.example${REMOTE_ACCESS}${ticket}/api/artifacts?path=${path}`
    const line = JSON.stringify({ message: JSON.stringify({ url: endpoint(FAKE_CLOUD_TICKET, V) }) })
    const redacted = JSON.parse(redactDiagnosticText(line))
    expect(JSON.parse(redacted.message)).toEqual({ url: endpoint(REDACTED, REDACTED) })
  })

  it('keeps an own __proto__ JSON property as data and redacts its contents', () => {
    const text = `{"__proto__":{"AGH_CLOUD_KEY":"${FAKE_API_KEY_VALUE}"},"region":"east"}`
    const redacted = JSON.parse(redactDiagnosticText(text))
    expect(Object.hasOwn(redacted, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(redacted, '__proto__')?.value).toEqual({ AGH_CLOUD_KEY: REDACTED })
    expect(redacted.region).toBe('east')
  })

  it('masks the whole ticket before generic secret rules can replace part of it', () => {
    const ticket = `m0ck.${'t'.repeat(22)}.sk-${'z'.repeat(40)}`
    expect(redactDiagnosticText(`${REMOTE_ACCESS}${ticket}/health`)).toBe(
      `${REMOTE_ACCESS}${REDACTED}/health`,
    )
  })

  it('masks a percent-encoded copy of a valid ticket', () => {
    const encoded = FAKE_CLOUD_TICKET.replace('m', '%6D').replaceAll('.', '%2E')
    expect(redactDiagnosticText(`https://h.example${REMOTE_ACCESS}${encoded}/health`)).toBe(
      `https://h.example${REMOTE_ACCESS}${REDACTED}/health`,
    )
  })

  it('redacts an entire PEM private key block', () => {
    const result = redactDiagnosticText(PEM_BODY)
    expect(result).not.toContain('MIIabc')
    expect(result).toContain(REDACTED)
  })

  it('strips a URL fragment (the WS credential lives only in location.hash)', () => {
    const result = redactDiagnosticText('open http://127.0.0.1:4177/?s=1#abcDEF123')
    expect(result).not.toContain('abcDEF123')
    expect(result).toBe(`open http://127.0.0.1:4177/?s=${REDACTED}#${REDACTED}`)
  })

  it('strips a fragment from a URL embedded in a longer sentence', () => {
    const result = redactDiagnosticText('a https://h.example/x#frag b')
    expect(result).toContain(`https://h.example/x#${REDACTED}`)
    expect(result).not.toContain('frag')
  })

  it('over-redacts (accepted) when only the second of two comma-joined URLs has a fragment', () => {
    const result = redactDiagnosticText('https://a.example/p,https://b.example/q#secretfrag')
    expect(result).not.toContain('secretfrag')
    expect(result).toContain(`https://a.example/p,https://b.example/q#${REDACTED}`)
  })

  it('leaves a URL with no fragment unchanged', () => {
    for (const text of [
      'see https://plain.example/path for details',
      'https://plain.example/_agnes/cloud-connection/authorize',
      'https://plain.example/_agnes/remote-access/',
      'https://plain.example/reference/_agnes/remote-access/overview',
      '/_agnes/remote-access/overview.html',
      '/_agnes/remote-access/%ZZ-overview',
      `https://_agnes/remote-access/${FAKE_CLOUD_TICKET}`,
      `https://_agnes/remote-access/${FAKE_CLOUD_TICKET}`.replaceAll('/', '\\/'),
      `https://_agnes/remote-access/${FAKE_CLOUD_TICKET}`.replaceAll('/', '\\u002F'),
      `https://_agnes/remote-access/${FAKE_CLOUD_TICKET}`.replaceAll('/', '\\'),
      'C:\\support\\_agnes\\remote-access\\overview',
      `https://plain.example/_agnes/remote-access-guide/${FAKE_CLOUD_TICKET}`,
      `https://plain.example/ordinary/${FAKE_CLOUD_TICKET}`,
    ]) {
      expect(redactDiagnosticText(text)).toBe(text)
    }
  })

  it('redacts 5000 comma-joined URLs in under 200ms (linear URL-run scan, no backtracking)', () => {
    const text = joinedUrls(5000, ',')
    const start = performance.now()
    redactDiagnosticText(text)
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('redacts 5000 semicolon-joined URLs in under 200ms', () => {
    const text = joinedUrls(5000, ';')
    const start = performance.now()
    redactDiagnosticText(text)
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('redacts 5000 URLs with no separator in under 200ms', () => {
    const text = joinedUrls(5000, '')
    const start = performance.now()
    redactDiagnosticText(text)
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('fails closed: returns REDACTED instead of throwing when the underlying redact call throws', () => {
    vi.mocked(redact).mockImplementationOnce(() => {
      throw new Error('simulated engine-level failure')
    })
    expect(redactDiagnosticText('anything')).toBe(REDACTED)
  })

  it('redacts a very long whitespace-only string in under 500ms (bounded lookbehind quantifiers)', () => {
    const start = performance.now()
    redactDiagnosticText(' '.repeat(200_000))
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('redacts a long whitespace run before an assignment in under 500ms', () => {
    const text = `api_key${' '.repeat(100_000)}= v`
    const start = performance.now()
    redactDiagnosticText(text)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

// Final whole-branch review (I1): the secret spellings a coding session actually prints. One shared
// concatenated fake value, so a single `not.toContain(V)` proves the value side was redacted.
const V = 'Zq8' + 'xW3pL9vN2mK7'
const leaks = (texts: string[]) => texts.filter((text) => redactDiagnosticText(text).includes(V))

describe('redactDiagnosticText (common secret spellings)', () => {
  it('redacts env-style and camelCase names that carry a prefix before the secret word', () => {
    expect(
      leaks([`DB_PASSWORD=${V}`, `NPM_TOKEN=${V}`, `JWT_SECRET=${V}`, `export GITHUB_TOKEN=${V}`]),
    ).toEqual([])
    expect(leaks([`dbPassword: ${V}`, `--db-password=${V}`])).toEqual([])
    expect(redactDiagnosticText(`DB_PASSWORD=${V}`)).toBe(`DB_PASSWORD=${REDACTED}`)
  })

  it('redacts SECRET_KEY-family, pwd, passphrase and credentials names', () => {
    const texts = [
      `SECRET_KEY=${V}`,
      `AWS_SECRET_ACCESS_KEY=${V}`,
      `STRIPE_SECRET_KEY=sk_live_${V}`,
      `pwd=${V}`,
      `passphrase: ${V}`,
      `credentials=${V}`,
    ]
    expect(leaks(texts)).toEqual([])
  })

  it('redacts JSON pairs whose key carries a prefix or is camelCase', () => {
    expect(leaks([`"DB_PASSWORD": "${V}"`, `{"githubToken":"${V}"}`])).toEqual([])
    expect(redactDiagnosticText(`{"githubToken":"${V}"}`)).toBe(`{"githubToken":"${REDACTED}"}`)
  })

  it('redacts the userinfo password of any URL in free text, keeping scheme, user and host', () => {
    expect(redactDiagnosticText(`dial postgres://admin:${V}@db.internal:5432/app failed`)).toBe(
      `dial postgres://admin:${REDACTED}@db.internal:5432/app failed`,
    )
    expect(leaks([`https://user:${V}@host.example/x`, `redis://:${V}@cache:6379/0`])).toEqual([])
    const out = redactDiagnostic({ DATABASE_URL: `postgres://u:${V}@h/db` })
    expect(JSON.stringify(out)).not.toContain(V)
  })

  it('redacts Cookie headers, cookie pairs and *_KEY assignments', () => {
    const texts = [
      `Cookie: sid=${V}`,
      `Cookie: theme=dark; sid=${V}`,
      `Set-Cookie: session=${V}; HttpOnly`,
      `{"cookie":"sid=${V}"}`,
      `AGNES_KEY=${V}`,
      `export OPENAI-KEY: ${V}`,
    ]
    expect(leaks(texts)).toEqual([])
    expect(redactDiagnosticText(`Cookie: theme=dark; sid=${V}`)).toBe(`Cookie: ${REDACTED}`)
  })

  it('redacts every query value of an http(s) or ws(s) URL in free text, keeping parameter names', () => {
    const texts = [
      `GET https://h.example/download?ticket=${V}`,
      `https://h.example/cb?state=x&code=${V}`,
      `https://b.s3.example/k?X-Amz-Date=1&X-Amz-Signature=${V}`,
      `wss://h.example/ws?t=${V}`,
      `https://h.example/p?${V}`,
    ]
    expect(leaks(texts)).toEqual([])
    expect(redactDiagnosticText(`see https://h.example/cb?state=x&code=${V}#frag now`)).toBe(
      `see https://h.example/cb?state=${REDACTED}&code=${REDACTED}#${REDACTED} now`,
    )
  })

  it('leaves near-miss names untouched in text', () => {
    for (const text of [
      'maxTokens: 5',
      'inputTokens=3',
      'sessionKey: k',
      'hotkey: ctrl+k',
      'cookieConsent: true',
      'tokenizer: bpe',
      'secretName: foo',
      'passwordless: true',
      'passwordless=true',
      'https://example.com/a:b@c',
    ]) {
      expect(redactDiagnosticText(text)).toBe(text)
    }
  })

  it.each([
    ['200k underscores', '_'.repeat(200_000)],
    ['200k backslashes', '\\'.repeat(200_000)],
    ['unclosed JSON-looking lines separated by Unicode newlines', `{${'\u2028{'.repeat(30_000)}\n`],
    ['200k word characters', 'a'.repeat(200_000)],
    ['200k secret-name words', 'password'.repeat(25_000)],
    ['max-length prefixes before a name and colon', `${'x'.repeat(39)}_token: ,`.repeat(4_000)],
    ['one huge scheme://user:pass run', `https://${'a'.repeat(100_000)}:${'b'.repeat(100_000)}`],
    ['colon/at-heavy text', ':@'.repeat(100_000)],
    ['repeated scheme://u: with no @', 'ab://u:'.repeat(30_000)],
    ['repeated full userinfo URLs', 'http://u:p@h '.repeat(16_000)],
    ['max user and pass runs with no @', `ab://${'c'.repeat(128)}:${'x'.repeat(256)} `.repeat(500)],
    ['one URL with 50k query pairs', `https://h.example/p?${'a=b&'.repeat(50_000)}`],
    ['200k cookie-name words', 'cookie'.repeat(33_000)],
  ])('redacts %s in under 200ms (bounded lookbehind classes)', (_name, text) => {
    const start = performance.now()
    redactDiagnosticText(text)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('redactDiagnostic (common secret key names)', () => {
  it('redacts token-suffixed, bearer, proxy-authorization and credentials keys', () => {
    const input = {
      NPM_TOKEN: V,
      githubToken: V,
      AUTH_TOKEN: V,
      bearer: V,
      'Proxy-Authorization': `Basic ${V}`,
      credentials: { user: 'u', pass: V },
    }
    expect(redactDiagnostic(input)).toEqual({
      NPM_TOKEN: REDACTED,
      githubToken: REDACTED,
      AUTH_TOKEN: REDACTED,
      bearer: REDACTED,
      'Proxy-Authorization': REDACTED,
      credentials: REDACTED,
    })
  })

  it('keeps count-shaped and near-miss keys, and non-string values under a token-suffixed key', () => {
    const input = { maxTokens: 5, inputTokens: 3, sessionKey: 'k', tokenizer: 'bpe', firstToken: 12 }
    expect(redactDiagnostic(input)).toEqual(input)
  })
})
