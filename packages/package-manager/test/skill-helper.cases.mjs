import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { CREATOR_URL, createTools, skillHelper } from '../bundled-plugins/skill-helper/index.mjs'
import { checkedFiles, LIMITS } from '../bundled-plugins/skill-helper/src/content.mjs'
import { github, githubLocation } from '../bundled-plugins/skill-helper/src/github.mjs'
import { sourceKind } from '../bundled-plugins/skill-helper/src/sources.mjs'
import { archive, crc32 } from '../bundled-plugins/skill-helper/src/zip.mjs'

// Shared JavaScript cases exercise the shipped JavaScript payload; Vitest supplies the runner.
export function registerSkillHelperTests(test) {
  const doc = '---\nname: demo\ndescription: A test skill\n---\nFollow the user request.\n'
  const files = [{ path: 'SKILL.md', content: doc }]
  const sha = 'a'.repeat(40)
  function context(responses = {}) {
    const requests = [],
      writes = [],
      urls = []
    const ctx = {
      cwd: process.cwd(),
      session: { depth: 0 },
      signal: new AbortController().signal,
      fs: {
        async write(path, content) {
          writes.push({ path, content: Buffer.from(content) })
        },
        async read() {
          throw Error('Unexpected source read')
        },
        async stat() {
          throw Error('Unexpected stat')
        },
      },
      net: {
        async fetchPublic(url) {
          urls.push(url)
          assert.ok(Object.hasOwn(responses, url), `Unexpected URL ${url}`)
          const value = responses[url]
          return value?.body
            ? value
            : {
                statusCode: 200,
                body: { kind: 'text', content: typeof value === 'string' ? value : JSON.stringify(value) },
                truncation: { bytes: false, decoded: false },
              }
        },
      },
      skillInstall: {
        async request(input) {
          requests.push(input)
          return {
            proposalId: 'proposal',
            state: input.action === 'prepare' ? 'prepared' : input.action === 'status' ? 'ready' : 'running',
          }
        },
      },
    }
    return { ctx, requests, writes, urls }
  }
  async function run(name, args, ctx) {
    return createTools()
      .find((t) => t.name === `skill_helper_${name}`)
      .execute(args, ctx)
  }
  test('Chinese display name survives creation while unsafe directory names explain correction', async () => {
    const c = context()
    const files = [
      {
        path: 'SKILL.md',
        content:
          '---\nname: 需求整理助手\ndescription: 整理产品需求时使用\n---\n目标、使用场景、功能要求、验收标准、待确认问题。',
      },
    ]
    const invalid = await run('create', { name: '需求整理助手', files }, c.ctx)
    assert.equal(invalid.structured.code, 'SKILL_NAME_INVALID')
    assert.match(invalid.structured.nextAction, /合规 name/)
    assert.equal(invalid.structured.retryable, true)
    assert.equal(c.requests.length, 0)
    const valid = await run('create', { name: 'requirement-organizer', files }, c.ctx)
    assert.equal(valid.structured.state, 'prepared')
    assert.match(c.writes[0].content.toString(), /name: 需求整理助手/)
  })
  function zip(entries) {
    const locals = [],
      centrals = []
    let offset = 0
    for (const entry of entries) {
      const name = Buffer.from(entry.path),
        raw = Buffer.from(entry.content ?? doc),
        method = entry.method ?? 8
      const packed = method === 8 ? deflateRawSync(raw) : raw
      const crc = entry.crc ?? crc32(raw),
        size = entry.size ?? raw.length
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(method, 8)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(packed.length, 18)
      local.writeUInt32LE(size, 22)
      local.writeUInt16LE(name.length, 26)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(method, 10)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(packed.length, 20)
      central.writeUInt32LE(size, 24)
      central.writeUInt16LE(name.length, 28)
      central.writeUInt32LE(((entry.mode ?? 0x8000) * 65536) >>> 0, 38)
      central.writeUInt32LE(offset, 42)
      locals.push(local, name, packed)
      centrals.push(central, name)
      offset += 30 + name.length + packed.length
    }
    const central = Buffer.concat(centrals),
      end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(central.length, 12)
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, central, end])
  }

  test('ordinary AGH plugin registers four discoverable tools', () => {
    const registered = []
    skillHelper.apply({ extension: () => ({ registerTool: (t) => registered.push(t) }) })
    assert.equal(registered.length, 4)
    for (const t of registered) {
      assert.equal(t.meta.deferLoading, false)
      assert.equal(t.parameters[Symbol.for('TypeBox.Kind')], 'Object')
    }
  })
  test('missing controlled port, subagents and cancellation fail before side effects', async () => {
    for (const mode of ['missing', 'subagent', 'aborted']) {
      const x = context()
      if (mode === 'missing') delete x.ctx.skillInstall
      if (mode === 'subagent') x.ctx.session.depth = 1
      if (mode === 'aborted') x.ctx.signal = AbortSignal.abort()
      assert.equal((await run('import', { source: 'https://github.com/a/b' }, x.ctx)).isError, true)
      assert.equal(x.urls.length + x.writes.length + x.requests.length, 0)
    }
  })
  test('local source is sent directly to core approval without reading it', async () => {
    const x = context()
    const r = await run('import', { source: './demo', scope: 'user', enable: false }, x.ctx)
    assert.equal(r.structured.state, 'prepared')
    assert.equal(x.writes.length, 0)
    assert.equal(x.requests[0].action, 'prepare')
    assert.equal(x.requests[0].scope, 'user')
    assert.equal(x.requests[0].enable, false)
  })
  test('creation stages complete bytes and only prepares; lifecycle stays with core', async () => {
    const x = context()
    const r = await run('create', { name: 'demo', files }, x.ctx)
    assert.equal(r.structured.state, 'prepared')
    assert.equal(x.writes[0].content.toString(), doc)
    assert.ok(x.requests[0].sourceDirectory.includes('.skill-helper'))
    for (const action of ['commit', 'status', 'cancel'])
      await run('install', { action, proposalId: 'proposal' }, x.ctx)
    assert.deepEqual(
      x.requests.slice(1),
      ['commit', 'status', 'cancel'].map((action) => ({ action, proposalId: 'proposal' })),
    )
  })
  test('core rejection is not retried and internal exception details are not exposed', async () => {
    const x = context()
    let calls = 0
    x.ctx.skillInstall.request = async () => {
      calls++
      throw Object.assign(Error('secret transport detail'), { code: 'SKILL_APPROVAL_DENIED' })
    }
    const r = await run('import', { source: './demo' }, x.ctx)
    assert.equal(calls, 1)
    assert.equal(r.isError, true)
    assert.equal(r.structured.code, 'SKILL_APPROVAL_DENIED')
    assert.ok(!JSON.stringify(r).includes('secret'))
  })
  test('failed and interrupted core receipts are errors, never installation success', async () => {
    for (const state of ['failed', 'interrupted']) {
      const x = context()
      x.ctx.skillInstall.request = async () => ({
        state,
        proposalId: 'p',
        message: 'SKILL_INSTALL_INTERRUPTED',
      })
      const r = await run('install', { action: 'status', proposalId: 'p' }, x.ctx)
      assert.equal(r.isError, true)
      assert.equal(r.structured.state, state)
    }
  })
  test('serialized core error codes remain useful without exposing other messages', async () => {
    const x = context()
    x.ctx.skillInstall.request = async () => {
      throw Error('SKILL_INSTALL_REJECTED')
    }
    const r = await run('import', { source: './demo' }, x.ctx)
    assert.equal(r.structured.code, 'SKILL_INSTALL_REJECTED')
    assert.ok(r.structured.message.includes('未获批准'))
  })
  test('tools taking a directory name state the naming rule up front', () => {
    for (const name of ['skill_helper_import', 'skill_helper_create'])
      assert.match(createTools().find((t) => t.name === name).description, /weekly-report/)
  })
  test('non-ASCII directory name explains the rule and allows a renamed retry', async () => {
    const x = context()
    const r = await run('create', { name: '周报助手', files }, x.ctx)
    assert.equal(r.isError, true)
    assert.equal(r.structured.code, 'SKILL_NAME_INVALID')
    assert.match(r.structured.message, /英文字母/)
    assert.match(r.structured.message, /SKILL\.md/)
    assert.match(r.structured.nextAction, /重新调用/)
    assert.equal(x.writes.length + x.requests.length, 0)
    assert.equal((await run('create', { name: 'weekly-report', files }, x.ctx)).structured.state, 'prepared')
  })
  test('host rejection of a local directory name asks the user to rename it', async () => {
    const x = context()
    x.ctx.skillInstall.request = async () => {
      throw { code: 'SKILL_NAME_INVALID' }
    }
    const r = await run('import', { source: './周报助手' }, x.ctx)
    assert.equal(r.structured.code, 'SKILL_NAME_INVALID')
    assert.match(r.structured.nextAction, /改名/)
  })
  test('single Markdown import without name explains the directory name rule', async () => {
    const x = context({ 'https://example.com/skill': doc })
    const r = await run('import', { source: 'https://example.com/skill' }, x.ctx)
    assert.equal(r.structured.code, 'SKILL_NAME_REQUIRED')
    assert.match(r.structured.message, /英文字母/)
    assert.match(r.structured.nextAction, /重新调用/)
    assert.equal(x.writes.length + x.requests.length, 0)
  })
  test('invalid file names inside a Skill keep the stop instruction', async () => {
    const x = context()
    const r = await run(
      'create',
      { name: 'demo', files: [...files, { path: '说明.md', content: 'x' }] },
      x.ctx,
    )
    assert.equal(r.structured.code, 'INVALID_NAME')
    assert.match(r.structured.message, /英文字母/)
    assert.match(r.structured.nextAction, /停止/)
    assert.equal(x.writes.length + x.requests.length, 0)
  })
  for (const [label, bad] of [
    ['traversal', [...files, { path: '../outside', content: 'x' }]],
    ['absolute', [...files, { path: '/outside', content: 'x' }]],
    ['backslash', [...files, { path: 'a\\outside', content: 'x' }]],
    ['case collision', [...files, { path: 'skill.md', content: 'x' }]],
    ['device name', [...files, { path: 'NUL.txt', content: 'x' }]],
    ['directory conflict', [...files, { path: 'a', content: 'x' }, { path: 'a/b', content: 'x' }]],
    ['size', [...files, { path: 'a', content: 'x'.repeat(LIMITS.file + 1) }]],
    ['missing SKILL', [{ path: 'README.md', content: doc }]],
  ])
    test(`reject ${label} before any staging write`, async () => {
      const x = context()
      assert.equal((await run('create', { name: 'demo', files: bad }, x.ctx)).isError, true)
      assert.equal(x.writes.length + x.requests.length, 0)
    })
  test('empty ancillary files and binary assets retain bytes', () => {
    assert.equal(
      checkedFiles([
        ...files,
        { path: 'empty', content: '' },
        { path: 'asset', content: Buffer.from([255, 0]) },
      ])[2].content[0],
      255,
    )
  })
  test('HTTPS raw Markdown and inline JSON manifest import', async () => {
    for (const response of [doc, { version: 1, name: 'demo', files }]) {
      const x = context({ 'https://example.com/skill': response })
      assert.equal(
        (await run('import', { source: 'https://example.com/skill', name: 'demo' }, x.ctx)).structured.state,
        'prepared',
      )
      assert.equal(x.writes[0].content.toString(), doc)
    }
  })
  test('HTML, truncation, bad status, remote archive and insecure URL refuse cleanly', async () => {
    for (const overrides of [
      { body: { kind: 'html', content: doc } },
      { truncation: { bytes: true } },
      { statusCode: 403 },
    ]) {
      const x = context({
        'https://example.com/skill': {
          statusCode: 200,
          truncation: {},
          body: { kind: 'text', content: doc },
          ...overrides,
        },
      })
      assert.equal(
        (await run('import', { source: 'https://example.com/skill', name: 'demo' }, x.ctx)).isError,
        true,
      )
      assert.equal(x.requests.length + x.writes.length, 0)
    }
    const x = context()
    assert.equal(
      (await run('import', { source: 'https://example.com/a.zip' }, x.ctx)).structured.code,
      'DOWNLOAD_ARCHIVE_LOCALLY',
    )
    assert.throws(() => sourceKind('ftp://example.com/a'))
    assert.throws(() => githubLocation('https://user:pass@github.com/a/b'))
  })
  function githubContext(
    entries = [{ name: 'SKILL.md', path: 'SKILL.md', type: 'file', size: Buffer.byteLength(doc) }],
    data = {},
  ) {
    const api = 'https://api.github.com/repos/a/b'
    return context({
      [api]: { default_branch: 'main' },
      [`${api}/commits/main`]: { sha },
      [`${api}/contents/?ref=${sha}`]: entries,
      [`${api}/contents/SKILL.md?ref=${sha}`]: {
        path: 'SKILL.md',
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(doc).toString('base64'),
        ...data,
      },
    })
  }
  test('GitHub resolves branch once and downloads all content at immutable commit', async () => {
    const x = githubContext()
    const r = await run('import', { source: 'https://github.com/a/b' }, x.ctx)
    assert.equal(r.structured.sourceCommit, sha)
    assert.equal(r.structured.state, 'prepared')
    assert.ok(x.urls.filter((u) => u.includes('/contents/')).every((u) => u.endsWith(`ref=${sha}`)))
  })
  test('GitHub API rate limit falls back to a pinned public ZIP without shell or credentials', async () => {
    const api = 'https://api.github.com/repos/a/b'
    const archiveUrl = `https://codeload.github.com/a/b/zip/${sha}`
    const data = zip([{ path: `b-${sha}/SKILL.md` }])
    const x = context({
      [api]: {
        statusCode: 403,
        body: { kind: 'text', content: 'rate limit exceeded' },
        truncation: { bytes: false, decoded: false },
      },
      'https://github.com/a/b/commits.atom': `<feed><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id></entry></feed>`,
      [archiveUrl]: {
        statusCode: 200,
        body: { kind: 'zip', base64: data.toString('base64') },
        truncation: { bytes: false, decoded: false },
      },
    })
    const options = []
    const original = x.ctx.net.fetchPublic
    x.ctx.net.fetchPublic = (url, option) => {
      options.push(option)
      return original(url)
    }
    const imported = await run('import', { source: 'https://github.com/a/b' }, x.ctx)
    assert.equal(imported.structured.state, 'prepared')
    assert.equal(imported.structured.sourceCommit, sha)
    assert.equal(x.writes[0].content.toString(), doc)
    assert.deepEqual(options.at(-1), { responseType: 'zip' })
    assert.deepEqual(x.urls, [api, 'https://github.com/a/b/commits.atom', archiveUrl])
  })
  test('GitHub rate-limit fallback keeps nested Skill selection explicit', async () => {
    const api = 'https://api.github.com/repos/a/b'
    const data = zip([{ path: `b-${sha}/one/SKILL.md` }, { path: `b-${sha}/two/SKILL.md` }])
    const x = context({
      [`${api}/commits/${sha}`]: {
        statusCode: 429,
        body: { kind: 'text', content: 'rate limit' },
        truncation: { bytes: false, decoded: false },
      },
      [`https://codeload.github.com/a/b/zip/${sha}`]: {
        statusCode: 200,
        body: { kind: 'zip', base64: data.toString('base64') },
        truncation: { bytes: false, decoded: false },
      },
    })
    const selected = await run('import', { source: 'https://github.com/a/b', ref: sha }, x.ctx)
    assert.equal(selected.structured.state, 'selection_required')
    assert.deepEqual(
      selected.structured.candidates.map((item) => item.subdirectory),
      ['one', 'two'],
    )
    assert.equal(x.requests.length + x.writes.length, 0)
  })
  test('GitHub fallback refuses invalid feed and ZIP, and does not hide ordinary API errors', async () => {
    const api = 'https://api.github.com/repos/a/b'
    const rejected = (statusCode) => ({
      statusCode,
      body: { kind: 'text', content: 'unavailable' },
      truncation: { bytes: false, decoded: false },
    })
    const ordinary = context({ [api]: rejected(404) })
    assert.equal(
      (await run('import', { source: 'https://github.com/a/b' }, ordinary.ctx)).structured.code,
      'HTTP_404',
    )
    assert.deepEqual(ordinary.urls, [api])
    const invalid = context({
      [api]: rejected(403),
      'https://github.com/a/b/commits.atom': '<feed><entry><id>invalid</id></entry></feed>',
    })
    assert.equal(
      (await run('import', { source: 'https://github.com/a/b' }, invalid.ctx)).structured.code,
      'GITHUB_REF_UNAVAILABLE',
    )
    assert.equal(invalid.writes.length + invalid.requests.length, 0)
  })
  test('GitHub special entries and invalid base64 are rejected before writes', async () => {
    for (const x of [
      githubContext([{ name: 'link', path: 'link', type: 'symlink', size: 1 }]),
      githubContext(undefined, { content: '!!!' }),
    ]) {
      assert.equal((await run('import', { source: 'https://github.com/a/b' }, x.ctx)).isError, true)
      assert.equal(x.writes.length + x.requests.length, 0)
    }
  })
  test('GitHub nested skills require explicit selection and retain commit', async () => {
    const x = githubContext([{ name: 'one', path: 'one', type: 'dir' }])
    const oldFetch = x.ctx.net.fetchPublic
    x.ctx.net.fetchPublic = (url) =>
      url.includes('/contents/one?')
        ? Promise.resolve({
            statusCode: 200,
            truncation: {},
            body: {
              kind: 'text',
              content: JSON.stringify([
                { name: 'SKILL.md', path: 'one/SKILL.md', type: 'file', size: doc.length },
              ]),
            },
          })
        : oldFetch(url)
    const r = await github(x.ctx, { source: 'https://github.com/a/b' })
    assert.equal(r.state, 'selection_required')
    assert.equal(r.candidates[0].ref, sha)
    assert.equal(r.candidates[0].subdirectory, 'one')
  })
  test('ZIP stored and deflated imports unwrap single directory and preserve content', () => {
    for (const method of [0, 8])
      assert.equal(archive(zip([{ path: 'demo/SKILL.md', method }])).files[0].content.toString(), doc)
  })
  test('ZIP multiple skill selection does not combine unrelated skills', () => {
    const data = zip([{ path: 'one/SKILL.md' }, { path: 'two/SKILL.md' }])
    assert.equal(archive(data).state, 'selection_required')
    assert.equal(archive(data, { subdirectory: 'two' }).files.length, 1)
  })
  for (const [label, entries] of [
    ['traversal', [{ path: '../SKILL.md' }]],
    ['symlink', [{ path: 'SKILL.md', mode: 0xa000 }]],
    ['CRC mismatch', [{ path: 'SKILL.md', crc: 0 }]],
    ['declared bomb', [{ path: 'SKILL.md', size: LIMITS.file + 1 }]],
    ['hidden bomb', [{ path: 'SKILL.md', size: 1 }]],
    ['collision', [{ path: 'SKILL.md' }, { path: 'skill.md' }]],
    ['directory mode mismatch', [{ path: 'SKILL.md', mode: 0x4000 }]],
  ])
    test(`ZIP rejects ${label}`, () => assert.throws(() => archive(zip(entries))))
  test('ZIP without skill reports missing document', () =>
    assert.throws(() => archive(zip([{ path: 'README.md' }])), { code: 'SKILL_DOCUMENT_REQUIRED' }))
  test('truncated ZIP fails without writes; local ZIP adapter uses bytes', async () => {
    const bytes = zip([{ path: 'SKILL.md' }])
    assert.throws(() => archive(bytes.subarray(0, -1)))
    const x = context()
    x.ctx.fs.stat = async () => ({ kind: 'file', size: bytes.length })
    x.ctx.fs.read = async () => bytes
    assert.equal((await run('import', { source: './demo.zip' }, x.ctx)).structured.state, 'prepared')
  })
  test('creator retrieves pinned official guidance without installing or executing it', async () => {
    const x = context({ [CREATOR_URL]: '---\nname: skill-creator\n---\nGuidance' })
    const r = await run('creator', {}, x.ctx)
    assert.equal(r.structured.state, 'guidance')
    assert.equal(r.structured.source, CREATOR_URL)
    assert.equal(x.requests.length + x.writes.length, 0)
  })

  test('host failure stops local import without network, source reads or staging', async () => {
    const x = context()
    let calls = 0
    x.ctx.skillInstall.request = async () => {
      calls++
      throw { code: 'SKILL_INSTALL_PERMISSION_UNAVAILABLE', message: 'private token' }
    }
    const r = await run('import', { source: './demo' }, x.ctx)
    assert.equal(calls, 1)
    assert.equal(r.structured.retryable, false)
    assert.match(r.structured.message, /不是用户拒绝/)
    assert.match(r.structured.nextAction, /停止/)
    assert.deepEqual(x.urls, [])
    assert.deepEqual(x.writes, [])
    assert.ok(!JSON.stringify(r).includes('private token'))
  })

  test('cancelled receipts and unknown failures carry stop instructions', async () => {
    const x = context()
    x.ctx.skillInstall.request = async () => ({
      state: 'cancelled',
      proposalId: 'p',
      message: 'SKILL_INSTALL_CANCELLED',
    })
    const r = await run('install', { action: 'status', proposalId: 'p' }, x.ctx)
    assert.equal(r.isError, true)
    assert.equal(r.structured.retryable, false)
    assert.equal(r.structured.proposalId, 'p')
  })
}
