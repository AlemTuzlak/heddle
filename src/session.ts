// The life of heddle in one project folder: the stores, the host, the harness
// of each place, and the sessions that the UI opens. The UI gets an
// `OpenSession` for the session that it shows.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readCredential } from '@tanstack/ai/byok/server'
import { createHarnessHost } from '@tanstack/ai-harness'
import { listSavedPermissions, type PermissionRule } from '@tanstack/ai-harness/plugins'
import { createSessionView } from '@tanstack/ai-harness/view'
import { MODELS, createHarness, type ModelChoice } from './harness'
import { CONTAINER_ROOT, createSandbox } from './sandbox'
import { watchChanges } from './state/changes'
import { openSqliteStores } from './store/sqlite'
import { relativePath } from './utils'
import type { AnyTextAdapter, Logger } from '@tanstack/ai'
import type { HarnessSession, SessionSnapshot } from '@tanstack/ai-harness'
import type { SessionView } from '@tanstack/ai-harness/view'
import type { SessionIndexEntry } from '@tanstack/ai-persistence'
import { DEFAULT_IMAGE, type HeddleConfig } from './config'
import type { Sandbox, SyncState } from './sandbox'
import type { ChangesWatch } from './state/changes'
import type { SessionRow } from './ui/SessionPicker'

/** A session that the UI shows. Get it from `heddle.open()`. */
export interface OpenSession {
  /** The id of the session. */
  threadId: string
  /** Where the tools run: in the folder, or in the Docker sandbox. */
  place: 'local' | 'docker'
  /** The root of the tools: the folder, or {@link CONTAINER_ROOT} in the sandbox. */
  root: string
  /** The live view. The UI reads its store and calls its actions. */
  view: SessionView
  /** The files that the session changed. */
  changes: ChangesWatch
  /** The copy from the sandbox to the folder. Only a docker session has it. */
  sync?: { state(): SyncState; onState(listener: (state: SyncState) => void): () => void }
  /**
   * The provider of the current model, such as `'anthropic'`, when heddle has
   * no key for it. `undefined` when the environment variable of the provider
   * is set, or when `/connect` saved a key. It throws when the view has no
   * model that heddle knows.
   */
  missingKey(): Promise<string | undefined>
  /** The rules that `always` answers saved for the tools root, in the order of `/permissions forget <n>`. */
  permissionRules(): Promise<ReadonlyArray<PermissionRule>>
  /** Stops the change watch and the view, and lets the session go. A second call does nothing. */
  close(): Promise<void>
}

/** heddle in one project folder. Make it with {@link startHeddle}. */
export interface Heddle {
  /** The sessions of the folder, newest first, at most 50, as the session picker shows them. */
  listSessions(): Promise<Array<SessionRow>>
  /** The id of the newest session of the folder, or `undefined` when the folder has none. */
  latest(): Promise<string | undefined>
  /**
   * Opens the session `threadId` in the place where it was made. Without
   * `threadId`, it makes a new session in `options.place`, else in the place
   * of the config.
   */
  open(threadId?: string, options?: { place?: 'local' | 'docker' }): Promise<OpenSession>
  /**
   * Copies the session `threadId` with its messages, and gives the id of the
   * copy. It throws `heddle has no session <id>.` for an unknown id.
   */
  fork(threadId: string): Promise<string>
  /** Gives the session `threadId` a new title. It throws `heddle has no session <id>.` for an unknown id. */
  rename(threadId: string, title: string): Promise<void>
  /**
   * Calls `listener` when an open session starts or stops a run, waits for an
   * answer, or gets a new title. Gives the function that stops the calls.
   */
  onSessionsChange(listener: () => void): () => void
  /**
   * Closes the open sessions, stops the sandbox, then closes the host and the
   * stores. A turn that runs now goes on when its session opens again. A
   * second call waits for the first one.
   */
  shutdown(): Promise<void>
}

type Place = OpenSession['place']

type Harness = ReturnType<typeof createHarness>

/** The one user of heddle. The host keeps the sessions and the keys of this user. */
const USER = { id: 'local' }

/**
 * The host owns the log of a session for 5 s after each renewal, and it
 * renews every 1.5 s. So after a crash, `heddle -c` can continue the session
 * 5 s later.
 */
const OWNERSHIP = { expiresAfterMs: 5000, renewEveryMs: 1500 }

/** The folder of the file snapshots in the container. */
const SANDBOX_SNAPSHOTS = '/tmp/heddle/snapshots'

/** The most sessions that the session picker lists. */
const LIST_LIMIT = 50

/** The title of a session that has no title yet. */
const NO_TITLE = 'New session'

/** A meta field whose name matches this can hold a secret. The log file never gets it. */
const SECRET_FIELD = /key|token|secret|password/i

/**
 * A `Logger` that appends one line to the file at `path` for each call: the
 * time (ISO 8601), the level, the message, and the other meta fields as JSON.
 * When the meta has an `error`, its stack follows on the next lines.
 *
 * It never writes a secret: it leaves out each meta field whose name has
 * `key`, `token`, `secret`, or `password`, also inside an object. It makes
 * the folder of `path` when it is missing. A write that fails loses its line,
 * because a logger must not stop heddle.
 *
 * @param path - The log file, for example `~/.heddle/logs/heddle.log`.
 * @throws Error when it cannot make the folder of `path`.
 *
 * @example
 * ```ts
 * const logger = createFileLogger(join(home, '.heddle', 'logs', 'heddle.log'))
 * logger.error('heddle could not start.', { error })
 * ```
 */
export function createFileLogger(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  const write = (level: keyof Logger, message: string, meta?: Record<string, unknown>) => {
    try {
      appendFileSync(path, lineOf(level, message, meta))
    } catch {
      // The line is lost. The terminal belongs to the UI, so no other place can show it.
    }
  }
  const logger: Logger = {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  }
  return logger
}

/** For `JSON.stringify`: it leaves out each field whose name can hold a secret. */
function withoutSecrets(key: string, value: unknown) {
  return SECRET_FIELD.test(key) ? undefined : value
}

/** One entry of the log file, with its line break at the end. */
function lineOf(level: keyof Logger, message: string, meta: Record<string, unknown> = {}) {
  const { error, ...fields } = meta
  const json = JSON.stringify(fields, withoutSecrets)
  const extra = json === '{}' ? '' : ` ${json}`
  const stack = error === undefined ? '' : `\n${stackOf(error)}`
  return `${new Date().toISOString()} ${level} ${message}${extra}${stack}\n`
}

/** The stack of an `Error`, or the text of a value that is not an `Error`. */
function stackOf(error: unknown) {
  return error instanceof Error ? (error.stack ?? String(error)) : String(error)
}

/** Where the tools of a session run. heddle writes the place in the metadata when it opens the session. */
function placeOf(entry: SessionIndexEntry) {
  return entry.metadata?.place === 'docker' ? 'docker' : 'local'
}

/** The status of a session in the picker: it waits for the user, it runs, or neither. */
function statusOf(snapshot: SessionSnapshot) {
  if (snapshot.pendingWaits.length > 0) return 'needs-you'
  const isRunning = snapshot.status === 'running' || snapshot.activeOperations.length > 0
  return isRunning ? 'live' : 'done'
}

/** The command that opens `url` in the browser, with no shell. */
function browserCommand(url: string) {
  switch (process.platform) {
    case 'win32':
      // Not `cmd /c start`: cmd reads the `&` of a URL as the start of a new command.
      return ['rundll32', 'url.dll,FileProtocolHandler', url]
    case 'darwin':
      return ['open', url]
    default:
      return ['xdg-open', url]
  }
}

/** Opens `url` in the browser of the user. It throws for a page that is not http or https. */
function openInBrowser(url: string) {
  const isWebPage = /^https?:\/\//i.test(url)
  if (!isWebPage) throw new Error(`heddle opens only http and https pages, not ${url}.`)
  Bun.spawn(browserCommand(url), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
}

/**
 * Starts heddle in the project folder `root`:
 *
 * - The sessions and the keys are in `<home>/.heddle/heddle.db`, and the log
 *   file is `<home>/.heddle/logs/heddle.log`. heddle makes the folders.
 * - The harness of each place is made when a session first uses it: `local`
 *   for the folder, and `docker` with one sandbox that the docker sessions
 *   share.
 *
 * It throws when it cannot make the folders or open the database. `open()`
 * throws `Unknown model "<name>". Use one of: ...` when `config.model` names
 * a model that heddle does not know.
 *
 * @param options.root - The project folder.
 * @param options.home - The home folder of the user.
 * @param options.config - The config from `loadConfig`.
 * @param options.models - For tests only: an adapter for each model name, in
 *   place of the real models. See `createHarness`.
 * @param options.openUrl - For tests only: it opens a sign-in page in place
 *   of the browser.
 *
 * @example
 * ```ts
 * const heddle = await startHeddle({ root: process.cwd(), home: os.homedir(), config })
 * // `heddle -c`: the newest session, or a new one when the folder has none.
 * const session = await heddle.open(await heddle.latest())
 * // At exit:
 * await heddle.shutdown()
 * ```
 */
export async function startHeddle(options: {
  root: string
  home: string
  config: HeddleConfig
  models?: Record<string, AnyTextAdapter>
  openUrl?: (url: string) => void
}) {
  const { root, home, config, models } = options
  const openUrl = options.openUrl ?? openInBrowser
  const dataDir = join(home, '.heddle')
  // The logger makes `<home>/.heddle/logs`, so the folder of the database is there too.
  const logger = createFileLogger(join(dataDir, 'logs', 'heddle.log'))
  const stores = openSqliteStores(join(dataDir, 'heddle.db'))
  const host = createHarnessHost({
    persistence: stores.persistence,
    credentials: stores.credentials,
    logger,
    ownership: OWNERSHIP,
  })
  /** True when the provider of `choice` has a key: in the environment, or saved by `/connect`. */
  const hasKey = async (choice: ModelChoice) => {
    if ((process.env[choice.env] ?? '') !== '') return true
    const saved = await readCredential(stores.credentials, { userId: USER.id }, choice.provider)
    return saved?.type === 'api_key'
  }
  /**
   * The model of the config, else the first model whose provider has a key.
   * With no key at all, the first model: the first message then says how to add a key.
   */
  const firstWithKey = async () => {
    for (const choice of MODELS) if (await hasKey(choice)) return choice.name
    return MODELS[0].name
  }
  const model = config.model ?? (await firstWithKey())
  const defaultPlace = config.sandbox === false ? 'local' : 'docker'
  /** The sessions that the UI has open now. */
  const opened = new Set<OpenSession>()
  let local: Harness | undefined
  let docker: Harness | undefined
  let sandbox: Sandbox | undefined
  let stopping: Promise<void> | undefined

  /** A sync conflict: each open docker session shows it, and the log file keeps it. */
  const showConflict = (path: string) => {
    const text = `Sync: ${relativePath(path, root)} changed here and in the sandbox. The sandbox copy won.`
    logger.warn(text)
    for (const session of opened) {
      if (session.place === 'docker') session.view.notice({ text })
    }
  }

  /** The one sandbox of the folder, made at its first use. The docker sessions share it. */
  const sandboxOf = () => {
    sandbox ??= createSandbox({
      root,
      image: config.sandbox === false ? DEFAULT_IMAGE : config.sandbox.image,
      logger,
      onConflict: showConflict,
    })
    return sandbox
  }

  /** The harness of `place`, made at its first use. */
  const harnessOf = (place: Place) => {
    const shared = { root, home, config, model, models }
    if (place === 'local') {
      local ??= createHarness({ ...shared, place, snapshotsDir: join(dataDir, 'snapshots') })
      return local
    }
    const { workspace, plugin } = sandboxOf()
    docker ??= createHarness({
      ...shared,
      place,
      workspace,
      plugins: [plugin],
      snapshotsDir: SANDBOX_SNAPSHOTS,
    })
    return docker
  }

  /** The sessions of the folder, newest first. */
  const sessionsOfFolder = (limit: number) =>
    host.sessions.list({ user: USER, metadata: { project: root }, limit })

  /**
   * The picker row of a session. The index entry has no status, so the status
   * comes from the snapshot of the session: from the open session, else from
   * its log.
   */
  const rowOf = async (entry: SessionIndexEntry) => {
    const place = placeOf(entry)
    const observed = await host.observe(harnessOf(place), {
      threadId: entry.threadId,
      user: USER,
    })
    const row: SessionRow = {
      id: entry.threadId,
      title: entry.title ?? NO_TITLE,
      status: statusOf(await observed.snapshot()),
      place,
      updatedAt: entry.updatedAt,
      cost: entry.usage?.cost,
    }
    return row
  }

  /** The `OpenSession` of `session`, a session of the harness of `place`. */
  const openedSession = (session: HarnessSession<Harness>, place: Place) => {
    const view = createSessionView(session)
    const toolsRoot = place === 'docker' ? CONTAINER_ROOT : root
    const changes = watchChanges(session, toolsRoot)
    // Only the two reads of the sync go to the UI, not the whole sandbox.
    const sync = place === 'docker' ? sandboxOf() : undefined
    // A connector that needs a sign-in, such as an MCP server, opens its page in the browser.
    view.on('signIn', ({ connector, url }) => {
      if (url === undefined) return
      try {
        openUrl(url)
      } catch (error) {
        logger.warn(`heddle could not open the sign-in page of ${connector}.`, { error })
        view.notice({ text: `Open this page in your browser to sign in to ${connector}: ${url}` })
      }
    })
    const openSession: OpenSession = {
      threadId: session.threadId,
      place,
      root: toolsRoot,
      view,
      changes,
      sync: sync === undefined ? undefined : { state: sync.state, onState: sync.onState },
      missingKey: async () => {
        // The model picker of the harness keeps the model of the session in its config entry.
        await view.ready
        const name = view.store.get().config.find((entry) => entry.key === 'model')?.value
        const choice = MODELS.find((each) => each.name === name)
        if (choice === undefined) {
          throw new Error(`heddle does not know the model of this session: ${String(name)}.`)
        }
        return (await hasKey(choice)) ? undefined : choice.provider
      },
      // `permissions()` saves the rules for the root of the tools.
      permissionRules: () => listSavedPermissions(stores.persistence.stores, toolsRoot),
      close: async () => {
        // A session that is closed already is not in the set.
        if (!opened.delete(openSession)) return
        changes.stop()
        view.dispose()
        // The view can still load its first state from the session. A closed
        // session throws, so the load must end before the session goes.
        await view.ready
        await session.close()
      },
    }
    opened.add(openSession)
    return openSession
  }

  const stop = async () => {
    try {
      await Promise.all([...opened].map((session) => session.close()))
      await sandbox?.stop()
      // `recoverable`: a turn that runs now goes on when its session opens again.
      await host.close({ recoverable: true })
    } finally {
      // Also after an error: the stores stop their poll, so the process can end.
      stores.close()
    }
  }

  const heddle: Heddle = {
    listSessions: async () => {
      const page = await sessionsOfFolder(LIST_LIMIT)
      return Promise.all(page.entries.map(rowOf))
    },
    latest: async () => {
      const page = await sessionsOfFolder(1)
      return page.entries[0]?.threadId
    },
    open: async (threadId, openOptions = {}) => {
      const entry =
        threadId === undefined ? undefined : await host.sessions.get({ threadId, user: USER })
      // A session that exists opens in its own place.
      const place = entry === undefined ? (openOptions.place ?? defaultPlace) : placeOf(entry)
      const session = await host.open(harnessOf(place), {
        threadId: threadId ?? crypto.randomUUID(),
        user: USER,
      })
      try {
        await session.updateIndexEntry((current) => ({
          metadata: { ...current.metadata, project: root, place },
        }))
      } catch (error) {
        await session.close()
        throw error
      }
      logger.info(`heddle opened session ${session.threadId} (${place}).`)
      return openedSession(session, place)
    },
    fork: async (threadId) => {
      const source = await host.sessions.get({ threadId, user: USER })
      if (source === undefined) throw new Error(`heddle has no session ${threadId}.`)
      const place = placeOf(source)
      const forkId = crypto.randomUUID()
      // The copy gets the messages, the settings, and the plugin config.
      const fork = await host.fork(harnessOf(place), {
        threadId,
        newThreadId: forkId,
        user: USER,
      })
      try {
        // The metadata puts the copy in the list of the folder.
        await fork.updateIndexEntry((current) => ({
          title: source.title === undefined ? undefined : `${source.title} (fork)`,
          metadata: { ...current.metadata, project: root, place },
        }))
      } finally {
        await fork.close()
      }
      return forkId
    },
    rename: async (threadId, title) => {
      const entry = await host.sessions.rename({ threadId, title, user: USER })
      if (entry === undefined) throw new Error(`heddle has no session ${threadId}.`)
    },
    onSessionsChange: (listener) => {
      const abort = new AbortController()
      const read = async () => {
        for await (const _event of host.events({ signal: abort.signal })) listener()
      }
      read().catch((error: unknown) => {
        if (!abort.signal.aborted) logger.warn('heddle stopped reading the session statuses.', { error })
      })
      return () => abort.abort()
    },
    shutdown: () => (stopping ??= stop()),
  }
  return heddle
}
