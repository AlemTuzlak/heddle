// The Docker sandbox. The agent works in a container, on a copy of the
// project folder. Each file that changes in the container goes back to the
// folder.

import { definePlugin } from '@tanstack/ai-harness'
import { FileChanged } from '@tanstack/ai-harness/plugins/coding'
import { defineWorkspace, localSource } from '@tanstack/ai-sandbox'
import { sandboxWorkspaceBackend } from '@tanstack/ai-sandbox/harness'
import { dockerSandbox } from '@tanstack/ai-sandbox-docker'
import { createSync, localPathOf } from './sync'
import type { Logger } from '@tanstack/ai'
import type { HarnessPlugin } from '@tanstack/ai-harness'
import type {
  BoundWorkspace,
  FileChange,
  WorkspaceBinder,
} from '@tanstack/ai-harness/plugins/coding'
import type { SandboxHandle, SandboxProvider } from '@tanstack/ai-sandbox'

/**
 * What the sync from the containers does now. The header shows it.
 *
 * - `'starting'`: at first, and while heddle makes or resumes a container.
 * - `'synced'`: a container is ready, and no copy runs.
 * - `'syncing'`: heddle copies a file from a container to the folder.
 * - `'conflict'`: a file of the last copies also changed in the folder.
 *   heddle wrote it anyway (the last write wins). The state stays until the
 *   next copy.
 * - `'stopped'`: `stop()` stopped the containers, or a container did not
 *   start.
 */
export type SyncState = 'starting' | 'synced' | 'syncing' | 'conflict' | 'stopped'

/** The project folder in the container. */
export const CONTAINER_ROOT = '/workspace'

/** The Docker sandbox of one project folder. See {@link createSandbox}. */
export interface Sandbox {
  /** It gives each thread its container. Pass it to `workspaceTools({ workspace })`. */
  workspace: WorkspaceBinder
  /** It copies each `FileChanged` from the container to the folder. */
  plugin: HarnessPlugin
  /** The state of the sync now. */
  state(): SyncState
  /** It calls `listener` at each change of the state. It gives a function that stops the calls. */
  onState(listener: (state: SyncState) => void): () => void
  /**
   * It waits for the copies that run and for the closes of the tools. Then
   * it stops the containers. Docker keeps them, so a session can resume.
   */
  stop(): Promise<void>
}

/** The container of a thread, and the sync from it to the folder. */
interface Thread {
  handle: SandboxHandle
  sync: ReturnType<typeof createSync>
}

/** The message when heddle cannot connect to Docker. */
const DOCKER_DOWN =
  'Docker is not running. Start Docker Desktop, or run heddle without --sandbox.'

/**
 * True for the error of a Docker client that cannot connect to Docker: the
 * pipe or the socket is not there (`ENOENT`), or nothing listens on it
 * (`ECONNREFUSED`). dockerode gives the error of the socket as it is, on
 * Node and on Bun.
 */
function isDockerDown(error: unknown) {
  if (!(error instanceof Error) || !('code' in error) || !('syscall' in error)) return false
  const isNoDocker = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
  return isNoDocker && error.syscall === 'connect'
}

/**
 * The Docker sandbox of the sessions of the folder `root`. The agent works in
 * a container, on a copy of `root` at {@link CONTAINER_ROOT}:
 *
 * - `workspace.bind` makes a container for a new thread, from `image`, and
 *   copies `root` into it. `root` must be a git repository, and the image
 *   must have git, like `node:24`.
 * - `workspace.reattach` starts the container of a thread again, when its
 *   session resumes. It gives `'gone'` when Docker has no such container.
 * - `plugin` copies each file that changes in the container to `root` (see
 *   `createSync`). A file that also changed in `root` is still copied (the
 *   last write wins), and `onConflict` gets its path in `root`. A failed copy
 *   goes to `logger`, and the next copy still runs.
 * - `stop` waits for the copies, then stops the containers. Docker keeps
 *   them, so a session can resume.
 *
 * A change counts as a conflict when the file changed in `root` after the
 * container was made or resumed in this process. So after a resume, a change
 * that you made in `root` while heddle was closed does not count.
 *
 * When Docker does not run, `bind` and `reattach` throw
 * `Docker is not running. Start Docker Desktop, or run heddle without --sandbox.`
 * A turn then shows it in the result of its tool calls.
 *
 * `provider` is for tests only. It takes the place of Docker.
 *
 * @example
 * ```ts
 * const sandbox = createSandbox({ root, image: 'node:24', logger, onConflict: warn })
 * workspaceTools({ workspace: sandbox.workspace }) // and add sandbox.plugin
 * await sandbox.stop() // after the sessions closed
 * ```
 */
export function createSandbox(options: {
  root: string
  image: string
  logger: Logger
  onConflict(path: string): void
  provider?: SandboxProvider
}) {
  const { root, image, logger, onConflict } = options
  const provider =
    options.provider ??
    dockerSandbox({
      image,
      // The copy of the folder goes where the tools work.
      workdir: CONTAINER_ROOT,
      // `destroy` stops a container and keeps it, so a session can resume it.
      removeOnDestroy: false,
      logger,
    })
  const paths = { containerRoot: CONTAINER_ROOT, localRoot: root }

  /** The container and the sync of each thread that has one, by thread id. */
  const threads = new Map<string, Thread>()
  /** The copies that run now. */
  const copies = new Set<Promise<void>>()
  /** The closes of the tools that run now. */
  const closes = new Set<Promise<void>>()
  const listeners = new Set<(state: SyncState) => void>()
  let state: SyncState = 'starting'
  /** True when a copy since the last settled state had a conflict. */
  let hasConflict = false

  const setState = (next: SyncState) => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener(next)
  }

  /**
   * For the `.catch()` of a create or a resume: the state is `'stopped'`,
   * and a Docker that does not run gets the clear message.
   */
  const failedStart = (error: unknown) => {
    setState('stopped')
    throw isDockerDown(error) ? new Error(DOCKER_DOWN, { cause: error }) : error
  }

  /**
   * The workspace of the thread `threadId` in the container `handle`, for
   * the tools. The sync of the thread starts with it. `since` is the time
   * when heddle started to make or resume the container.
   */
  const open = (threadId: string, handle: SandboxHandle, since: number) => {
    // `owned`: when a thread ends for good, its backend stops the container.
    const backend = sandboxWorkspaceBackend(handle, { owned: true })
    const sync = createSync(paths, (path) => backend.readFile(path), { since })
    threads.set(threadId, { handle, sync })
    setState(copies.size > 0 ? 'syncing' : 'synced')
    const bound: BoundWorkspace = {
      ...backend,
      root: CONTAINER_ROOT,
      // The tools close the backend when a session closes. `stop` waits for it.
      close: (input) => {
        const closing = backend.close(input).finally(() => closes.delete(closing))
        closes.add(closing)
        return closing
      },
    }
    return bound
  }

  const workspace: WorkspaceBinder = {
    bind: async ({ run }) => {
      // Before the copy into the container, so a change in the folder while
      // the copy runs counts too.
      const since = Date.now()
      setState('starting')
      const handle = await provider
        .create({ workspace: defineWorkspace({ source: localSource(root) }) })
        .catch(failedStart)
      return open(run.threadId, handle, since)
    },
    reattach: async ({ run, binding }) => {
      // As by default: only the host of a folder can continue its thread.
      if (binding.kind === 'host') return 'pinned'
      if (binding.provider !== provider.name) return 'gone'
      const since = Date.now()
      setState('starting')
      // A stopped container starts again.
      const handle = await provider
        .resume({ id: binding.sandboxId })
        .catch(failedStart)
      if (handle === null) {
        setState('stopped')
        return 'gone'
      }
      return open(run.threadId, handle, since)
    },
  }

  /** It copies one change of the container of `thread` to the folder. */
  const copy = async (thread: Thread, change: FileChange) => {
    // A failed copy stops only this change. The sync runs the next one.
    const result = await thread.sync.apply(change).catch((error: unknown) => {
      logger.error(`heddle could not copy ${change.path} from the sandbox to the folder.`, {
        error,
      })
      return undefined
    })
    if (result === 'refused') {
      logger.warn(
        `heddle did not copy ${change.path} from the sandbox, because a write there could go outside the folder.`,
      )
      return
    }
    if (result !== 'conflict') return
    hasConflict = true
    // The path is in the folder, because the sync just wrote it. Only a
    // change of the folder in the meantime can make it undefined.
    onConflict(localPathOf(change.path, paths) ?? change.path)
  }

  const plugin = definePlugin({
    name: 'heddle/sandbox-sync',
    setup: (ctx) => {
      // Every run of a session has the thread of the session.
      const { threadId } = ctx.session
      ctx.on(FileChanged, async (change) => {
        const thread = threads.get(threadId)
        if (thread === undefined) {
          logger.warn(`heddle did not copy ${change.path}, because the thread has no sandbox.`)
          return
        }
        setState('syncing')
        const copied = copy(thread, change).finally(() => {
          copies.delete(copied)
          if (copies.size > 0) return
          setState(hasConflict ? 'conflict' : 'synced')
          hasConflict = false
        })
        // This runs before the first `await`, so `stop` sees the copy at once.
        copies.add(copied)
        // The session logs an error of `onConflict`.
        await copied
      })
    },
  })

  const sandbox: Sandbox = {
    workspace,
    plugin,
    state: () => state,
    onState: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    stop: async () => {
      // A copy can start while `stop` waits, so it waits until none runs.
      while (copies.size > 0 || closes.size > 0) {
        await Promise.allSettled([...copies, ...closes])
      }
      const running = [...threads.values()]
      threads.clear()
      await Promise.all(
        running.map(({ handle }) =>
          // With `removeOnDestroy: false`, Docker stops the container and keeps it.
          handle.destroy().catch((error: unknown) => {
            logger.warn(`heddle could not stop the sandbox ${handle.id}.`, { error })
          }),
        ),
      )
      setState('stopped')
    },
  }
  return sandbox
}
