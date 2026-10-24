// A minimal language server for tests. It speaks Content-Length framing on stdio and reports one
// error per line of an opened/changed document that contains the word BAD. Flags change behaviour:
//   --delay=<ms>      publish that long after the change
//   --stale           first publish a wrong-version diagnostic, then the right one
//   --no-init         never answer initialize
//   --exit-on-start   exit before answering anything
//   --crash-after-init  exit right after answering initialize
//   --pull            advertise diagnosticProvider and answer textDocument/diagnostic instead of pushing
const flags = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const delay = Number(flags.get('delay') ?? 0)
if (flags.has('exit-on-start')) process.exit(3)

let buf = Buffer.alloc(0)
const docs = new Map()
let initOptions
const send = (message) => {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const diagnose = (text) =>
  flags.has('echo-init')
    ? [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: JSON.stringify(initOptions ?? null),
        },
      ]
    : text.split('\n').flatMap((line, i) =>
        line.includes('BAD')
          ? [
              {
                range: {
                  start: { line: i, character: line.indexOf('BAD') },
                  end: { line: i, character: line.indexOf('BAD') + 3 },
                },
                severity: 1,
                message: `bad word on line ${i + 1}`,
                source: 'fake',
                code: 'F1',
              },
            ]
          : [],
      )
const publish = (uri, version, text) => {
  const send_ = (v, diagnostics) =>
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, version: v, diagnostics },
    })
  setTimeout(() => {
    if (flags.has('stale'))
      send_(version - 1, [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          message: 'stale',
          source: 'fake',
        },
      ])
    send_(version, diagnose(text))
  }, delay)
}

function handle(message) {
  if (message.method === 'initialize') {
    initOptions = message.params.initializationOptions
    if (flags.has('no-init')) return
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { capabilities: flags.has('pull') ? { diagnosticProvider: {} } : {} },
    })
    if (flags.has('crash-after-init')) setTimeout(() => process.exit(4), 20)
  } else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null })
  else if (message.method === 'exit') process.exit(0)
  else if (message.method === 'textDocument/didOpen') {
    const { uri, version, text } = message.params.textDocument
    docs.set(uri, text)
    if (!flags.has('pull')) publish(uri, version, text)
  } else if (message.method === 'textDocument/didChange') {
    const { uri, version } = message.params.textDocument
    const text = message.params.contentChanges[0].text
    docs.set(uri, text)
    if (!flags.has('pull')) publish(uri, version, text)
  } else if (message.method === 'textDocument/diagnostic') {
    setTimeout(
      () =>
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { kind: 'full', items: diagnose(docs.get(message.params.textDocument.uri) ?? '') },
        }),
      delay,
    )
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const end = buf.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1])
    if (buf.length < end + 4 + length) return
    const body = buf.subarray(end + 4, end + 4 + length).toString('utf8')
    buf = buf.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
