import { defineExtension, defineTool, type ToolContext } from '@agnes/extension-api'
import { AGH_DIR } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { creatorAssets } from './generated/assets.js'
import { scriptedToolTest } from './scripted-test.js'

const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  requiresApproval: 'always' as const,
  costHint: undefined,
  deferLoading: undefined,
}
async function run(ctx: ToolContext, argv: string[], cwd = ctx.cwd) {
  ctx.signal.throwIfAborted()
  const result = await ctx.exec(argv, { cwd, timeoutMs: ctx.timeoutMs })
  ctx.signal.throwIfAborted()
  return {
    content: [
      { type: 'text' as const, text: [result.stdout, result.stderr, `exit ${result.code}`].join('\n') },
    ],
    ...(result.code !== 0 || result.timedOut ? { isError: true } : {}),
  }
}
// Each mutation runs through the normal ToolContext exec port and tool approval classifier.
// Arguments are passed as argv, never interpolated into a shell command.
const prepare = `
const fs = require("node:fs"), path = require("node:path");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const { join, resolve } = path;
const root = "/__agnes_templates__";
const templateNames = ${JSON.stringify(creatorAssets.templateNames)};
const files = ${JSON.stringify(creatorAssets.files)};
async function readFile(file) { return files[file.slice(root.length + 1).split(path.sep).join("/")]; }
async function readdir(dir) {
  const prefix = dir.slice(root.length + 1).split(path.sep).join("/") + "/";
  const entries = new Map();
  for (const name of Object.keys(files)) if (name.startsWith(prefix)) {
    const rest = name.slice(prefix.length), leaf = rest.split("/")[0], directory = rest.includes("/");
    entries.set(leaf, { name: leaf, isDirectory: () => directory, isFile: () => !directory });
  }
  return [...entries.values()];
}
${creatorAssets.scaffoldSource}
const dir = await scaffold(process.argv[2], process.argv[3], process.argv[4], { local: true });
const file = path.join(dir, "package.json"), pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.exports = "./src/index.ts";
pkg.agnes.capabilities = { ...(process.argv[2] === "tool-with-panel" ? { ui: true } : {}), ...(process.argv[2] === "loop" ? { model: true } : {}) };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\\n");
for (const name of fs.readdirSync(path.join(dir, "test"))) {
  const test = path.join(dir, "test", name);
  fs.writeFileSync(test, fs.readFileSync(test, "utf8").replaceAll("../dist/index.js", "../src/index.ts"));
}
if (["tool", "tool-with-panel"].includes(process.argv[2])) {
  fs.writeFileSync(path.join(dir, "test", "scripted.test.mjs"), ${JSON.stringify(scriptedToolTest)});
}
console.log(dir);
`
const install = `
const fs = require("node:fs"), path = require("node:path");
const source = path.resolve(process.argv[1]), name = process.argv[2];
const target = path.join(process.cwd(), ${JSON.stringify(AGH_DIR)}, "plugins", name);
if (fs.existsSync(target)) throw new Error("Local plugin exists; edit it or choose another name");
const exclude = new Set(["node_modules", ".git", "dist"]);
function copy(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isDirectory()) { fs.mkdirSync(to); for (const name of fs.readdirSync(from)) {
    if (!exclude.has(name)) copy(path.join(from, name), path.join(to, name));
  } } else if (stat.isFile()) fs.copyFileSync(from, to);
  else throw new Error("Plugins may not contain symlinks or special files");
}
fs.mkdirSync(path.dirname(target), { recursive: true });
try { copy(source, target); } catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
console.log("Installed " + name + "; check /admin/plugins. New sessions use it after activation.");
`
export const pluginCreatorTools = [
  defineTool({
    name: 'plugin_creator_guide',
    description: 'Read the bundled plugin creator skill before building a plugin.',
    parameters: Type.Object({}, { additionalProperties: false }),
    meta: { ...meta, isReadOnly: true, isDestructive: false, replay: 'safe', requiresApproval: 'never' },
    async execute(_args, ctx) {
      ctx.signal.throwIfAborted()
      return { content: [{ type: 'text', text: creatorAssets.skill }] }
    },
  }),
  defineTool({
    name: 'plugin_scaffold',
    description:
      'Create a zero-build plugin from the create-agh-plugin templates in a new workspace directory.',
    parameters: Type.Object(
      {
        template: Type.Union(
          ['tool', 'tool-with-panel', 'mcp-skills', 'model-adapter', 'loop'].map((name) =>
            Type.Literal(name),
          ),
        ),
        name: Type.String({ pattern: '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$' }),
        directory: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    meta,
    async execute(args, ctx) {
      return run(ctx, [
        'node',
        '-e',
        `(async () => {${prepare}})().catch(e => { console.error(e.message); process.exitCode = 1 })`,
        'plugin-creator',
        args.template,
        args.name,
        args.directory,
      ])
    },
  }),
  defineTool({
    name: 'plugin_test',
    description:
      'Run the plugin npm test script (author testkit; use scripted model replies, no model account). Install its development dependencies first.',
    parameters: Type.Object({ directory: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    meta,
    async execute(args, ctx) {
      return run(ctx, [ctx.platform.shell === 'powershell' ? 'npm.cmd' : 'npm', 'test'], args.directory)
    },
  }),
  defineTool({
    name: 'plugin_install_local',
    description:
      'Run plugin tests, then copy passing source to the session workspace .agh/plugins/name. Refuses overwrite.',
    parameters: Type.Object(
      { directory: Type.String({ minLength: 1 }), name: Type.String({ pattern: '^[a-z0-9][a-z0-9._-]*$' }) },
      { additionalProperties: false },
    ),
    meta,
    async execute(args, ctx) {
      const tested = await run(
        ctx,
        [ctx.platform.shell === 'powershell' ? 'npm.cmd' : 'npm', 'test'],
        args.directory,
      )
      if (tested.isError) return tested
      return run(ctx, ['node', '-e', install, args.directory, args.name])
    },
  }),
] as const

export default defineExtension((api) => {
  const disposers = pluginCreatorTools.map((tool) => api.registerTool(tool))
  disposers.push(
    api.registerHook('context', () => ({
      sections: [
        {
          id: 'plugin-creator',
          order: 165,
          content:
            'To build a plugin from a user request, first call plugin_creator_guide. Use plugin_scaffold, normal read/write/edit tools, plugin_test, then plugin_install_local. All changes and test commands follow normal session approvals.',
        },
      ],
    })),
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
})
