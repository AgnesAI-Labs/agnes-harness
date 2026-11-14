# Superagent setup guide

Instructions for an agent that sets up Superagent on AGH with its operator. If you are a person, ask your coding agent
to read this file and follow it.

Superagent turns requests on one GitHub repository (and, optionally, Feishu chats) into tickets and gives each ticket to
its own AGH session, which works on a branch and opens a pull request. It acts as a separate GitHub account, with the
permissions that account has. Read [Before you start](#before-you-start) first: two of its rules are not optional.

## How to run the setup

The setup takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and run the probe below once. Read nothing else until every answer
  is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe
  already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the
  operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only
  after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a
  CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.

## Before you start

- **Branch protection on the repository is required.** The agent pushes branches named `agent/<ticket id>` and opens
  pull requests; it never pushes to the default branch and never merges unless you enable auto-merge. Branch protection
  is what makes that a rule instead of a habit. On the default branch, require a pull request with at least one approving
  review, and refuse force pushes and deletions. Do not start Superagent on a repository without it.
- **A dedicated system user is strongly recommended.** Each ticket's session runs with full access to the machine as the
  user that runs the AGH daemon. A separate operating-system user with no access to your own files, keys or signed-in CLIs
  limits what a mistaken or manipulated session can reach. Create the user, run everything below as that user, and give it
  nothing you would not give the agent.
- **A dedicated GitHub account.** Everything the agent writes appears under its name. Use a new account, never the
  operator's own, and give it the least access that works: write access to the one repository.
- **A separate AGH home.** Superagent keeps its database, its git configuration and its ticket directories under its own
  AGH home, apart from the home the operator works in, so that it can restart without closing the operator's sessions.

## 1. Probe

Run once, as the user that will run Superagent, and keep the result to yourself:

```sh
git --version; gh --version | head -1; node -v
gh api user --jq .login          # the operator's own login, a recommendation for question 5
echo "${AGH_HOME:-$HOME/.agh}"
```

- **Prerequisites:** AGH installed with a model provider configured (see [Install](../../../docs/guide/install.md)),
  git 2.32 or later, and GitHub CLI 2.48 or later. A missing one becomes an item of the plan, not a question.
- **Existing home:** a home that already has Superagent installed is an earlier setup: ask whether to continue it.

## 2. Questions

Ask in this order, one per message, following the flow of work: where requests come from, who may ask, then what the
agent does with a ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Sources.** Should the agent take requests from GitHub only, or also from Feishu chats? [GitHub only, unless the team
   works in Feishu.]
2. **Repository.** Which github.com repository should the agent work on, as `owner/name`?
3. **Agent account.** Which GitHub user account will the agent act as? [A dedicated account, never the operator's own.] It
   may not exist yet; creating it is an operator step.
4. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.

**Policy: who may ask for work.**

5. **On GitHub.** Which GitHub logins may ask the agent for work? [Only the operator's own login: the agent acts only for
   people on this list, and a short list keeps the noise low while the team learns how the agent behaves.]
6. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a ticket.**

7. **Checkout.** How should each ticket get its copy of the repository? [A clone into the ticket directory: the prepare
   command runs inside a new ticket's directory, and the repository goes to its `repo/` subdirectory.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its
   own.] Another identity goes into the Delivery requirements prompt section.
9. **Auto-merge.** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No:
   people merge until the agent's pull requests have been right for a while.]

Do not ask about values with a good default; list them in the plan instead: the branch prefix `agent/`, accept mode
`observe` (which records proactive work without doing it), and the default rules and prompt sections.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator
steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** One message with what only the operator can do, as the dedicated system user: create the
   agent GitHub account and add it to the repository with write access; accept the invitation as the agent account; and
   turn on the branch protection above. For Feishu, give Superagent a bot of its own:
   1. Create a second Feishu app (bot) on the Feishu open platform, besides the one the team already uses with AGH.
   2. Add it as another instance of the AGH Feishu channel, on the Channels page. Do not pair any direct chat of this
      instance with a plugin service, and do not bind its chats to a session: Superagent claims the whole instance,
      and an instance already in use is refused.
   3. Note the new instance's id. Superagent's settings list the running channel instances by plugin name and
      instance id, so the instance is chosen there.

   With only one bot, Superagent can instead share it and receive only the listed chats (claim **Only these chats**);
   direct messages and other chats are then not received.
   The agent account is signed in in step 5. Wait until the operator says it is done.
2. **A separate AGH home.** Pick a directory for it and use it for every `agh` command and for the daemon:

   ```sh
   export AGH_HOME="$HOME/superagent-agh"
   ```

   Create it with the first command that uses it, and configure a model provider in it as in
   [Install](../../../docs/guide/install.md). Start the daemon once as usual (`agh serve`).
3. **Install and enable the plugin.** Open **Plugins → Marketplace**, find **Superagent**, and select **Install**. The
   package ships with AGH but is not installed by default. Review what it asks for: model and session access, the
   credentials of the agent account, and running commands on this machine. Finish the installation and enable the plugin
   (see [Plugins](../../../docs/guide/packages.md)). It reports a setup problem, because the agent's environment does
   not exist yet; that is expected.
4. **Fix the state directory.** Superagent keeps the agent's identity under its state directory, the plugin setting
   `stateDir`. Either set `stateDir` to an absolute path of your choice on the plugin's settings page, or leave it unset
   and read the default from the **Deployment** page of the panel (it is under the AGH data directory, in
   `bundled-apps/<hash>`). Use the same path in the next steps. Below, `<stateDir>` stands for it:

   | Path | What it is |
   | --- | --- |
   | `<stateDir>/home` | The agent's `HOME`: its git configuration and credential helper. Superagent writes it. |
   | `<stateDir>/home/.config/gh` | The agent's GitHub CLI login. |
   | `<stateDir>/worker-bin` | Shims for `gh` and the commands the agent must not use. Superagent writes it. |

5. **Sign the agent in.** As the dedicated system user, with the agent's own configuration directory, never the
   operator's:

   ```sh
   GH_CONFIG_DIR="<stateDir>/home/.config/gh" gh auth login
   GH_CONFIG_DIR="<stateDir>/home/.config/gh" gh api user --jq .login   # must print the agent account
   ```

6. **Restart the daemon with the agent's identity.** Stop the daemon you started in step 2, by its process id, and start
   it again with `HOME` set to the proxy home and the shim directory first on `PATH`, so that the sessions it runs act as
   the agent account and never as the operator, even when the operator is signed in on the same machine:

   ```sh
   HOME="<stateDir>/home" PATH="<stateDir>/worker-bin:$PATH" agh serve
   ```

   Superagent checks this environment when it starts and reports a setup problem, with its cause, if the daemon was
   started without it. Select **Check again** on the overview.
7. **Save the settings.** Open the **Superagent** entry on the home page and save from the **Settings** tab, or, for a
   setup agent, through the services in [Settings services](#settings-services). The agent's own tools cannot change the
   account or execution-environment fields, only the panel and these services can. In this order:
   1. **Sources:** the GitHub Source (repository and the agent's GitHub CLI), then the Feishu Source if used: the
      dedicated bot's instance, chosen from the list of running channel instances, claim **Whole instance**, the chats,
      and whether direct messages and other chats are received. An instance where the owner paired a direct chat or
      bound a session is marked and cannot be chosen to claim whole. A setup agent saving through the services takes
      the value from `choices.instance` of the Feishu Source in `superagent.settings.get`; it has the form
      `<channel row id>/<instance id>`, for example `ext:agnes.feishu/main/superagent-bot`, and is typed by hand only
      when that list is empty. If the Source reports that the instance already serves the owner or another feature,
      choose the dedicated instance instead; Superagent never takes over the owner's direct messages. An unused
      pairing code for the instance holds it the same way until the code expires (within an hour).
   2. **Policy:** the allowed lists, and for Feishu the chat ids, chosen from the chats the channel lists.
   3. **Execution:** the ticket directory root and the prepare command from question 7, for example
      `git clone "https://github.com/<owner>/<name>.git" repo`.
   4. **Prompts:** the commit identity of question 8 and the auto-merge answer of question 9 in Delivery requirements.

   Every save keeps a version, shown in the history of the Settings tab. A save that changes the agent's account or CLI
   re-runs the deployment check; a refused save names the setup problem.
8. **Failures.** A setup problem is shown on the overview and on the settings that fix it, in plain words. Fix it, then
   select **Check again** (`superagent.setup.check`). Ask the operator only for what you cannot fix yourself.

## Settings services

The panel is a client of the plugin's profile services; a setup agent calls the same ones. There is no `agh` command for
them: use the SDK client of the daemon, as the plugin's own end-to-end test does.

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient, memoryJournal } from '@agnes/sdk'

const owner = JSON.parse(readFileSync(`${process.env.AGH_HOME}/daemon/owner.json`, 'utf8'))
const client = createClient({
  journal: memoryJournal(),
  auth: { kind: 'local' },
  transport: { kind: 'unix', path: owner.socketPath },
})
await client.initialize()
// The extension id is derived from the plugin row id, `d1215cfcd1af03a1` for this plugin.
const extension = `plugin/${createHash('sha256').update('ext:agnes.superagent/main').digest('hex').slice(0, 16)}`
const query = async (service: string, input: object = {}) =>
  (await client.extensions.callScoped({ extension, service, input })).output
const effect = async (service: string, input: object) =>
  (await client.extensions.callScoped({ extension, service, input, operationId: crypto.randomUUID() })).output
```

Services that read are queries, services that change something are effects (give each its own `operationId`; reuse one
only to retry the same call). The ones a setup uses:

| Service | Input | Result |
| --- | --- | --- |
| `superagent.settings.get` | none | `blocks.{policy,eval,executor}` as `{ value, revision }`, and `sources` with each Source's fields and revision |
| `superagent.settings.save` | `block` (`policy`, `eval`, `executor`, or `source:<id>`), `value`, `revision` | `{ revision, restarting }` |
| `superagent.prompts.get` / `superagent.prompts.save` | none / `config`, `baseRevision` | the prompt versions / `{ revision }` |
| `superagent.state` | none | setup problem, accounts, load and the health of each part |
| `superagent.setup.check` | none | `{ restarting }`; runs the deployment check again |

Save one block at a time, with the `revision` read from `superagent.settings.get` just before. For a Source block the
value is `{ enabled, config }`, with the fields the Source declares in `superagent.settings.get`.

A refusal is a normal result, not an exception: it is `{ failure: { status, error, ... } }`.

- `status: 409` means the block changed since you read it: read `superagent.settings.get` again and retry with the new
  `revision`.
- `status: 400` with `issues` names the invalid fields; with `setup` it names the setup problem (a missing or signed-out
  CLI, an unreadable repository). Fix that, then save again.
- `status: 503` means Superagent has not finished starting: wait and retry.
- A result with `restarting: true` means the save re-runs setup: wait until `superagent.state` answers without a setup
  problem before the next save, and read the revisions again.

```ts
const current = (await query('superagent.settings.get')) as { blocks: { executor: { value: object; revision: number } } }
const { value, revision } = current.blocks.executor
const result = await effect('superagent.settings.save', {
  block: 'executor',
  value: { ...value, prepare: 'git clone "https://github.com/acme/widgets.git" repo' },
  revision,
})
```

## 5. Verify and hand over

The panel's overview shows no setup problem, and the Sources are ready. Then send one message, under 300 words:

- Where to look: the **Superagent** entry on the AGH home page.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository.
  A ticket appears on the overview within about a minute.
- Three rules for the operator: start narrow, tune for less noise, and own what the agent says.
- How to stop it: use **Pause** on the Execution tab to stop new work at once, or disable the plugin under Plugins; a
  running ticket's session is stopped and its work is picked up again after the plugin is enabled.
