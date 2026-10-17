// Writes `read-heavy.json` next to this file: two long sessions that mostly navigate and read a small
// seeded workspace and answer questions about it, with one small write each. The seed files, the
// answers the turns check and the probes all come from the tables below, so every run writes the
// same suite. Regenerate from the repository root, then format:
//   node packages/loop-jev/bench/suites/make-read-heavy.mjs
//   pnpm exec biome format --write packages/loop-jev/bench/suites/read-heavy.json
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NO_CHANGE = 'Do not change any file.'

/** `{ name: content }` as the runner's `inject_files`; each content loses its leading newline. */
const files = (map) => Object.entries(map).map(([name, content]) => ({ name, content: content.slice(1) }))

/** The rows of a `|`-separated table, one per non-empty line, cells trimmed. */
const rows = (table) =>
  table
    .trim()
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))

// ---- the code workspace -------------------------------------------------------------------

const PKG = 'src/tallyhouse'

const CODE_FILES = files({
  'README.md': `
# tallyhouse

Ledger jobs that run on a schedule. The entry point is configured in \`config/app.toml\`;
each profile under \`config/profiles/\` chooses a pipeline and a queue.

- \`src/tallyhouse/\`: the package
- \`tests/\`: unit tests
- \`docs/\`: architecture notes and a glossary
`,
  'pyproject.toml': `
[project]
name = "tallyhouse"
version = "2.4.1"
requires-python = ">=3.11"
`,
  'config/app.toml': `
# The entry point and profile the scheduler starts.
entry = "tallyhouse.cli:main"
profile = "nightly"
`,
  'config/profiles/nightly.toml': `
pipeline = "batch"
queue = "q-ember-lark"
`,
  'config/profiles/hourly.toml': `
pipeline = "stream"
queue = "q-slate-wren"
`,
  [`${PKG}/__init__.py`]: `
"""tallyhouse: scheduled ledger jobs."""

__version__ = "2.4.1"
`,
  [`${PKG}/cli.py`]: `
"""Command-line entry point."""
import tomllib
from pathlib import Path

from tallyhouse import pipeline


def load_profile():
    app = tomllib.loads(Path("config/app.toml").read_text())
    name = app["profile"]
    return tomllib.loads(Path(f"config/profiles/{name}.toml").read_text())


def main():
    return pipeline.run(load_profile())
`,
  [`${PKG}/pipeline.py`]: `
"""Chooses the job for a profile."""
from tallyhouse import batch, stream


def run(profile):
    if profile["pipeline"] == "batch":
        return batch.run_batch(profile["queue"])
    return stream.run_stream(profile["queue"])
`,
  [`${PKG}/batch.py`]: `
"""The nightly batch job."""
from tallyhouse import audit, money, settings, storage


def run_batch(queue):
    audit.audit_log("batch " + queue)
    for attempt in range(settings.BATCH_RETRY_LIMIT):
        rows = storage.fetch_rows(queue, limit=500)
        if rows:
            return [money.normalize_amount(row) for row in rows]
    return []
`,
  [`${PKG}/stream.py`]: `
"""The hourly stream job."""
from tallyhouse import fx, settings, storage


def run_stream(queue):
    for attempt in range(settings.STREAM_RETRY_LIMIT):
        rows = storage.fetch_rows(queue, limit=1)
        if rows:
            return [fx.convert(row, "EUR") for row in rows]
    return []
`,
  [`${PKG}/settings.py`]: `
"""Settings shared by the jobs."""

BATCH_RETRY_LIMIT = 11
STREAM_RETRY_LIMIT = 17
DEFAULT_CURRENCY = "NOK"
`,
  [`${PKG}/money.py`]: `
"""Amounts and rounding."""


def normalize_amount(row):
    return round_cents(float(row["amount"]))


def round_cents(value):
    return round(value, 2)
`,
  [`${PKG}/audit.py`]: `
"""The audit trail."""
import logging

_log = logging.getLogger("tallyhouse.audit")


def audit_log(message):
    _log.info("audit: %s", message)
`,
  [`${PKG}/accounts.py`]: `
"""Customer accounts."""
from tallyhouse import audit, ledger


def open_account(account_id):
    audit.audit_log("open " + account_id)
    return ledger.post_entry(account_id, 0)


def close_account(account_id):
    audit.audit_log("close " + account_id)
    return ledger.reverse_entry(account_id)


def account_balance(account_id):
    return ledger.balance(account_id)
`,
  [`${PKG}/ledger.py`]: `
"""Ledger entries."""
from tallyhouse import audit, storage


def post_entry(account_id, amount):
    audit.audit_log("post " + account_id)
    storage.save_rows([{"account": account_id, "amount": amount}])


def reverse_entry(account_id):
    audit.audit_log("reverse " + account_id)
    storage.save_rows([{"account": account_id, "amount": 0, "reversal": True}])


def balance(account_id):
    return sum(row["amount"] for row in storage.fetch_rows(account_id, limit=1000))
`,
  [`${PKG}/reconcile.py`]: `
"""Matching ledger entries against bank statements."""
from tallyhouse import audit, ledger


def match_entries(statement):
    audit.audit_log("reconcile " + statement["id"])
    return [ledger.balance(line["account"]) for line in statement["lines"]]


def report_mismatch(entry):
    return "mismatch: " + str(entry)
`,
  [`${PKG}/fx.py`]: `
"""Currency conversion."""
from tallyhouse import settings

RATES = {"EUR": 0.086, "USD": 0.093}


def rate_for(currency):
    return RATES.get(currency, 1.0)


def convert(row, currency=settings.DEFAULT_CURRENCY):
    return {**row, "amount": row["amount"] * rate_for(currency)}
`,
  [`${PKG}/report.py`]: `
"""Periodic reports."""
from tallyhouse import ledger


def monthly_report(accounts):
    return {account: ledger.balance(account) for account in accounts}


def yearly_report(accounts):
    return monthly_report(accounts)
`,
  [`${PKG}/storage.py`]: `
"""Row storage."""

_ROWS = {}


def fetch_rows(queue, limit):
    return _ROWS.get(queue, [])[:limit]


def save_rows(rows):
    for row in rows:
        _ROWS.setdefault(row["account"], []).append(row)
`,
  [`${PKG}/exporters/__init__.py`]: `
"""Exporters for ledger rows."""
`,
  [`${PKG}/exporters/csv_export.py`]: `
"""CSV export."""


def export_header():
    return "account,amount"


def export_rows(rows):
    return [str(row["account"]) + "," + str(row["amount"]) for row in rows]


def export_totals(rows):
    return sum(row["amount"] for row in rows)
`,
  [`${PKG}/exporters/json_export.py`]: `
"""JSON export."""
import json


def export_schema():
    return {"account": "string", "amount": "number"}


def export_rows(rows):
    return json.dumps(rows)


def export_totals(rows):
    return json.dumps({"total": sum(row["amount"] for row in rows)})
`,
  [`${PKG}/exporters/xlsx_export.py`]: `
"""Spreadsheet export, not finished."""


def export_rows(rows):
    raise NotImplementedError("xlsx export")


def export_sheet(name):
    raise NotImplementedError(name)
`,
  'tests/test_money.py': `
from tallyhouse.money import normalize_amount, round_cents


def test_round_cents():
    assert round_cents(2.5) == 2.5


def test_normalize_amount():
    assert normalize_amount({"amount": "3"}) == 3.0
`,
  'tests/test_batch.py': `
from unittest import mock

from tallyhouse import batch


def test_run_batch_writes_the_audit_trail():
    with mock.patch("tallyhouse.audit.audit_log") as audit_log:
        batch.run_batch("q-test")
    audit_log.assert_called()
`,
  'tests/test_exporters.py': `
from tallyhouse.exporters import csv_export, json_export


def test_totals_agree():
    assert json_export.export_totals([]) == '{"total": 0}'
    assert csv_export.export_totals([]) == 0
`,
  'docs/architecture.md': `
# Architecture

The scheduler starts the entry point named in \`config/app.toml\`. The CLI loads the active
profile and hands it to \`pipeline.run\`, which picks the batch or the stream job.
Every write to the ledger goes through \`audit_log\`.
`,
  'docs/glossary.md': `
# Glossary

- **profile**: a file under \`config/profiles/\` that names a pipeline and a queue.
- **queue**: the source a job reads rows from.
- **retry limit**: how many times a job polls its queue before it gives up.
`,
})

const SRC = CODE_FILES.filter((f) => f.name.startsWith('src/'))
const AUDIT_CALLS = SRC.reduce((n, f) => n + f.content.split('audit.audit_log(').length - 1, 0)
const AUDIT_MODULES = SRC.filter((f) => f.content.includes('audit.audit_log('))
  .map((f) => f.name.split('/').at(-1).replace(/\.py$/, ''))
  .sort()
const MODULES = SRC.filter((f) => f.name.endsWith('.py') && !f.name.endsWith('/__init__.py')).length

const CODE_TURNS = [
  {
    goal: `Give me an overview of this repository: name its top-level directories and say what each holds. Also tell me how many Python modules there are under ${PKG}, counting subpackages but not __init__.py files; give the number in digits. ${NO_CHANGE}`,
    answer: ['config', 'src', 'tests', 'docs', String(MODULES)],
  },
  {
    goal: `In which file is the function normalize_amount defined, and which other function is defined in the same file? ${NO_CHANGE}`,
    answer: ['money.py', 'round_cents'],
  },
  {
    goal: `The scheduler starts the entry point named in config/app.toml. Follow the configuration and the code from there: which job function runs, and which queue does it read? ${NO_CHANGE}`,
    answer: ['run_batch', 'q-ember-lark'],
  },
  {
    goal: `Compare ${PKG}/exporters/csv_export.py with ${PKG}/exporters/json_export.py. Which functions do both define, and which function does each define that the other lacks? ${NO_CHANGE}`,
    answer: ['export_rows', 'export_totals', 'export_header', 'export_schema'],
  },
  {
    goal: `How many times is audit_log called in the code under src/ (call sites only, not its definition), and in which modules? Give the count in digits. ${NO_CHANGE}`,
    answer: [String(AUDIT_CALLS), ...AUDIT_MODULES],
  },
  {
    goal: 'Write notes/audit-sites.md with one line per module under src/ that calls audit_log, the module name only. Do not change any other file.',
    answer: [],
    note: { path: 'notes/audit-sites.md', words: AUDIT_MODULES },
  },
  {
    goal: `If config/app.toml selected the hourly profile instead, which job function would run, and which retry-limit setting would it use, with what value? ${NO_CHANGE}`,
    answer: ['run_stream', 'STREAM_RETRY_LIMIT', '17'],
  },
  {
    goal: `Remind me of two things from earlier: which queue does the configured entry point read, and in which file is normalize_amount defined? ${NO_CHANGE}`,
    answer: ['q-ember-lark', 'money.py'],
  },
]

// ---- the documentation workspace ----------------------------------------------------------

const TEAMS = Object.fromEntries(
  rows(`
harbor  | Mirela Voss     | #harbor-oncall
juniper | Anika Brandt    | #juniper-ops
kestrel | Tomas Arkwright | #kestrel-pager
osprey  | Felix Mori      | #osprey-desk
`).map(([team, lead, channel]) => [team, { lead, channel }]),
)

const RUNBOOKS = rows(`
auth-outage.md    | Login Outage                  | kestrel | cert-expiry.md   | Users cannot sign in and the login page shows error 503.
backup-restore.md | Backup Restore Drill          | juniper | -                | The weekly restore drill is due, or a restore was requested.
cache-stampede.md | Cache Stampede                | juniper | queue-backlog.md | The cache hit rate drops to near zero right after a deploy.
cert-expiry.md    | Certificate Expiry            | kestrel | dns-failover.md  | Clients report TLS handshake failures shortly after midnight UTC.
cold-storage.md   | Cold Storage Recovery         | juniper | -                | Archived objects return 404 or take minutes to restore.
disk-pressure.md  | Disk Pressure on Ingest Nodes | harbor  | cold-storage.md  | Write latency climbs while /var/spool/ingest fills up.
dns-failover.md   | DNS Failover                  | osprey  | -                | Internal names still resolve to the old region after a failover.
memory-leak.md    | Memory Growth in Workers      | osprey  | replica-lag.md   | Worker memory grows steadily until the process is restarted.
queue-backlog.md  | Queue Backlog                 | kestrel | disk-pressure.md | Consumers fall behind and the oldest message is older than ten minutes.
rate-limit.md     | Upstream Rate Limiting        | kestrel | dns-failover.md  | Calls to the payment partner fail with status 429.
replica-lag.md    | Replica Lag                   | harbor  | cold-storage.md  | Read replicas trail the primary by more than thirty seconds.
`).map(([file, title, owner, next, symptom]) => ({
  file,
  title,
  owner,
  next: next === '-' ? null : next,
  symptom,
}))

const SERVICES = rows(`
beacon      | 1 | osprey  | auth-outage.md    | ledgerd vault-proxy
ingestor    | 2 | harbor  | disk-pressure.md  | ledgerd quarry
lantern     | 3 | juniper | cache-stampede.md | ledgerd
ledgerd     | 1 | harbor  | replica-lag.md    | vault-proxy
mosaic      | 2 | osprey  | memory-leak.md    | relay lantern
quarry      | 2 | juniper | cold-storage.md   | -
relay       | 1 | kestrel | queue-backlog.md  | ingestor
vault-proxy | 0 | kestrel | cert-expiry.md    | -
`).map(([name, tier, owner, runbook, deps]) => ({
  name,
  tier,
  owner,
  runbook,
  deps: deps === '-' ? [] : deps.split(' '),
}))

const runbook = (file) => {
  const found = RUNBOOKS.find((r) => r.file === file)
  if (!found) throw new Error(`no runbook ${file}`)
  return found
}

const DOC_FILES = [
  ...files({
    'README.md': `
# Operations handbook

- \`services/\`: one page per service with its tier, owner, runbook and dependencies; \`services/index.md\` lists them.
- \`runbooks/\`: what to do when something breaks.
- \`policies/\`: retention, access and on-call rules.
- \`teams/\`: who to page.
`,
    'services/index.md': `
# Services

| Service | Tier | Page |
| --- | --- | --- |
${SERVICES.map((s) => `| ${s.name} | ${s.tier} | [${s.name}](${s.name}.md) |`).join('\n')}
`,
    'policies/access.md': `
# Access policy

- Access reviews are held every 90 days.
- Break-glass accounts expire after 4 hours.
- Production access needs a ticket.
`,
    'policies/oncall.md': `
# On-call policy

- Handover happens at 09:30 UTC.
- A page must be acknowledged within 15 minutes.
- Escalations follow the escalation link of the runbook.
`,
    'policies/retention.md': `
# Retention policy

- Application logs are kept for 30 days.
- Audit logs are kept for 400 days.
- Metrics are kept for 13 months.
`,
  }),
  ...SERVICES.map((s) => ({
    name: `services/${s.name}.md`,
    content: `# ${s.name}

Tier: ${s.tier}
Owner: ${s.owner}
Runbook: [${runbook(s.runbook).title}](../runbooks/${s.runbook})
Depends on: ${s.deps.length > 0 ? s.deps.join(', ') : 'none'}
`,
  })),
  ...RUNBOOKS.map((r) => ({
    name: `runbooks/${r.file}`,
    content: `# ${r.title}

Owner: ${r.owner}

## Symptoms

${r.symptom}

## Steps

1. Check the service dashboard and note when the problem started.
2. Post a short status in the owning team channel.

## Escalation

${r.next ? `If this does not resolve it, continue with [${runbook(r.next).title}](${r.next}).` : 'No further runbook: page the owning team.'}
`,
  })),
  ...Object.entries(TEAMS).map(([team, t]) => ({
    name: `teams/${team}.md`,
    content: `# Team ${team}

Lead: ${t.lead}
Pages: ${t.channel}
`,
  })),
]

const SPOOL = runbook('disk-pressure.md')
const BEACON_END = runbook(runbook(SERVICES.find((s) => s.name === 'beacon').runbook).next)
const BEACON_CHANNEL = TEAMS[BEACON_END.owner].channel.slice(1)
const KESTREL = RUNBOOKS.filter((r) => r.owner === 'kestrel').map((r) => r.file)
const ON_LEDGERD = SERVICES.filter((s) => s.deps.includes('ledgerd')).map((s) => s.name)

const DOC_TURNS = [
  {
    goal: `Give me an overview of this handbook: name its top-level sections and say what each holds. How many runbooks are there? Give the number in digits. ${NO_CHANGE}`,
    answer: ['services', 'runbooks', 'policies', 'teams', String(RUNBOOKS.length)],
  },
  {
    goal: `Which runbook should I open when write latency climbs while /var/spool/ingest fills up? Give its file name and the team that owns it. ${NO_CHANGE}`,
    answer: [SPOOL.file, SPOOL.owner],
  },
  {
    goal: `Start from the service page of beacon, open its runbook, then follow the escalation link of that runbook. What is the title of the runbook you end at, and in which chat channel does the team that owns it take pages? ${NO_CHANGE}`,
    answer: [BEACON_END.title, BEACON_CHANNEL],
  },
  {
    goal: `How many runbooks does the kestrel team own, and which are they? Give the count in digits and the file names. ${NO_CHANGE}`,
    answer: [String(KESTREL.length), ...KESTREL],
  },
  {
    goal: `Compare policies/retention.md with policies/access.md: how long are audit logs kept, and how often are access reviews held? ${NO_CHANGE}`,
    answer: ['400 days', '90 days'],
  },
  {
    goal: 'Write notes/kestrel.md with one line per runbook that the kestrel team owns, the file name only. Do not change any other file.',
    answer: [],
    note: { path: 'notes/kestrel.md', words: KESTREL },
  },
  {
    goal: `Which services depend directly on ledgerd? List them. ${NO_CHANGE}`,
    answer: ON_LEDGERD,
  },
  {
    goal: `Remind me of two things from earlier: which runbook covers write latency while /var/spool/ingest fills up, and in which chat channel does the escalation from beacon end? ${NO_CHANGE}`,
    answer: [SPOOL.file, BEACON_CHANNEL],
  },
]

// ---- probes and assembly ------------------------------------------------------------------

/** The digest the probes recompute: every seed file in the given order, its name and its bytes. */
function seedDigest(seed) {
  const hash = createHash('sha256')
  const nul = Buffer.from([0])
  for (const f of seed) hash.update(Buffer.concat([Buffer.from(f.name), nul, Buffer.from(f.content), nul]))
  return hash.digest('hex')
}

/**
 * A probe that checks that no seed file changed, runs `extra` Python lines, and prints `marker`.
 * The Python text holds no single quote, so one pair of single quotes passes it to the shell as is.
 */
function probe(seed, marker, extra) {
  const code = [
    'import hashlib',
    'from pathlib import Path',
    `names = "${seed.map((f) => f.name).join(' ')}".split()`,
    'h = hashlib.sha256()',
    'for n in names:',
    '    h.update(n.encode() + b"\\0" + Path(n).read_bytes() + b"\\0")',
    `assert h.hexdigest() == "${seedDigest(seed)}", "a seed file changed"`,
    ...extra,
    `print("${marker}")`,
  ].join('\n')
  if (code.includes("'")) throw new Error(`probe ${marker} would need shell quoting`)
  return { command: `python -B -c '${code}'`, contains: marker }
}

/** Python lines that check the file a turn wrote: it exists and names every word, ignoring case. */
const noteHas = ({ path, words }) => [
  `text = Path("${path}").read_text(encoding="utf-8").lower()`,
  `for w in ${JSON.stringify(words.map((w) => w.toLowerCase()))}:`,
  '    assert w in text, w',
]

function scenario({ id, tag, description, seed, turns }) {
  return {
    id,
    category: 'read_heavy',
    favor: 'jev',
    description,
    max_steps: 20,
    turns: turns.map((t, i) => ({
      goal: t.goal,
      ...(t.answer.length > 0 ? { answer_contains: t.answer } : {}),
      ...(i === 0 ? { inject_files: seed } : {}),
      bash: [probe(seed, `READ_HEAVY_${tag}_T${i + 1}_OK`, t.note ? noteHas(t.note) : [])],
    })),
  }
}

export function buildSuite() {
  return {
    suite: 'read-heavy',
    description:
      'Long sessions that mostly navigate and read a seeded workspace and answer questions, with one small write each. Written for this bench, not ported.',
    scenarios: [
      scenario({
        id: 'read-heavy-code',
        tag: 'CODE',
        description:
          'A small Python package: definitions, a configuration chain, a module comparison and counts.',
        seed: CODE_FILES,
        turns: CODE_TURNS,
      }),
      scenario({
        id: 'read-heavy-docs',
        tag: 'DOCS',
        description:
          'An operations handbook: symptom lookup, an escalation chain across pages, ownership counts.',
        seed: DOC_FILES,
        turns: DOC_TURNS,
      }),
    ],
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('./read-heavy.json', import.meta.url))
  writeFileSync(out, `${JSON.stringify(buildSuite(), null, 2)}\n`)
  console.log(`wrote ${out}`)
}
