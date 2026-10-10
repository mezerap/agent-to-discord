# Agent to Discord

Control your Codex agent through Discord. A small, standalone Node.js bridge: each new request creates a Discord thread that remembers its Codex conversation, even after a restart.

Inspired by [Agent2Telegram](https://github.com/petrludwig-collab/Agent2Telegram). This is an independent implementation for Discord using the [Codex app-server](https://developers.openai.com/codex/app-server/), without tmux or terminal screen parsing.

## Features

- A new request in the designated channel creates a new Discord thread and Codex conversation.
- Follow-up messages in the thread continue the same conversation.
- Agent messages and final status, with long responses split to fit Discord's message limit.
- Slash commands `/help`, `/status`, `/stop`, `/file`, and `/answer` in Discord's command menu. The bot's command descriptions and user-facing messages are currently in Czech.
- A native typing indicator during work instead of separate “Working…” and “Done” messages.
- Buttons to approve or reject a specific command or set of file changes, with full details in a JSON attachment. Requests are rejected after 10 minutes without a response.
- Answers to structured questions through `/answer` or `!answer`, using plain text for one question or the provided JSON template for multiple questions.
- Incoming files and images, saved under `discord-uploads/` in the workspace. The bridge imposes no attachment count or file size limit; Discord's own limits still apply to uploads and downloads.
- Explicit downloads of output files through `/file` or `!file path`.
- One authorized user, server, and channel. Automatic user and role mentions are disabled.
- Persistent conversation mapping, duplicate message protection, and connection diagnostics.
- Deleting a Discord thread interrupts the running task, rejects pending approvals, and archives the Codex conversation. Tracked archives are permanently deleted after 90 days; files in the workspace are preserved.

Version 0.1 is intended for a personal agent. Voice, multiple users, task scheduling, and connections to arbitrary existing terminals are not implemented. While a task is running, the bot rejects new requests; it does not maintain a queue. It does not allow general permission expansion requests or MCP forms. If the command or file changes cannot be displayed, the approval button remains disabled.

## Requirements

- Node.js 22.12+ and `ps` (the `procps` package on Debian).
- Codex CLI installed and signed in. The integration has been verified with version **0.162.1**; the app-server interface may change between versions.
- A Discord bot with **Message Content Intent** enabled under Developer Portal → Bot.
- The bot added to your server with **View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files** permissions in the designated text channel. Administrator permission is not required.
- Outbound HTTPS/WebSocket connections to Discord and OpenAI. No inbound port or public webhook is needed.

## Installation

The package can be installed directly from GitHub without being published to the npm registry:

```sh
npm install --global git+https://github.com/mezerap/agent-to-discord.git#v0.1.4
agent-to-discord setup
agent-to-discord doctor
agent-to-discord start
```

`start` runs in the foreground; use Docker or a service manager for continuous operation. If you cannot write to the global npm directory, use a custom prefix—see the Docker instructions below.

Alternatively, clone the source repository:

```sh
git clone https://github.com/mezerap/agent-to-discord.git
cd agent-to-discord
npm ci --ignore-scripts
node src/cli.js setup
```

The setup wizard asks for the channel, user, workspace, and bot token. Token input is hidden. It verifies channel access, detects the server, and creates `$CODEX_HOME/agent-to-discord/.env` with private file permissions. If `CODEX_HOME` is not set, it uses `~/.codex/agent-to-discord/.env`. It does not overwrite an existing file. Do not send the token in chat or include it in your command history. To find Discord IDs, enable Developer Mode and use Copy ID.

```sh
node src/cli.js doctor
node src/cli.js start
```

`doctor` checks your Codex login, Discord connection, and channel permissions. It does not send messages. To verify that text messages are actually received, send a message to the channel as the authorized user. To make the command available globally from a cloned repository, run `npm install -g .`, then `agent-to-discord start --env-file /path/.env`.

Configuration in `.env.example`:

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Secret bot token |
| `DISCORD_GUILD_ID` | Authorized Discord server |
| `DISCORD_CHANNEL_ID` | Parent text channel |
| `DISCORD_USER_ID` | The only user allowed to control the agent |
| `AGENT_WORKSPACE` | Workspace directory; defaults to the current directory |
| `AGENT_STATE_DIR` | Persistent bridge state; defaults to `$CODEX_HOME/agent-to-discord` |
| `CODEX_BIN` | Optional CLI path; defaults to `codex` |
| `CODEX_MODEL` | Optional model; otherwise uses the Codex configuration |

## Usage

Send a message such as “Create a simple HTML page” in the authorized channel. The bot creates a thread. Send follow-up requests in that thread; a new message in the parent channel starts a new conversation.

Type `/` and select a command from this bot. Commands are registered automatically for the configured Discord server at startup. Their results are visible only to you, including files requested through `/file`. The original `!` commands still work and reply publicly in the channel. Submit tasks as ordinary messages. Commands enforce the same user, server, and channel restrictions as messages.

| Slash command | Original syntax | Behavior |
| --- | --- | --- |
| `/help` | `!help` | Help with tasks, threads, files, and commands |
| `/status` | `!status` | Retrieve the latest task's actual status and, when available, its latest response |
| `/stop` | `!stop` | Request interruption of the running task |
| `/file cesta:web/index.html` | `!file web/index.html` | Send a specific file from the workspace |
| `/answer odpoved:yes` | `!answer yes` | Answer one pending question with plain text; for multiple questions, use JSON matching the provided template |

Starting with version 0.1.4, the former bridge limits of 5 attachments and 8 MiB per file are removed, including the size cap on `/file` and `!file` exports. Incoming attachments are streamed to disk. Actual transfers remain subject to Discord limits, available server resources, and network timeouts. File path and access checks are unchanged.

The slash option names `cesta` (path) and `odpoved` (answer) match the bot's registered commands; enter them as shown.

The typing indicator refreshes every 8 seconds. It pauses while waiting for approval or an answer and resumes after your response. Once work finishes, it stops refreshing and the agent's response remains. Discord has no separate command to turn the indicator off, so it may linger briefly, for approximately 10 seconds after the last signal at most. Errors and interrupted tasks are still reported as messages.

If commands do not appear in the menu, reopen Discord and check the **Use Application Commands** permission for your account in that channel. The bot must be installed with the `applications.commands` scope, which Discord normally includes automatically with the `bot` scope.

After a restart, an unfinished task **is not started again**. Use `!status` to check its state and decide whether to submit more work. Messages sent while the bot is completely offline are not retrieved later. If Discord fails to deliver a response, `!status` retrieves it from Codex history. Exactly-once delivery of network operations cannot be guaranteed; the bot never automatically retries a task when its outcome is uncertain.

### Deleting a thread

When a Discord thread is deleted, the bot blocks further requests and approvals in that conversation, asks Codex to stop the active task, and archives its history once the stop is confirmed. It removes the Discord mapping only after successful archival. Generated files are preserved, and changes already made are not rolled back.

Threads deleted while the bot was offline are checked at startup and on reconnection. This check also runs every 5 minutes. Archiving or automatically closing a Discord thread does not count as deletion and preserves the conversation. Network failures and revoked permissions are not treated as deletion. If cleanup fails, it remains saved as pending, and the bot retries every 10 seconds, including after a restart.

### Automatic history cleanup after 90 days

Starting with version 0.1.3, conversation history associated with **deleted Discord threads is permanently deleted after 90 days**, measured from when the bot detected the deletion. If the bot was offline, the period starts only after it starts up and confirms the deletion. Merely closing or archiving a Discord thread does not start this period.

The timestamp is stored in the bridge's persistent state and survives restarts. Cleanup runs at startup and every hour. It uses the Codex `thread/delete` API rather than manually deleting internal files. It deletes only tracked conversations that are still archived and not running; failures are retried at the next check. If the bridge detects that a conversation has been restored in Codex, it cancels automatic deletion for that conversation.

**Permanent history deletion cannot be undone.** This cleanup does not delete projects, attachments saved in the workspace, login credentials, configuration, or other conversations. It does not impose a total disk usage limit or delete backups or all operational logs. The terminal command `agent-to-discord status` shows the number of archives awaiting deletion.

Archives created before version 0.1.3 are not automatically adopted: the bridge no longer has a reliable mapping to the deleted Discord thread or its deletion timestamp. Retain `state.json` for this cleanup to work; if it is lost, the bot does not guess which archives to delete based on age.

## Docker and persistent data

In an existing container, you can install the package into a volume as the `node` user:

```sh
npm install --global --prefix /home/node/.codex git+https://github.com/mezerap/agent-to-discord.git#v0.1.4
/home/node/.codex/bin/agent-to-discord setup
/home/node/.codex/bin/agent-to-discord doctor
/home/node/.codex/bin/agent-to-discord start
```

The installation and configuration will survive container recreation as long as you retain the `/home/node/.codex` volume. To start this installation automatically, replace `sleep infinity` in your Compose configuration with:

```yaml
command: ["/home/node/.codex/bin/agent-to-discord", "start"]
```

Make this change only after installation and a successful `doctor` check. Stop any manually started bot before applying the Compose configuration. `restart: unless-stopped` restarts the container after a crash or restart; running the bot through `docker exec` alone does not provide this behavior. Reinstall the package when changing the Node.js major version or architecture.

The bot runs in the same container as Codex under the regular `node` user. It starts its own `codex app-server --stdio`, using the same `CODEX_HOME` and login. It does not modify or update the separate CLI daemon. Each Discord thread gets a new Codex conversation; it does not share your currently open interactive session.

As an alternative to installing into a volume, you can build the package into the image: add the source repository, run `npm ci --omit=dev --ignore-scripts`, and set the container's main command, for example:

```yaml
command:
  - node
  - /opt/agent-to-discord/src/cli.js
  - start
  - --env-file
  - /home/node/.codex/agent-to-discord/.env
```

Keep your existing named volumes for `/workspace` and `/home/node/.codex`. Store the bot's configuration and state in the second volume, and build the source code into the image outside the workspace. The recommended settings remain `user: node`, `init: true`, and `restart: unless-stopped`, without a Docker socket or privileged mode. Installing this project does not change capabilities, AppArmor, or seccomp; the host must support the Codex sandbox.

If the bridge crashes, its process exits and the container stops; Docker restarts it according to the restart policy. Back up both volumes. A volume protects against container recreation, not disk failure or data deletion.

## Permissions and privacy

Codex uses `workspace-write` and `on-request` approvals, with the user as the approver. The bot does not automatically enable full access or approval without prompting. A one-time command approval may allow an action outside the inner sandbox; user permissions and Docker restrictions still apply. Each button is tied to a specific account, Discord thread, and active task.

The token is not passed to the Codex child process's environment. However, this does not fully isolate secrets: depending on the system, processes running under the same Unix user may be able to read each other's files or environment. The workspace, configuration, and agent are not separate security containers. Do not store the token in the workspace. The bot does not write task content to operational logs; history is stored in Codex and Discord, subject to thread deletion and the retention policy described above.

Conversation text and explicitly requested files are sent to Discord. Hidden files, common authentication files, and paths outside the workspace cannot be exported through `!file`; this check does not identify every possible secret. Request a file only when you intend to share it.

## Development

```sh
npm ci --ignore-scripts
npm test
npm audit
```

Tests cover authorization, duplicate messages, restarts, files, approvals, task errors, RPC disconnections, slash commands, typing indicators, thread deletion, and archive retention. Integration testing requires a signed-in Codex instance and your own Discord bot. CI tests do not use production tokens.

MIT license. An unofficial project; not a product of OpenAI or Discord.
