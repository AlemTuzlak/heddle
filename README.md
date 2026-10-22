# heddle

heddle is a coding agent in your terminal. You give it a task in a project folder, and you see each step while it works:

- The session pane shows each step in a timeline. A subagent shows as a branch.
- The changes pane shows the live diff of each file that the agent changes.
- A command waits for your approval before it runs.

You can quit at any time and continue the session later. The agent can also work in a Docker sandbox, and it can use MCP servers such as Linear and Notion.

## Install

You need these on your computer:

- Bun 1.4.2. Bun runs heddle.
- pnpm 11.9.0. pnpm installs the packages.
- The TanStack AI worktree at `F:/worktrees/ai/t3-fdfd3164`, with its packages built.

heddle gets the harness packages from that worktree through `link:` dependencies. The links are relative paths, so keep heddle at `F:/projects/heddle`.

1. Install the packages:

   ```sh
   pnpm --dir F:/projects/heddle install
   ```

   Do not use `bun install`. It cannot resolve the `link:` dependencies.

2. Make sure that heddle runs:

   ```sh
   bun F:/projects/heddle/src/main.tsx --version
   ```

   It prints `heddle 0.1.0`.

heddle loads the `dist/` folder of each linked package. After you change a package in the worktree, build that package again.

## Start

1. Open a terminal in your project folder.
2. Start heddle:

   ```sh
   bun F:/projects/heddle/src/main.tsx
   ```

3. Type a task, and press `enter`.

If the header shows `no key`, add an API key first. See [Models and API keys](#models-and-api-keys).

heddle works on the folder where you start it. It also gives the agent the `AGENTS.md` and `CLAUDE.md` files of your project.

A `heddle` command on your PATH is not set up yet. Put the flags after `bun F:/projects/heddle/src/main.tsx`:

| Flag | What it does |
| --- | --- |
| (none) | Start a new session. |
| `-c`, `--continue` | Continue the newest session of this folder. If the folder has no session, start a new one. |
| `-r`, `--resume` | Open the newest session, and show the session picker over it. |
| `--sandbox` | Run the tools of a new session in a Docker sandbox. See [Docker sandbox](#docker-sandbox). |

`-h` (`--help`) shows the help, and `-v` (`--version`) shows the version.

Bun loads the `.env` file of the folder where you start heddle. To load your keys from another file, give its path:

```sh
bun --env-file="$HOME/keys.env" F:/projects/heddle/src/main.tsx
```

## The screen

```text
◆ heddle  Fix the failing add test     opus  build  docker synced  ▰▰▰▰▱▱▱▱▱▱ 41%  $0.38
╭ session ─────────────────────────────╮ ╭ changes ────────────────────────────────────╮
│ ●  you                               │ │ ▎ src/math.mjs                   ▮▮   +1 −1 │
│ │  The add test fails. Fix it, and   │ │   test/math.test.mjs             ▮▮▮  +6 −0 │
│ │  run the tests.                    │ │ ─────────────────────────────────────────── │
│ │                                    │ │ src/math.mjs          patch 1 of 1  updated │
│ ●  opus   I will read the code.      │ │ 1   /** Add two numbers. */                 │
│ │  ◇ program   read 2 files     0.6s │ │ 2   export function add(a, b) {             │
│ ├─╮                                  │ │ 3 -   return a - b                          │
│ │ ●  explore   who calls add()?      │ │ 3 +   return a + b                          │
│ │ │  ◇ grep    "add(" in src    0.2s │ │ 4   }                                       │
│ │ ●  explore   1 caller, no change   │ │                                             │
│ ├─╯                                  │ │                                             │
│ │  ◆ edit      src/math.mjs   +1 −1  │ │                                             │
│ │  ◆ bash      node --test           │ │                                             │
│ │              ⠼ needs you           │ │                                             │
│ ┊                                    │ │                                             │
╰──────────────────────────────────────╯ ╰─────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ bash wants to run  node --test                 y once   a always   n no, and say why │
╰──────────────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ › Ask heddle, or type / for a command                                                │
╰──────────────────────────────────────────────────────────────────────────────────────╯
tab next pane   ctrl+o sessions   ctrl+k commands
```

From the top:

| Part | What it shows |
| --- | --- |
| Header | The session title, the model and the agent, `local` or `docker` with the sync state, the context meter, and the cost. While a goal runs, it also shows the goal. `no key` shows when the model has no API key. |
| Session pane | The timeline. `●` starts a message. `◇` is a tool that reads, and `◆` is a tool that writes. A subagent branches off at `├─╮` and comes back at `├─╯`. |
| Changes pane | The files that the session changed, with their `+` and `−` line counts. Under them is the diff of one file. |
| Approval bar | A question from heddle. It shows only while heddle waits for your answer. |
| Input and key hints | You type here. The last row shows the keys that work now. |

If the terminal is less than 100 columns wide, heddle shows one pane at a time. Press `tab` to switch.

## Keys

These keys work everywhere:

| Key | What it does |
| --- | --- |
| `tab` | Go to the next part: the session pane, the changes pane, then the input. |
| `esc` | Stop the turn that runs. If the right pane shows a subagent, go back to the changes. |
| `ctrl+o` | Open or close the session picker. |
| `ctrl+k` | Open or close the command palette. |
| `ctrl+c` two times | Quit. Press it two times in 1 second. |

In the input:

| Key | What it does |
| --- | --- |
| `enter` | Send. |
| `shift+enter` or `ctrl+j` | Add a line. |
| `/` | Show the commands that start with what you type. |
| `↑` `↓`, then `enter` | Pick a command, and put it in the input. A second `enter` runs it. `tab` also puts it in the input. |
| `esc` | Close the list of commands. |

When heddle asks for approval:

| Key | What it does |
| --- | --- |
| `y` | Yes, one time. |
| `a` | Yes, always. heddle saves a rule for this project, and does not ask again for this command or path. |
| `n` | No. Type the reason, and press `enter`. `esc` goes back to the keys. |

For a question with choices, press the key of a choice. For a text question, type the answer and press `enter`. A secret, such as an API key, shows as dots. `/permissions` lists the rules that `a` saved.

In the session pane:

| Key | What it does |
| --- | --- |
| `↑` `↓` | Select a row. |
| `pageup` `pagedown` `home` `end` | Scroll. |
| `enter` on a subagent row | Show the transcript of that subagent in the right pane. `esc` goes back. |

In the changes pane:

| Key | What it does |
| --- | --- |
| `↑` `↓` | Pick a file. The pane then stays on that file. |
| `[` | Show the older patch of the file. |
| `]` | Show the newer patch of the file. |
| `f` | Follow the newest change again. |

The diff shows one patch at a time. The mouse wheel scrolls it.

## Commands

Type `/` in the input to see the commands, or press `ctrl+k`. `/help` lists them all in the timeline.

heddle has these commands of its own:

| Command | What it does |
| --- | --- |
| `/sessions` | Open the session picker. |
| `/new` | Start a new session. |
| `/quit` or `/exit` | Quit heddle. |
| `/help` | List the commands. |

The agent has more commands. You use these the most:

| Command | What it does |
| --- | --- |
| `/model <name>` | Use another model from the next turn. See [Models and API keys](#models-and-api-keys). |
| `/agent plan` | Use the plan agent. It reads and searches, and it does not change files. `/agent build` goes back. |
| `/goal <text>` | Work until the goal is met. `/goal stop` stops it. |
| `/undo` | Undo the last turn: its file changes and its messages. `/redo` brings them back. |
| `/mode <mode>` | Set the permission mode: `default`, `plan`, `acceptEdits`, or `bypass`. `acceptEdits` does not ask for edits. `bypass` does not ask at all. |

The list of commands also shows the others, such as `/compact` and `/usage`.

## Models and API keys

heddle needs an API key for the provider of the model. Without a key, the header shows `no key`. When you send, heddle shows this row, and it does not send:

```text
No API key for anthropic. Type /connect anthropic, or set ANTHROPIC_API_KEY.
```

Give heddle a key in one of two ways:

- Type `/connect anthropic`, `/connect openai`, or `/connect grok`. Paste the key, and press `enter`. heddle keeps the key for all your projects.
- Set the environment variable of the provider before you start heddle.

| Provider | `/model` names (model ids) | `/connect` | Environment variable |
| --- | --- | --- | --- |
| Anthropic | `opus` (`claude-opus-5-5`), `sonnet` (`claude-sonnet-5-5`), `haiku` (`claude-haiku-5-5`) | `/connect anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt` (`gpt-6.1-sol`), `luna` (`gpt-6-luna`) | `/connect openai` | `OPENAI_API_KEY` |
| xAI | `grok` (`grok-4.7`) | `/connect grok` | `XAI_API_KEY` |

- A new session uses `opus`. To use another model, set `model` in a [config file](#config-files).
- `/model` shows the model of the session. `/model sonnet` uses `sonnet` from the next turn.
- `/keys` shows where each key comes from. `/disconnect <provider>` removes a saved key.
- heddle uses a small model for titles, for the summaries of `/compact`, and for goal checks. It is `haiku`, `luna`, or `grok`: the small model of the provider of the `model` in your config. If you have only an OpenAI key or an xAI key, set `model` in a config file.

## Config files

Put your model, your sandbox, and your MCP servers in a config file. Then heddle uses them each time it starts. heddle reads two files, and both are optional:

| File | For |
| --- | --- |
| `~/.heddle/config.json` | All your projects. |
| `<project>/.heddle/config.json` | One project. Its fields win over the fields of the home file. |

The `mcp` servers merge by name. A project server replaces a home server with the same name.

```json
{
  "model": "sonnet",
  "sandbox": { "image": "node:24" },
  "codeMode": { "directCalls": "keep" },
  "mcp": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "oauth": true }
  }
}
```

| Field | Values | Default |
| --- | --- | --- |
| `model` | A `/model` name, such as `"sonnet"`. A model id also works. | `"opus"` |
| `sandbox` | `false`: the tools work in your folder. `true`: the tools work in a Docker container of `node:24`. `{ "image": "<image>" }`: a container of that image. | `false` |
| `codeMode` | `true`, `{ "directCalls": "keep" }`, `{ "directCalls": "remove" }`, or `false`. See below. | `{ "directCalls": "keep" }` |
| `mcp` | The MCP servers, by name. See [MCP servers](#mcp-servers). | `{}` |

With code mode, the model can write a program that calls the file tools: `read_file`, `list_files`, `grep`, `edit_file`, `write_file`, and `patch`. A program shows as one `program` row in the timeline.

- `"keep"`: the model can also call these tools directly. `true` is the same.
- `"remove"`: only a program can call these tools.
- `false`: no code mode.

If a config file has bad JSON, an unknown field, or a wrong value, heddle does not start. It prints the file and the field:

```text
heddle could not start: C:\Users\you\.heddle\config.json: codeMode must be true, false, or an object
```

## Docker sandbox

If the agent must not run commands on your computer, use the sandbox. The agent then works in a Docker container, on a copy of your folder. Each file that it changes comes back to your folder.

You need:

- Docker, and it must run.
- Your project folder as a git repository. If it is not one, run `git init` in it.
- git on your PATH. heddle uses it to find the files to copy.
- An image with git. The default image, `node:24`, has git.

Start a session in the sandbox:

```sh
bun F:/projects/heddle/src/main.tsx --sandbox
```

You can also set `"sandbox": true` in a config file. The header then shows `docker` and the sync state.

### What goes in

heddle copies the files that git lists into the container, at `/workspace`. These are the tracked files, and the untracked files that `.gitignore` does not ignore. The history of the current branch goes in too. Ignored files, such as `node_modules`, stay out.

### What comes back

- Each file that the agent makes, changes, deletes, or moves comes back to the same path in your folder. This includes the files that a `bash` command changes.
- The sync goes one way. A change that you make in your folder does not go into the container.
- The sandbox never writes into `.git`, outside your folder, or through a link. A commit that the agent makes in the container stays there. The file changes of the commit still come back.

The header shows the sync state:

| State | What it means |
| --- | --- |
| `starting` | heddle makes or starts the container. |
| `synced` | Your folder has each change. |
| `syncing` | heddle copies a file to your folder. |
| `conflict` | A file changed in your folder and in the container. |
| `stopped` | The container stopped, or it did not start. |

### Conflicts

If you change a file in your folder, and the agent then changes it in the container, the sandbox copy writes over your change. The last write wins. heddle shows a row like this, and the header shows `conflict`:

```text
Sync: src/math.mjs changed here and in the sandbox. The sandbox copy won.
```

### Stop and resume

- When you quit, heddle waits for the copies to end. Then it stops the container. Docker keeps it.
- When you open the session again, heddle starts the same container again. Use `-c`, `-r`, or `ctrl+o`.
- A session keeps its place. `--sandbox` changes only where a new session runs.
- If you remove the container in Docker, the tools of its session cannot work. Start a new session.
- If Docker does not run, each tool call shows `Docker is not running. Start Docker Desktop, or run heddle without --sandbox.`

## MCP servers

If you want the agent to read your Linear issues or your Notion pages, add MCP servers. Put them in `mcp` in a config file.

Linear and Notion use an OAuth sign-in:

```json
{
  "mcp": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "oauth": true },
    "notion": { "type": "http", "url": "https://mcp.notion.com/mcp", "oauth": true }
  }
}
```

1. Start heddle.
2. Type `/connect linear`.
3. Sign in on the page that heddle opens in your browser.
4. Type `/mcp`. It shows each server and its status.

After the sign-in, the agent gets the tools of the server. Each tool that the server does not mark as read-only asks for your approval first. `/disconnect linear` signs you out. If heddle cannot open the browser, it shows the link in the timeline.

### A server that runs on your computer

A `stdio` server is a program that heddle starts on your computer. It runs on your computer also when the tools run in the sandbox.

```json
{
  "mcp": {
    "memory": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

The program gets only a few of your environment variables, such as `PATH`. Put each key that it needs in `env`.

### Server fields

The model sees each tool as `<server>_<tool>`, for example `linear_<tool>`.

Both kinds of server:

| Field | What it does |
| --- | --- |
| `type` | `"http"` or `"stdio"`. |
| `timeoutMs` | The time in milliseconds to connect, to list the tools, or to answer a tool call. The default is 60000. |
| `needsApproval` | `true`: each tool of this server asks for approval. If you do not set it, no tool asks, but with `oauth` each tool that is not read-only asks. |
| `codeMode` | `true`: only a code mode program can call the tools of this server. This needs code mode on. |

An `http` server:

| Field | What it does |
| --- | --- |
| `url` | The address of the server. |
| `oauth` | `true`: sign in with `/connect <name>`. |
| `headers` | HTTP headers, such as a token. They do not apply with `oauth`. |

A `stdio` server:

| Field | What it does |
| --- | --- |
| `command` | The program. |
| `args` | A list of arguments for the program. |
| `env` | Environment variables for the program. |
| `cwd` | The folder where the program starts. |

## Sessions

You can quit at any time. heddle keeps each session, so you can continue it later.

- Quit with `ctrl+c` two times, or with `/quit`.
- A turn that ran when you quit goes on when you open the session again.
- An approval that waited still waits.

To open a session again:

| How | What opens |
| --- | --- |
| `-c` | The newest session of this folder. |
| `-r` | The newest session, with the session picker over it. |
| `ctrl+o` or `/sessions` | The session picker. |
| `/new` | A new session. |

The session picker lists the 50 newest sessions of this folder. Each row shows the status, the title, where the tools run, the time, and the cost. The status is `●` live, `◌` needs you, or `✓` done.

| Key | What it does |
| --- | --- |
| `↑` `↓` | Move. |
| `enter` | Open the session. |
| `f` | Open a copy of the session (a fork). |
| `r` | Rename the session. `enter` saves, and `esc` cancels. |
| `n` | Start a new session. |

Type to search the titles. `f`, `r`, and `n` work only while the search is empty. `esc` closes the picker.

If heddle stopped without a clean quit, for example after a crash, wait 5 seconds. Then `-c` can continue the session.

## Where heddle keeps its data

| Path | What it has |
| --- | --- |
| `~/.heddle/heddle.db` | The sessions, the rules that `a` saved, and your API keys and OAuth tokens. The keys and the tokens are plain text. |
| `~/.heddle/logs/heddle.log` | The log, with the details of each error. heddle leaves out each field whose name has `key`, `token`, `secret`, or `password`. |
| `~/.heddle/snapshots/` | The file snapshots of local sessions, for `/undo`. A sandbox session keeps them in its container. |
| `~/.heddle/config.json` | Your config for all projects. |
| `~/.heddle/agents/` | Your own agents. Each `.md` file is an agent: the file name is its name, and the text is its system prompt. `<project>/.heddle/agents/` has the agents of one project. |

## Not in v1

heddle v1 does not have these features.

In the input and the panes:

- `@file` completion in the input.
- A diff of all the changes since the session started. The changes pane shows one patch at a time.
- LSP.
- Image paste.

Other:

- GitHub MCP sign-in with OAuth.
- A light theme.
- A web UI.
- More than one user.
