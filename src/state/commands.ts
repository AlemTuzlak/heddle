import type { ViewCommand } from '@tanstack/ai-harness/view'

/** An action of heddle itself. It is not a command of the harness. */
export type LocalAction = 'sessions' | 'new' | 'quit' | 'help'

/**
 * What heddle does with one line of the composer.
 *
 * - `send`: it sends `text` to the agent.
 * - `command`: it runs the plugin command `name`. `input` is the text after
 *   the name. A command with no text after its name has no `input`.
 * - `local`: it does the heddle action `action`.
 * - `error`: it shows `message`, and does nothing more.
 */
export type Input =
  | { kind: 'send'; text: string }
  | { kind: 'command'; name: string; input?: string }
  | { kind: 'local'; action: LocalAction }
  | { kind: 'error'; message: string }

/** One row of the `/` popup of the composer. */
export interface Suggestion {
  /** The text of the row, for example `/connect anthropic`. */
  label: string
  /** What the command does. */
  detail: string
  /** The full text for the composer. It ends with a space when the command takes input. */
  insert: string
}

/**
 * The commands of heddle itself. A local name wins over a plugin command
 * with the same name.
 */
const LOCAL_COMMANDS: ReadonlyArray<{
  name: string
  action: LocalAction
  detail: string
}> = [
  { name: 'sessions', action: 'sessions', detail: 'Open the session picker' },
  { name: 'new', action: 'new', detail: 'Start a new session' },
  { name: 'quit', action: 'quit', detail: 'Quit heddle' },
  { name: 'exit', action: 'quit', detail: 'Quit heddle' },
  { name: 'help', action: 'help', detail: 'Show the commands' },
]

/** The rows of the local commands in the `/` popup. They take no input. */
const LOCAL_ROWS = LOCAL_COMMANDS.map(({ name, detail }) => ({
  label: `/${name}`,
  detail,
  insert: `/${name}`,
}))

/**
 * The model providers and the MCP servers name their commands
 * `connect:<id>` and `disconnect:<id>`. The user types them as
 * `/connect <id>` and `/disconnect <id>`.
 */
const TARGET_PREFIXES: ReadonlyArray<string> = ['connect', 'disconnect']

/**
 * It turns one line of the composer into an {@link Input}.
 *
 * - Text without a `/` at the start is a send of the trimmed text.
 * - `/sessions`, `/new`, `/quit`, `/exit`, and `/help` are local. A local
 *   name wins over a plugin command with the same name.
 * - `/connect <id>` runs the command `connect:<id>`, and `/disconnect <id>`
 *   runs `disconnect:<id>`. An id with no command is an error that lists
 *   the ids.
 * - `/<name> <text>` runs the plugin command `name` with the input `<text>`.
 *   The name ends at the first space, tab, or new line.
 * - Any other `/<name>` is the error `Unknown command /<name>. Type /help.`
 *
 * `commands` are the commands of the session, from `view.store.get().commands`.
 *
 * @example
 * ```ts
 * parseInput('/goal ship it', commands)
 * // { kind: 'command', name: 'goal', input: 'ship it' }
 * ```
 */
export function parseInput(line: string, commands: ReadonlyArray<ViewCommand>) {
  const text = line.trim()
  const input: Input = text.startsWith('/')
    ? slashInput(text, commands)
    : { kind: 'send', text }
  return input
}

/**
 * It gives the rows of the `/` popup for the text of the composer. The rows
 * are the plugin commands and the local commands whose label starts with
 * `text`, sorted by label. Text without a `/` at the start gives no rows.
 *
 * - `connect:<id>` shows as `/connect <id>`, and `disconnect:<id>` shows as
 *   `/disconnect <id>`.
 * - A plugin command with a local name does not show, because the local
 *   command runs.
 * - `insert` ends with a space when the command has an input schema.
 *
 * `commands` are the commands of the session, from `view.store.get().commands`.
 * `suggest('/', commands)` gives all the rows.
 *
 * @example
 * ```ts
 * suggest('/connect a', commands)
 * // [{ label: '/connect anthropic', detail: 'Connect Anthropic with your own key', insert: '/connect anthropic' }]
 * ```
 */
export function suggest(text: string, commands: ReadonlyArray<ViewCommand>) {
  const typed = text.trimStart()
  // For a local name, the local command runs, so the plugin command does not show.
  const shown = commands.filter(
    (command) => !LOCAL_COMMANDS.some((local) => local.name === command.name),
  )
  const rows: Array<Suggestion> = typed.startsWith('/')
    ? [...shown.map(rowOf), ...LOCAL_ROWS]
    : []
  const matches = rows.filter((row) => row.label.startsWith(typed))
  return matches.sort((a, b) => a.label.localeCompare(b.label, 'en'))
}

/** It gives the {@link Input} of a line that starts with `/`. */
function slashInput(text: string, commands: ReadonlyArray<ViewCommand>) {
  // The name ends at the first space, tab, or new line. The rest is the input.
  const [, name = '', rest = ''] = /^\/(\S*)\s*(.*)$/s.exec(text) ?? []
  const local = LOCAL_COMMANDS.find((entry) => entry.name === name)
  if (local !== undefined) {
    return { kind: 'local', action: local.action } satisfies Input
  }
  const names = new Set(commands.map((command) => command.name))
  const isTargetPrefix = TARGET_PREFIXES.includes(name)
  const targetName = `${name}:${rest}`
  const isTargetCommand = isTargetPrefix && names.has(targetName)
  if (isTargetCommand) {
    return { kind: 'command', name: targetName } satisfies Input
  }
  if (names.has(name)) {
    // A command with no text, such as `/goal`, gets no input.
    if (rest === '') return { kind: 'command', name } satisfies Input
    return { kind: 'command', name, input: rest } satisfies Input
  }
  const targets = isTargetPrefix ? targetsOf(name, commands) : []
  if (targets.length > 0) {
    const hint = `Type /${name} and one of these targets: ${targets.join(', ')}.`
    const message =
      rest === '' ? hint : `Unknown ${name} target "${rest}". ${hint}`
    return { kind: 'error', message } satisfies Input
  }
  return {
    kind: 'error',
    message: `Unknown command /${name}. Type /help.`,
  } satisfies Input
}

/** It gives the ids of the commands named `<prefix>:<id>`, in the order of `commands`. */
function targetsOf(prefix: string, commands: ReadonlyArray<ViewCommand>) {
  const start = `${prefix}:`
  const named = commands.filter((command) => command.name.startsWith(start))
  return named.map((command) => command.name.slice(start.length))
}

/** It gives the row of a plugin command in the `/` popup. */
function rowOf(command: ViewCommand) {
  const { name, description: detail } = command
  const prefix = TARGET_PREFIXES.find((entry) => name.startsWith(`${entry}:`))
  if (prefix !== undefined) {
    // The id goes to the end of the line, so no input can come after it.
    const label = `/${prefix} ${name.slice(prefix.length + 1)}`
    return { label, detail, insert: label }
  }
  const label = `/${name}`
  const takesInput = command.input !== undefined
  return { label, detail, insert: takesInput ? `${label} ` : label }
}
