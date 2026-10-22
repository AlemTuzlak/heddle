import type { ViewCommand } from '@tanstack/ai-harness/view'

/** An action of heddle itself. It is not a command of the harness. */
export type LocalAction = 'sessions' | 'new' | 'quit' | 'help' | 'open'

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
  /** The text of the row, for example `/model`. */
  label: string
  /** What the command does. */
  detail: string
  /**
   * The full text for the composer. It ends with a space when the command
   * takes input: it has an input schema, or its description shows a use such as `/goal <goal>`.
   */
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
  { name: 'open', action: 'open', detail: 'Open the last file that an agent made' },
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
 * `/connect <id>` and `/disconnect <id>`, or picks the id from a list.
 */
const TARGET_PREFIXES: ReadonlyArray<string> = ['connect', 'disconnect']

/** The one row of each prefix in the `/` popup. The list of ids opens on enter. */
const TARGET_DETAILS: Record<string, string> = {
  connect: 'Connect a model provider or a server',
  disconnect: 'Remove a saved key or sign-in',
}

/**
 * It turns one line of the composer into an {@link Input}.
 *
 * - Text without a `/` at the start is a send of the trimmed text.
 * - `/sessions`, `/new`, `/quit`, `/exit`, and `/help` are local. A local
 *   name wins over a plugin command with the same name.
 * - `/connect <id>` runs the command `connect:<id>`, and `/disconnect <id>`
 *   runs `disconnect:<id>`. An id with no command is an error that lists
 *   the ids. `/connect` alone is the command `connect` with no input: the
 *   app shows the ids to pick one.
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
 * It gives the rows of the `/` popup for the text of the composer. First the
 * rows whose label starts with `text`, then the rows whose name has `text`
 * in it, each sorted by label. Text without a `/` at the start gives no rows.
 *
 * - The `connect:<id>` commands show as one `/connect` row, and the
 *   `disconnect:<id>` commands as one `/disconnect` row.
 * - A plugin command with a local name does not show, because the local
 *   command runs.
 * - `insert` ends with a space when the command has an input schema.
 *
 * `commands` are the commands of the session, from `view.store.get().commands`.
 * `suggest('/', commands)` gives all the rows.
 *
 * @example
 * ```ts
 * suggest('/del', commands)
 * // [{ label: '/model', detail: 'Show or switch the model', insert: '/model' }]
 * ```
 */
export function suggest(text: string, commands: ReadonlyArray<ViewCommand>) {
  const typed = text.trimStart()
  // For a local name, the local command runs, so the plugin command does not show.
  const shown = commands.filter(
    (command) => !LOCAL_COMMANDS.some((local) => local.name === command.name),
  )
  const plain = shown.filter(
    (command) => !TARGET_PREFIXES.some((prefix) => command.name.startsWith(`${prefix}:`)),
  )
  const targets = TARGET_PREFIXES.filter((prefix) => targetsOf(prefix, commands).length > 0).map(
    (prefix) => ({ label: `/${prefix}`, detail: TARGET_DETAILS[prefix] ?? '', insert: `/${prefix}` }),
  )
  const rows: Array<Suggestion> = typed.startsWith('/')
    ? [...plain.map(rowOf), ...targets, ...LOCAL_ROWS]
    : []
  const byLabel = (a: Suggestion, b: Suggestion) => a.label.localeCompare(b.label, 'en')
  const starts = rows.filter((row) => row.label.startsWith(typed)).sort(byLabel)
  // `/del` also finds `/model`. A bare `/` has no text to find.
  const word = typed.slice(1)
  const has = rows.filter(
    (row) => word !== '' && !row.label.startsWith(typed) && row.label.slice(1).includes(word),
  )
  return [...starts, ...has.sort(byLabel)]
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
  // The app shows the ids to pick one.
  if (targets.length > 0 && rest === '') return { kind: 'command', name } satisfies Input
  if (targets.length > 0) {
    const hint = `Type /${name} and one of these targets: ${targets.join(', ')}.`
    return { kind: 'error', message: `Unknown ${name} target "${rest}". ${hint}` } satisfies Input
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
  const label = `/${name}`
  // ponytail: some commands take text with no input schema, such as `/goal`.
  // Their description shows the use, as in `/goal <goal>`.
  const takesInput = command.input !== undefined || /\/\S+ </.test(detail)
  return { label, detail, insert: takesInput ? `${label} ` : label }
}
