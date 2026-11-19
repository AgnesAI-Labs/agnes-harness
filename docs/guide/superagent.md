# Superagent deployment

English | [简体中文](superagent.zh-CN.md)

[Documentation](../README.md) · [Plugins](packages.md) · [Security](security.md) · [Network deployment](deployment.md)

Superagent is an official plugin installed and enabled by default with AGH. It watches one GitHub repository (and, optionally, Feishu chats
through an already configured bot lark-cli wrapper), turns requests from allowed people into tickets, and gives each ticket its own
session. That session works in the ticket's directory, pushes its own branch and opens a pull request; the main session
answers people. Its sidebar entry opens the existing panel. Until configured, it waits for setup without listening to
external sources, accepting work, starting sessions or calling models. Default installation authorizes no external
account or requester.

Upgrades add the package to existing homes that have never installed or removed it. Installed configuration and data,
explicit disable or uninstall choices, and profile capability ceilings are preserved. If an upgrade needs to offer new
defaults but package removal history is unreadable or incomplete, provisioning refuses instead of assuming consent;
profiles with no new default candidates do not read that history.

This page covers running it as a long-lived service: the accounts and the separate AGH home, a launchd or systemd unit
or a Windows scheduled task,
enabling, disabling, clearing its data, and what its sessions can and cannot reach. The step-by-step setup that a coding
agent walks through with you, including the settings and the panel, is in the plugin's
[setup guide](../../packages/superagent/docs/setup.md).

## Before you start

- **macOS, Linux or Windows.** On Windows the ticket sessions and the prepare command run in Windows PowerShell, where a
  variable reads as `$env:NAME`; Superagent's shims are `.cmd` files; and Git for Windows is required, since git runs
  the agent's credential helper with its own shell. The paths below are the POSIX ones; on Windows use any absolute
  paths, such as `C:\Superagent\agh`.
- **A dedicated operating-system user (strongly recommended).** Every ticket session runs with full access as the user
  that runs the daemon. Only a separate user, with none of your own files, keys or signed-in tools, limits what a mistaken
  or manipulated session can reach. See [Security boundaries](#security-boundaries).
- **A dedicated GitHub account** for the agent, with write access to the one repository, and **branch protection** on the
  default branch: a pull request with an approving review, no force pushes, no deletions. The agent never merges unless
  you turn on auto-merge in its prompts.
- **A separate AGH home** for Superagent, apart from the home you work in, with a model provider configured. Superagent
  restarts with its own daemon without closing your sessions.
- git 2.32 or later and GitHub CLI 2.48 or later on the machine.

## Paths

The examples use these paths; any absolute paths work. Paths under a personal home directory are best avoided for a
service account.

| Path | Holds |
| --- | --- |
| `/srv/superagent/agh` | `AGH_HOME`: the daemon's home, its model configuration, sessions and the Superagent skills it lists |
| `/srv/superagent/state` | Superagent's state directory (the plugin setting `stateDir`): `superagent.sqlite`, the ticket directories in `work/` |
| `/srv/superagent/state/Superagent` | The workspace directory for a new main session; the sidebar displays its actual directory name, `Superagent` |
| `/srv/superagent/state/worker-bin` | Shims, written by Superagent on every start: `gh` runs the agent's GitHub CLI; blocked commands fail |
| `/srv/superagent/state/worker-gitconfig` | The agent's git configuration, written by Superagent on every start |
| `/srv/superagent/bin/gh-agent` | The agent's GitHub CLI: a `gh` wrapper with its own configuration directory |
| `/srv/superagent/gh-agent` | That configuration directory: the agent's GitHub CLI login |

Without a `stateDir` setting Superagent uses a directory under the AGH data directory, `bundled-apps/<hash>`, which the
panel's **Deployment** page names. Setting it explicitly before the service starts keeps the unit files below fixed.
New main sessions use `<stateDir>/Superagent`, including when `stateDir` is configured explicitly. The database,
agent environment and ticket directories keep their paths under `stateDir`; an explicit executor directory is unchanged.
This default does not move an existing session's workspace.

## Install and enable

1. As the service user, with `AGH_HOME=/srv/superagent/agh`, start the daemon once (`agh serve`) and configure a model
   provider as in [Install](install.md). In a fresh home, create nothing under `AGH_HOME` before this first start: a
   file there, such as a log the daemon's output is redirected to, makes the launcher refuse the home with
   `E_HOME_VERSION`. Write the log outside the home, for example to `/srv/superagent/agh.log`.
2. Open **Superagent** in the sidebar; it is already installed and enabled and waits for configuration. If you previously
   disabled it, enable it from **Plugins**. If you removed it, reinstall from **Plugins → Marketplace** after reviewing
   its model/session access and local command execution ([Plugins](packages.md)). The terminal equivalent is
   `agh plugins add file:./bundled-plugins/superagent` with the same `AGH_HOME`: this reserved reference identifies the
   official shipped payload. A package name alone is not a source, and a folder copy receives no bundled-app grant
   (see [Troubleshooting](#troubleshooting)).
3. On the plugin's settings page set `stateDir` to `/srv/superagent/state` (on Windows, leave it unset; see
   [Windows](#windows-task-scheduler)). Superagent then reports a setup problem because the agent's environment is not
   in place yet; that is expected.
4. Give the agent a GitHub CLI that uses only its own login, never yours: a `gh-agent` wrapper with its own
   configuration directory. Then sign it in:

   ```sh
   mkdir -p /srv/superagent/bin
   cat > /srv/superagent/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR=/srv/superagent/gh-agent exec gh "$@"
   EOF
   chmod +x /srv/superagent/bin/gh-agent
   /srv/superagent/bin/gh-agent auth login
   /srv/superagent/bin/gh-agent api user --jq .login
   ```

   On macOS, sign in with `gh-agent auth login --insecure-storage` (and a classic token with
   `--with-token --insecure-storage`), so that the token stays in the wrapper's configuration directory. Ticket sessions
   run inside the macOS sandbox, which cannot read the keychain where `gh` keeps a token otherwise; there the agent's
   `gh` would act signed out. Setup reports a token it finds in the keychain.

   On Windows the wrapper is `gh-agent.cmd`. It runs `gh.exe` by its full path (`where.exe gh` prints it), so it never
   reaches Superagent's `gh` shim, and its own path is ASCII only: the shim names it, and `cmd.exe` misreads other
   characters in a batch file. So does the path of `gh.exe` written into it: one under your profile (a per-user install
   by winget or scoop) is written through `%LOCALAPPDATA%` or `%USERPROFILE%`, which `cmd.exe` expands when it runs;
   any other path that is not ASCII stops the recipe, and `gh.exe` must move. In PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force C:\Superagent\bin | Out-Null
   $gh = (Get-Command gh.exe).Source.Replace($env:LOCALAPPDATA, '%LOCALAPPDATA%').Replace($env:USERPROFILE, '%USERPROFILE%')
   if ($gh -match '[^\x20-\x7e]') { throw "Move gh.exe to a path of ASCII characters: $gh" }
   Set-Content -Encoding ascii C:\Superagent\bin\gh-agent.cmd "@set `"GH_CONFIG_DIR=C:\Superagent\gh-agent`"`r`n@`"$gh`" %*"
   C:\Superagent\bin\gh-agent.cmd auth login
   C:\Superagent\bin\gh-agent.cmd api user --jq .login
   ```

   A batch file cannot pass a line break on in an argument. Superagent gives it a comment's text on standard input, and
   tells its Windows sessions to give multi-line text to `gh` in a file (`--body-file`).

   The last command prints the account the agent acts as; Superagent reads it the same way. Sign in through the
   browser, as the agent's own GitHub account: a dedicated account, added as a collaborator with write access to this
   one repository and to nothing else, so that whatever it signs in with reaches only that repository. You can sign in
   with your own account instead, for a trial; the agent then acts as you. Superagent receives requests through the
   account's notifications, and GitHub's notifications API accepts only a browser sign-in or a classic token:

   - **Fine-grained personal access tokens are not supported**: the notifications API refuses them. Superagent's setup
     check then reports "The agent's GitHub token cannot read notifications".
   - **A classic personal access token**, given with `gh auth login --with-token`, works with the `repo` and
     `notifications` scopes. It reaches every repository the account can reach, which is one more reason to give the
     account access to this repository only.

   Branch protection on the default branch, not the token, is what keeps the agent from pushing there or merging
   without a person's approval. Superagent never reads that protection, and reading it needs admin rights on the
   repository, which the agent account should not have: check it with your own account.
5. On the panel's **Sources** page, enter the repository (`owner/name`) and the CLI,
   `/srv/superagent/bin/gh-agent`, on the GitHub card, and save. Setup checks the account and its push access.
6. Stop that daemon and run it as a service, as below.

## Run as a service

The daemon starts as usual; it needs no `HOME` or `PATH` of the agent's. Superagent gives each session it opens the
agent's environment: the shims first on `PATH`, its own git configuration in place of the user's global and system
ones (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`), no git prompts, and no `GH_TOKEN` or `GITHUB_TOKEN`. So the commits,
pushes and `gh` calls of its sessions act as the agent account even when the operator is signed in on the same machine.
Superagent's own git, `gh` and prepare commands run the same way. On every start it checks, in that environment, that
git asks only the agent's GitHub CLI for github.com credentials and that the CLI acts as the agent. The environment is
kept with each session, so it still applies after a restart, whoever opens the session. Only Superagent can give a
session this environment, and only its own sessions: the platform refuses it from any other client or plugin.

Sessions keep the daemon's `HOME`, and git reads `~/.netrc` before it asks any credential helper: a `machine github.com`
or `default` entry there would sign the agent's pushes in as you. Superagent refuses to start while one exists
(`agentNetrc`); remove the entry, or run the service as a user without one.

A service manager does not read your shell profile: write `PATH` out so that it reaches `node`, `git` and the `gh` the
wrapper runs.

### macOS (launchd)

`/Library/LaunchDaemons/dev.agnes.superagent.plist`, loaded with `sudo launchctl bootstrap system <file>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agnes.superagent</string>
  <key>UserName</key><string>superagent</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/agh</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>AGH_HOME</key><string>/srv/superagent/agh</string>
  </dict>
  <key>WorkingDirectory</key><string>/srv/superagent</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardErrorPath</key><string>/srv/superagent/agh.log</string>
</dict>
</plist>
```

### Windows (Task Scheduler)

Windows has no service unit for `agh serve`: register a scheduled task that starts it when the service user signs in,
here from an elevated PowerShell. The task runs the daemon in that user's session, with that user's profile:

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\agh.cmd' -Argument 'serve' -WorkingDirectory 'C:\Superagent'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'superagent'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'AGH Superagent' -Action $action -Trigger $trigger -Settings $settings -User 'superagent'
[Environment]::SetEnvironmentVariable('AGH_HOME', 'C:\Superagent\agh', 'User')   # as the service user
```

Name the `agh` your installation provides in `-Execute`. Set `AGH_HOME` as a user variable of the service user (run the
last line signed in as that user), so the task and every terminal of that user reach the same home; the user's `Path`
must reach `node`, `git` and `gh`. On Windows, leave `stateDir` unset: Superagent keeps its state in the directory the
platform gives it, which only the current user can open, and refuses a `stateDir` outside it. Stop the daemon with
`agh daemon stop` as that user: ending the task (`Stop-ScheduledTask`) kills the process without letting the sessions
end their turns.

### Linux (systemd)

`/etc/systemd/system/superagent.service`, started with `systemctl enable --now superagent`:

```ini
[Unit]
Description=AGH with Superagent
After=network-online.target
Wants=network-online.target

[Service]
User=superagent
WorkingDirectory=/srv/superagent
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=AGH_HOME=/srv/superagent/agh
ExecStart=/usr/local/bin/agh serve
Restart=on-failure
KillMode=mixed
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Stop the service through its manager (`launchctl bootout`, `systemctl stop`), or on Windows with `agh daemon stop`:
the daemon then ends its sessions' turns cleanly. A restart is safe at any time: see [Restart and recovery](#restart-and-recovery).

**Set up the earlier way.** An installation whose unit starts the daemon with `HOME=<stateDir>/home` and
`<stateDir>/worker-bin` first on `PATH`, and whose GitHub card names `gh`, keeps working: that `gh` still reads the login
in `<stateDir>/home/.config/gh`. To move to the setup above, make the `gh-agent` wrapper with
`GH_CONFIG_DIR=<stateDir>/home/.config/gh`, which keeps that login, save it as the CLI on the GitHub card, then remove
`HOME` and the shims from the unit and restart. Superagent gives its existing sessions the agent's environment the next
time it opens them.

## Settings and first use

Open the **Superagent** entry on the AGH home page and save, in order, the Sources (repository and the agent's GitHub
CLI, `/srv/superagent/bin/gh-agent`; the bot CLI wrapper path if Feishu is used), the Policy (who may ask), the Execution settings (the ticket directory root and
the prepare command, for example `git clone "https://github.com/<owner>/<name>.git" repo`) and the team prompt sections.
The [setup guide](../../packages/superagent/docs/setup.md) explains each field. On a fresh install the overview reports
that the GitHub Source names no repository: the **Source** settings list GitHub from the first start, and once its
repository and CLI are saved, setup goes on by itself, without a restart. Then, from an allowed account, comment
`@<agent login> <request>` on an Issue: a ticket appears on the overview within about a minute.

For Feishu, enter the absolute path of an already authenticated lark-cli wrapper in **Sources → Feishu → Bot CLI path**.
Its strict-mode must be `bot`. Saving verifies and displays the app/bot identity. Configure the chat list,
mention policy, direct messages and **Policy** requester allowlist, then enable the Source. No AGH Feishu plugin,
channel instance or claim is required. The backend owns CLI events, context reads, image downloads and replies;
workers use `orchestrator_feishu_read` scoped to their ticket's bot, chats and topics.

Old instance settings retain chat policies and allowlists but require a CLI path. Existing tickets and message dedupe
records are kept. Work without a verified bot identity, or belonging to another bot, cannot read or reply through the
new bot; initiate a new request instead. Restart recovery uses bot-scoped cursors. A timeout/crash with unknown reply
outcome leaves its receipt pending for operator reconciliation; it is not silently resent. The panel has no override
for that state. Coordinate real-bot validation and consumer handover separately from synthetic CLI tests.

In the Web sidebar each ticket session is titled `Worker · <ticket title>` and sits under its ticket directory's project;
the main session keeps its own name, and a ticket's link still opens its session. What Superagent delivers into its
sessions, such as an assignment, a relayed report or a Feishu message, shows as a collapsed line saying an app delivered
it, not as text a person typed; expand it to read what was delivered. Only the display changes: the model reads it, and
it waits in the session's queue, exactly as before. Limitation: only sessions Superagent creates from this release on are
marked, so a main session created earlier keeps showing its deliveries as messages, also after it is deleted and created
again; the same text typed or pasted by a person always stays an ordinary message.

## Disable

Disable the plugin under **Plugins**, or use **Pause processing** in the panel to stop new work while it keeps running.
Disabling stops polling and sending, cancels every running turn of Superagent's sessions, kills their background jobs
within a few seconds, and records the running assignments as paused. Sessions, ticket directories and the state
directory stay. Enabling again reads each session's real state: work still running is left alone, an interrupted
assignment is dispatched again with a recovery note, and a message that waited in a session's queue runs once.

Installing, updating, enabling or disabling any other plugin in Superagent's AGH home restarts Superagent in the same way:
it stops as described here and starts again at once. See [Restart and recovery](#restart-and-recovery).

## Clear data

Only the owner clears data, explicitly; disabling never does. To remove everything:

1. Disable the plugin, then uninstall it under **Plugins**.
2. Delete the state directory (`/srv/superagent/state`, or the `bundled-apps/<hash>` directory the panel named). This
   removes the database and every ticket directory with any branch that was not pushed. The agent's GitHub login stays
   in the wrapper's configuration directory (`/srv/superagent/gh-agent`); delete it and the wrapper too, or sign the
   agent out with `gh-agent auth logout`.
3. Delete the sessions you no longer want: the main session `superagent:orchestrator` and the ticket sessions
   `superagent:worker:<ticket id>`.
4. Delete the skills Superagent wrote into the AGH home: the `dsh-superagent-*` directories under `<AGH_HOME>/skills`.

The pushed branches and the pull requests stay on GitHub; remove them there.

## Security boundaries

Superagent keeps the boundaries of its origin: the allowed lists and each ticket's mandate (policy version, scope,
strength), a dedicated GitHub account and Feishu bot, branch protection that requires a person's approval, and an AGH
home of its own. Prompts are not a boundary, and text from GitHub or Feishu is material only: it cannot change a ticket's
directory, its bundle or its permissions.

**The main session can change the settings.** As in the original, the main session has a tool,
`orchestrator_settings_save`, that saves a settings block when a person asks for it in a conversation: the Policy (the
allowed lists and rules), the Eval settings, the Execution settings including the prepare command, a Source, or the
pause. Whether such a request is genuine is the model's judgement, not a check in code. A main session misled by text in
an Issue or a chat, or asked by an allowed person, could therefore add someone to an allowed list, or change the prepare
command, which Superagent then runs for each new ticket. The allowed lists keep out people who are not on them; they do
not hold against an allowed person or against text the main session reads. What limits this:

- Every save keeps a version. The history on the panel's Eval, Execution and Source pages marks each save the main
  session made as **Main Session tool**; review those saves, and correct them in the panel.
- Keep the allowed lists short, and run Superagent as a dedicated operating-system user (below), so a changed prepare
  command reaches only the agent's own account.

Ticket sessions run with full access. That means:

- They can read the operator's home by absolute path, including the keys and the socket of the operator's everyday AGH
  home, and the agent's own login in the wrapper's configuration directory. The agent's environment changes which
  identity git and `gh` use, not what a session can reach.
- In Superagent's AGH home, full access lifts the soft bans on the data directory: `tables`, `audit` and `sessions.db`
  can be read and written. Only `secrets` and the private state root under the data directory stay forbidden.
  Superagent's own SQLite database can be read and written by its sessions.
- Under the same system user, a session can very likely connect to the daemon's local socket on its own and act with
  the owner's rights: local authentication checks only who owns the socket. Not handing the owner-level client to
  sessions is therefore not a boundary.

All of these are addressed only by running this AGH as a dedicated operating-system user, which is strongly recommended
and not enforced.

**On Windows, `gh` is a batch file.** The sessions' shell is PowerShell, and `gh` reaches the agent's CLI through
Superagent's `gh.cmd` shim. `cmd.exe`, which runs a batch file, reads its arguments again: it cuts an argument at a line
break, and runs what follows a quote and `&` or `|` as a command, whatever the PowerShell quoting. A worker that copied
an issue title or a comment onto `gh`'s command line could thus run a command written by whoever wrote that text. The
Windows sessions are told to pass text from people to `gh` in a file or on standard input (`--body-file`, `-F
title=@<file>`). Superagent's own commands do so too: they escape every argument for `cmd.exe`, quotes included, and
refuse a line break in an argument to a batch file. The prompt is not a boundary. Blocked commands, too, cover only programs found on PATH: in Windows PowerShell 5.1,
`curl` and `wget` are aliases of `Invoke-WebRequest` and are not blocked.

## Restart and recovery

- **Daemon restart.** Running turns end as aborted and their jobs stop with the daemon. On start Superagent writes and
  checks the agent environment, then reconciles each of its sessions by its real state: a turn still running is left
  alone; an interrupted assignment is dispatched again once with a recovery note; the oldest message waiting in a
  session's queue is started, since nothing resumes it after a restart.
- **A plugin change in this AGH home.** Installing, updating, enabling or disabling any plugin in Superagent's AGH home,
  not only Superagent itself, restarts Superagent. Every running ticket is interrupted: its turn is cancelled and its
  jobs are stopped, so a `git push` or a test run in progress is cut off. Once Superagent is back, the interrupted
  tickets resume as after a daemon restart: each interrupted assignment is dispatched again with a recovery note.
  Change plugins in this home when the overview shows no ticket running.
- **Superagent code upgrades.** Before accepting work, the published service moves its registered main session and
  resumable ticket sessions to its exact payload, including completed tickets a person's reply can reopen and updates
  that keep the same version number. Tickets stopped by a person or retired by retention keep their bindings. Only sessions
  whose code differs are closed and migrated; an ordinary restart keeps current bindings. Other sessions keep their pins.
  Busy sessions or unsettled effects leave startup paused and are retried; **Check again** retries after the cause is
  resolved. This requires the daemon shipped with this Superagent update.
- **Unknown tool outcomes.** An upgrade does not discard history or replay an uncertain call. Migration can recognize a
  formal human answer to that exact call only after Core consumed the answer and recorded its checkpoint; system or
  agent answers do not qualify. This is a person's reconciliation, not proof that the system observed the effect.
  Unanswered or unrelated unknown outcomes continue to block migration.
- **Stored work.** Every outward action (a reply, a launch, a delivery) is stored before it runs and removed only once it
  succeeded, and retried with backoff. While processing is paused, Sources keep recording.
- **A delivery whose outcome is unknown** is looked up by its command id; when that cannot be confirmed it is recorded as
  undelivered for a person, and never sent again or under another id.
- **A ticket session the owner archived** fails its assignment for a person to decide; no other session is opened behind
  your back. **One the owner deleted** is opened again under the same key and given its whole assignment again; if that
  fails, the assignment fails with the reason.
- **Model and GitHub failures.** A turn that fails for a rate limit or a server error is resumed after 15, 30 and 60
  seconds; a fourth failure in a row fails the assignment for a person. A GitHub read that times out or fails is read
  again on the next poll. A prepare command that fails fails the ticket and is not run again.

## Troubleshooting

The panel's overview shows setup problems with a link to the setting that fixes them; **Check again** runs the checks
again after you fixed something outside the panel.

| Problem | Fix |
| --- | --- |
| `The GitHub Source names no repository.` | Open **Settings → Source**, enter the repository (`owner/name`) and the agent's GitHub CLI on the GitHub card, and save; setup goes on without a restart |
| The panel says it cannot connect to Superagent, and its calls return `CAPABILITY_DENIED` | Install from the marketplace; a local-path install has no privileged grant. A folder path installs a `local-source` package, which never receives the bundled-app grant Superagent runs with; this is intended. Uninstall it, then install from **Plugins → Marketplace** or with `agh plugins add file:./bundled-plugins/superagent` |
| `agh package add @agnes/superagent` is refused | A package name is not a source. Install from the marketplace, or with `agh plugins add file:./bundled-plugins/superagent` |
| The first `agh serve` refuses the home with `E_HOME_VERSION` | Something was created under the fresh `AGH_HOME` before its first start, such as a log file. Remove it, start again, and write the log outside the home |
| `git would sign in to github.com with …/.netrc, not with the agent's GitHub CLI` | Remove the file's `machine github.com` or `default` entry, or run the service as a user without one; then select **Check again** |
| `The agent GitHub CLI … is in …/worker-bin, which Superagent writes` | The GitHub card names the shim Superagent writes, not the CLI it runs. Name the `gh-agent` wrapper instead |
| `git would ask other credential helpers than the agent's for github.com` | A helper was added to `<stateDir>/worker-gitconfig`, which Superagent rewrites on its next start: select **Check again**. Otherwise the agent's git is older than 2.32 |
| `The agent's GitHub token cannot read notifications; …` | The agent is signed in with a fine-grained token, which GitHub's notifications API refuses. Sign in again with `gh-agent auth login` through the browser, or with a classic token with the `repo` and `notifications` scopes, as in step 4 |
| `gh acts as @…, not the agent account @…` | Sign in again with `gh-agent auth login`, as in step 4 |
| `The agent's GitHub token for @… is in the macOS keychain, …`, or on macOS the agent's `gh` acts signed out in ticket sessions while `gh-agent auth status` shows `(keyring)` | Sessions run inside the macOS sandbox, which cannot read the keychain. Sign in again with `gh-agent auth login --insecure-storage` (a classic token: `--with-token --insecure-storage`), as in step 4 |
| `The agent GitHub CLI was not found.` | Set the absolute path of the `gh-agent` wrapper on the GitHub Source, and make the `gh` it runs reachable on the unit's `PATH` |
| `The agent GitHub CLI cannot read its account.` | The wrapper is not signed in: run `gh-agent auth login`, as in step 4 |
| A file `… was not written by Superagent` | Move it out of `<stateDir>/worker-bin`, or move `<stateDir>/worker-gitconfig` away, or choose another state directory |
| `A session superagent:… exists that Superagent did not open` | Archive or remove that session, which is not Superagent's, then select **Check again** |
| A ticket fails with the prepare command's output | Fix the command in Execution, then retry the ticket |
| The `deliveries` health names a ticket | A relaunch keeps waiting to confirm whether a session got a message; check that the daemon answers, then retry the ticket |
| The `relay` health names a ticket or a trigger | A relay to the main session keeps failing, usually because whether the session got it cannot be confirmed, and later relays wait behind it. It is tried again with backoff and goes through once the daemon confirms it. If it stays stuck, restart the service ([Run as a service](#run-as-a-service)): the relay is then confirmed or sent under its own id, once. The ticket's **Stop** and **Retry** in the panel do not release it: Stop ends the ticket's assignment and withdraws its mandate, so later messages on its threads no longer resume it; Retry (offered when the worker failed, is blocked or an input was not delivered) ends the current assignment and starts a new one under the same mandate |
| Nothing happens after a mention | Check that the author is on the allowed list, the Source is on and processing is not paused |
