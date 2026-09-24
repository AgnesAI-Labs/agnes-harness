import { redact } from '@agnes/base/privacy'
import { describe, expect, it, vi } from 'vitest'
import { REDACTED, redactDiagnostic, redactDiagnosticText } from '../src/diagnostics-redact.js'

// Wraps the real implementation by default (every existing test keeps exercising real redaction);
// only the fail-closed test below overrides it for a single call via mockImplementationOnce.
vi.mock('@agnes/base/privacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/base/privacy')>()
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
const PEM_BODY = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----'

function joinedUrls(count: number, separator: string): string {
  return Array.from({ length: count }, (_, i) => `https://example.com/p/${i}`).join(separator)
}

describe('redactDiagnostic (structured)', () => {
  it('redacts a plain string value under a secret-shaped key', () => {
    expect(redactDiagnostic({ apiKey: 'plain' })).toEqual({ apiKey: REDACTED })
  })

  it('keeps a bare secret:// reference key untouched', () => {
    expect(redactDiagnostic({ credentialRef: 'secret://p/x' })).toEqual({ credentialRef: 'secret://p/x' })
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

  it('redacts an entire PEM private key block', () => {
    const result = redactDiagnosticText(PEM_BODY)
    expect(result).not.toContain('MIIabc')
    expect(result).toContain(REDACTED)
  })

  it('strips a URL fragment (the WS credential lives only in location.hash)', () => {
    const result = redactDiagnosticText('open http://127.0.0.1:4177/?s=1#abcDEF123')
    expect(result).not.toContain('abcDEF123')
    expect(result).toContain('http://127.0.0.1:4177/?s=1#')
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
    const text = 'see https://plain.example/path for details'
    expect(redactDiagnosticText(text)).toBe(text)
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

  it('leaves near-miss names untouched in text', () => {
    for (const text of [
      'maxTokens: 5',
      'inputTokens=3',
      'sessionKey: k',
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
    ['200k word characters', 'a'.repeat(200_000)],
    ['200k secret-name words', 'password'.repeat(25_000)],
    ['max-length prefixes before a name and colon', `${'x'.repeat(39)}_token: ,`.repeat(4_000)],
    ['one huge scheme://user:pass run', `https://${'a'.repeat(100_000)}:${'b'.repeat(100_000)}`],
    ['colon/at-heavy text', ':@'.repeat(100_000)],
    ['repeated scheme://u: with no @', 'ab://u:'.repeat(30_000)],
    ['repeated full userinfo URLs', 'http://u:p@h '.repeat(16_000)],
    ['max user and pass runs with no @', `ab://${'c'.repeat(128)}:${'x'.repeat(256)} `.repeat(500)],
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
