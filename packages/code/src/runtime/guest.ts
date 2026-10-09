/** Executed only in the provider-owned child. No host closure or credentials cross this boundary. */
export const NODE_GUEST = String.raw`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const request = JSON.parse(input);
  const pipe = new (require('node:net').Socket)({fd: 3, readable: true, writable: true});
  let serial = 0, buffer = '';
  const pending = new Map();
  pipe.setEncoding('utf8');
  pipe.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1048576) process.exit(1);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const held = pending.get(reply.id); if (!held) continue;
      pending.delete(reply.id);
      reply.error ? held.reject(Object.assign(new Error(reply.error.message), {code: reply.error.code})) : held.resolve(reply.result);
    }
  });
  function json(value) {
    return JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' ||
          typeof item === 'number' && !Number.isFinite(item)) throw new Error('Bridge values must be lossless JSON');
      return item;
    });
  }
  function call(name, args) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const encoded = json({jsonrpc: '2.0', id, method: 'bridge.tools.invoke', params: {name, args}}) + '\n';
      if (Buffer.byteLength(encoded) > 1048576) return reject(new Error('bridge frame too large'));
      pending.set(id, {resolve, reject}); pipe.write(encoded);
    });
  }
  const tools = Object.create(null);
  for (const name of request.names) tools[name] = (args = {}) => call(name, args);
  try {
    const source = require('node:module').stripTypeScriptTypes('async function cell(tools) {\n' + request.program + '\n}', {mode: 'strip', disableExperimentalWarning: true});
    const fn = new Function(source + ';return cell')();
    const value = await fn(tools);
    if (value !== undefined) console.log(json(value));
    if (pending.size) throw new Error('All tool calls must be awaited');
  } catch (error) {
    console.error(error.stack ?? String(error)); process.exitCode = 1;
  } finally { pipe.destroy(); }
});
`

/** Experimental stateless CPython, with top-level await and return inside an async cell. */
export const PYTHON_GUEST = String.raw`
import asyncio, json, socket, sys, traceback
from types import SimpleNamespace
request = json.loads(sys.stdin.read())
async def main():
    reader, writer = await asyncio.open_connection(sock=socket.socket(fileno=3))
    pending, serial = {}, 0
    async def receive():
        while True:
            line = await reader.readline()
            if not line: break
            reply = json.loads(line)
            future = pending.pop(reply['id'], None)
            if future is not None:
                if 'error' in reply: future.set_exception(RuntimeError(reply['error']['message']))
                else: future.set_result(reply.get('result'))
    receiver = asyncio.create_task(receive())
    async def call(name, args):
        nonlocal serial
        serial += 1
        future = asyncio.get_running_loop().create_future()
        pending[serial] = future
        frame = json.dumps({'jsonrpc': '2.0', 'id': serial, 'method': 'bridge.tools.invoke', 'params': {'name': name, 'args': args}}, allow_nan=False).encode() + b'\n'
        if len(frame) > 1048576: raise RuntimeError('bridge frame too large')
        writer.write(frame)
        await writer.drain()
        return await future
    def binding(name):
        async def invoke(args=None, **kwargs): return await call(name, args if args is not None else kwargs)
        return invoke
    tools = SimpleNamespace(**{name: binding(name) for name in request['names']})
    scope = {'tools': tools, 'asyncio': asyncio}
    exec('async def cell():\n' + '\n'.join('    ' + line for line in request['program'].splitlines()), scope)
    try:
        value = await scope['cell']()
        if value is not None: print(json.dumps(value, allow_nan=False))
        if pending: raise RuntimeError('All tool calls must be awaited')
    finally:
        receiver.cancel()
        writer.close()
        await writer.wait_closed()
try: asyncio.run(main())
except BaseException:
    traceback.print_exc()
    sys.exit(1)
`
