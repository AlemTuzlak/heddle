#!/usr/bin/env bun
// The entry point of heddle. It reads the flags and the config, starts heddle
// in the project folder, and shows the app until the user quits. Then it
// cleans up, and the process ends.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createCliRenderer, destroyTreeSitterClient } from '@opentui/core'
import { createRoot } from '@opentui/react'
import packageJson from '../package.json'
import { DEFAULT_IMAGE, loadConfig, type HeddleConfig } from './config'
import { createFileLogger, startHeddle } from './session'
import { App } from './ui/App'
import { createSyntaxStyle } from './ui/theme'
import { messageOf } from './utils'

/** The flags of the `heddle` command. {@link parseFlags} reads them. */
export interface Flags {
  /** `-c`, `--continue`: open the newest session of the folder. */
  continue: boolean
  /** `-r`, `--resume`: open the newest session of the folder, and show the session picker. */
  resume: boolean
  /** `--sandbox`: a new session runs its tools in a Docker sandbox. */
  sandbox: boolean
  /** `-h`, `--help`: print {@link USAGE}. */
  help: boolean
  /** `-v`, `--version`: print the version. */
  version: boolean
}

/** The text of `heddle --help`. */
export const USAGE = `Usage: heddle [options]

Start heddle in a project folder. With no options, heddle starts a new session.

Options:
  -c, --continue  Continue the newest session of this folder.
  -r, --resume    Pick a session of this folder from a list.
      --sandbox   Run the tools of a new session in a Docker sandbox.
  -h, --help      Show this help.
  -v, --version   Show the version.

Files:
  ~/.heddle/config.json          The config for all your projects.
  <project>/.heddle/config.json  The config for one project. Its fields win.
  ~/.heddle/logs/heddle.log      The log. It has the details of each error.

API keys:
  Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or XAI_API_KEY.
  Or, in heddle, type /connect anthropic, /connect openai, or /connect grok.`

/** After the cleanup, the process has this much time to end by itself. Then heddle ends it. */
const EXIT_GRACE_MS = 1000

/** One step of the cleanup. It can give a promise. */
type Step = () => unknown

/**
 * Reads the flags of the `heddle` command. A flag that `argv` does not have
 * is `false`.
 *
 * It throws an `Error` for a flag that heddle does not know, and for an
 * argument that is not a flag. The message names the argument and ends with
 * `Type heddle --help.`, for example
 * `Unknown option '--nope'. Type heddle --help.`
 *
 * @param argv - The arguments after `heddle`, for example `process.argv.slice(2)`.
 *
 * @example
 * ```ts
 * parseFlags(['-c', '--sandbox'])
 * // { continue: true, resume: false, sandbox: true, help: false, version: false }
 * ```
 */
export function parseFlags(argv: ReadonlyArray<string>) {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        continue: { type: 'boolean', short: 'c', default: false },
        resume: { type: 'boolean', short: 'r', default: false },
        sandbox: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
    const flags: Flags = values
    return flags
  } catch (error) {
    // The first sentence of a parseArgs error names the argument, for
    // example `Unknown option '--nope'`. The rest is not for heddle users.
    const [reason] = messageOf(error).split('. ', 1)
    throw new Error(`${reason}. Type heddle --help.`)
  }
}


/**
 * Prints `<title>: <message>` as one line on stderr, and writes the error
 * with its stack to the log file in `home`.
 */
function report(home: string, title: string, error: unknown) {
  // Only the first line goes to stderr. The log file has all of the error.
  const [firstLine] = messageOf(error).split('\n', 1)
  console.error(`${title}: ${firstLine}`)
  try {
    createFileLogger(join(home, '.heddle', 'logs', 'heddle.log')).error(`${title}.`, { error })
  } catch {
    // heddle cannot make the log folder. The line on stderr is all that the user gets.
  }
}

/**
 * Runs `steps` in order. A step that fails does not stop the steps after
 * it. Gives the errors of the steps that failed.
 */
async function runSteps(steps: ReadonlyArray<Step>) {
  const errors: Array<unknown> = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

/**
 * Starts heddle in the folder `root`, opens the first session, and shows the
 * app. When a part has started, its cleanup steps go to the start of
 * `cleanup`. So `cleanup` has the right order, also when a later part fails.
 */
async function start(options: {
  root: string
  home: string
  flags: Flags
  cleanup: Array<Step>
  onQuit: () => void
}) {
  const { root, home, flags, cleanup, onQuit } = options
  const loaded = loadConfig({ home, project: root })
  // `--sandbox` turns on the sandbox. An image from the config stays.
  const needsImage = flags.sandbox && loaded.sandbox === false
  const config: HeddleConfig = needsImage ? { ...loaded, sandbox: { image: DEFAULT_IMAGE } } : loaded
  const heddle = await startHeddle({ root, home, config })
  cleanup.unshift(() => heddle.shutdown())
  // `-c` and `-r` open the newest session. A folder with no session gets a new one.
  const isLatest = flags.continue || flags.resume
  const threadId = isLatest ? await heddle.latest() : undefined
  // The first open checks the model of the config.
  const session = await heddle.open(threadId)
  // The screen starts last. So an error before this line leaves the terminal as it is.
  const renderer = await createCliRenderer({
    // The app handles ctrl+c itself: two in 1 second quit.
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    // A signal (for example SIGTERM, or a closed terminal) destroys the
    // renderer. Then heddle quits too, so that the cleanup runs.
    onDestroy: onQuit,
  })
  const syntaxStyle = createSyntaxStyle(renderer)
  const reactRoot = createRoot(renderer)
  // OpenTUI needs this order. The renderer uses the style until it is closed.
  cleanup.unshift(
    () => reactRoot.unmount(),
    () => destroyTreeSitterClient(),
    () => renderer.destroy(),
    () => renderer.closed,
    () => syntaxStyle.destroy(),
  )
  reactRoot.render(
    <App
      host={heddle}
      session={session}
      syntaxStyle={syntaxStyle}
      startWith={flags.resume ? 'sessions' : undefined}
      onQuit={onQuit}
    />,
  )
}

/** Runs `heddle` with the arguments `argv`. Gives the exit code: 0, or 1 after an error. */
async function main(argv: ReadonlyArray<string>) {
  let flags: Flags
  try {
    flags = parseFlags(argv)
  } catch (error) {
    // A wrong flag is a typo. It gets one line, and no entry in the log.
    console.error(messageOf(error))
    return 1
  }
  if (flags.help) {
    console.log(USAGE)
    return 0
  }
  if (flags.version) {
    console.log(`heddle ${packageJson.version}`)
    return 0
  }
  const home = homedir()
  const quit = Promise.withResolvers<void>()
  const cleanup: Array<Step> = []
  const [started] = await Promise.allSettled([
    start({ root: process.cwd(), home, flags, cleanup, onQuit: () => quit.resolve() }),
  ])
  // The app shows until the user quits. The app does not close its session:
  // `heddle.shutdown()` in the cleanup closes each open session.
  if (started.status === 'fulfilled') await quit.promise
  const errors = await runSteps(cleanup)
  // The screen is closed now, so these lines show in the terminal.
  if (started.status === 'rejected') report(home, 'heddle could not start', started.reason)
  for (const error of errors) report(home, 'heddle could not close', error)
  const isClean = started.status === 'fulfilled' && errors.length === 0
  return isClean ? 0 : 1
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
  // The cleanup closed what heddle opened. A handle that is still open (for
  // example the process of an MCP server) must not keep heddle running.
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref()
}
