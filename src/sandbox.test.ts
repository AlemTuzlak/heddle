import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeText } from '@tanstack/ai/testing'
import { createHarnessHost, defineHarness, definePlugin } from '@tanstack/ai-harness'
import { FileChanged, workspaceTools } from '@tanstack/ai-harness/plugins/coding'
import { memoryPersistence } from '@tanstack/ai-persistence'
import { CONTAINER_ROOT, createSandbox } from './sandbox'
import type { Logger } from '@tanstack/ai'
import type { FakeResponseStep } from '@tanstack/ai/testing'
import type { HarnessPersistence } from '@tanstack/ai-harness'
import type { FileChange } from '@tanstack/ai-harness/plugins/coding'
import type {
  SandboxCapabilities,
  SandboxCreateInput,
  SandboxHandle,
  SandboxProvider,
} from '@tanstack/ai-sandbox'
import type { SyncState } from './sandbox'

const THREAD = 'thread-1'
/** The id of the first container of the fake Docker. */
const FIRST = 'container-1'
const DOCKER_DOWN =
  'Docker is not running. Start Docker Desktop, or run heddle without --sandbox.'

const encode = (text: string) => new TextEncoder().encode(text)

/** A logger that says nothing, for the host. */
const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** What the fake container can do: files only. */
const CAPABILITIES: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: false,
  ports: false,
  backgroundProcesses: false,
  writableStdin: false,
  killableProcesses: false,
  snapshots: false,
  networkPolicy: false,
  durableFilesystem: true,
  fork: false,
}

/** A part of the sandbox contract that heddle must not use here. */
const unsupported = async () => {
  throw new Error('The fake Docker cannot do this.')
}

/** A container of the fake Docker. */
interface FakeContainer {
  /** The files, by their path in the container. */
  files: Map<string, Uint8Array>
  /** False after a stop. A stopped container stays, so it can resume. */
  running: boolean
}

/**
 * A fake Docker that keeps its containers in memory. It copies no folder
 * in. After `hold()`, each read of a container file waits for `release()`.
 */
function fakeDocker() {
  const containers = new Map<string, FakeContainer>()
  /** The input of each create, oldest first. */
  const created: Array<SandboxCreateInput> = []
  /** The id of each resume, oldest first. */
  const resumed: Array<string> = []
  let reads = Promise.resolve()

  const handleOf = (id: string, container: FakeContainer) => {
    const { files } = container
    /** True for the root, for the workspace, and for a folder of a file. */
    const isFolder = (path: string) =>
      path === '/' ||
      path === CONTAINER_ROOT ||
      [...files.keys()].some((file) => file.startsWith(`${path}/`))
    const readBytes = async (path: string) => {
      await reads
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`The container has no file ${path}.`)
      return bytes
    }
    return {
      id,
      provider: 'fake-docker',
      capabilities: CAPABILITIES,
      fs: {
        read: async (path) => new TextDecoder().decode(await readBytes(path)),
        readBytes,
        write: async (path, data) => {
          files.set(path, typeof data === 'string' ? encode(data) : data)
        },
        list: unsupported,
        mkdir: unsupported,
        remove: unsupported,
        rename: unsupported,
        exists: async (path) => files.has(path) || isFolder(path),
        lstat: async (path) => {
          const bytes = files.get(path)
          if (bytes !== undefined) return { type: 'file', mode: 0o100644, size: bytes.byteLength }
          return isFolder(path) ? { type: 'dir', mode: 0o40755 } : undefined
        },
      },
      git: {
        clone: unsupported,
        status: unsupported,
        add: unsupported,
        commit: unsupported,
        push: unsupported,
        pull: unsupported,
        branch: unsupported,
      },
      process: { exec: unsupported, spawn: unsupported },
      ports: { connect: unsupported },
      env: { set: unsupported },
      destroy: async () => {
        container.running = false
      },
    } satisfies SandboxHandle
  }

  const provider: SandboxProvider = {
    name: 'fake-docker',
    capabilities: () => CAPABILITIES,
    create: async (input) => {
      created.push(input)
      const id = `container-${containers.size + 1}`
      const container = { files: new Map<string, Uint8Array>(), running: true }
      containers.set(id, container)
      return handleOf(id, container)
    },
    resume: async ({ id }) => {
      resumed.push(id)
      const container = containers.get(id)
      if (container === undefined) return null
      container.running = true
      return handleOf(id, container)
    },
    destroy: unsupported,
  }

  return {
    provider,
    created,
    resumed,
    /** The container `id`. It throws when Docker has none. */
    container: (id: string) => {
      const container = containers.get(id)
      if (container === undefined) throw new Error(`The fake Docker has no container ${id}.`)
      return container
    },
    /** From now on, the reads of container files wait for `release()`. */
    hold: () => {
      const gate = Promise.withResolvers<void>()
      reads = gate.promise
      return { release: () => gate.resolve() }
    },
  }
}

/**
 * The error that dockerode gives when Docker Desktop does not run on
 * Windows. A probe on Bun 1.4.2 gave this shape.
 */
const dockerDownError = () =>
  Object.assign(new Error('connect ENOENT //./pipe/docker_engine'), {
    code: 'ENOENT',
    errno: -4058,
    syscall: 'connect',
    address: '//./pipe/docker_engine',
  })

/** A plugin that sends `FileChanged` in its session, as the workspace tools do. */
function changeSender() {
  let emit: (change: FileChange) => void = () => {
    throw new Error('The session is not open.')
  }
  const plugin = definePlugin({
    name: 'test/file-changes',
    setup: (ctx) => {
      emit = (change) => ctx.emit(FileChanged, change)
    },
  })
  return { plugin, send: (change: FileChange) => emit(change) }
}

/** A temp project folder. `await using` removes it. */
async function tempFolder() {
  const root = await mkdtemp(join(tmpdir(), 'heddle-sandbox-'))
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) }
}

/**
 * heddle with `--sandbox` in `root`: the sandbox on `provider`, and the open
 * session {@link THREAD} of a harness with the workspace tools, the sync
 * plugin, and a {@link changeSender}. The fake model gives `answers`, then
 * `ok`. `await using` closes the host.
 */
async function startHeddle(options: {
  root: string
  provider: SandboxProvider
  answers?: Array<FakeResponseStep>
  persistence?: HarnessPersistence
}) {
  /** The warnings and errors of the sandbox. */
  const logged: Array<string> = []
  const conflicts: Array<string> = []
  const states: Array<SyncState> = []
  const logger: Logger = {
    ...quiet,
    warn: (message) => {
      logged.push(message)
    },
    error: (message) => {
      logged.push(message)
    },
  }
  const sandbox = createSandbox({
    root: options.root,
    image: 'node:24',
    logger,
    onConflict: (path) => {
      conflicts.push(path)
    },
    provider: options.provider,
  })
  sandbox.onState((state) => {
    states.push(state)
  })
  const changes = changeSender()
  const model = fakeText()
  const ok = Array.from({ length: 4 }, () => ({ text: 'ok' }))
  model.setResponses([...(options.answers ?? []), ...ok])
  const harness = defineHarness({
    name: 'heddle/sandbox-test',
    adapter: model,
    plugins: () => [
      workspaceTools({ workspace: sandbox.workspace }),
      sandbox.plugin,
      changes.plugin,
    ],
  })
  const host = createHarnessHost({
    persistence: options.persistence ?? memoryPersistence(),
    logger: quiet,
  })
  const session = await host.open(harness, { threadId: THREAD })
  return {
    sandbox,
    session,
    logged,
    conflicts,
    states,
    /** It sends `FileChanged` for the container file `path`. */
    changed: (path: string) =>
      changes.send({ path, change: 'updated', additions: 0, deletions: 0 }),
    [Symbol.asyncDispose]: () => host.close(),
  }
}

/** An answer of the model: a `write_file` call that writes `content` to `path`. */
const writeAnswer = (path: string, content: string) => ({
  toolCalls: [{ name: 'write_file', input: { path, content } }],
})

test('bind passes localSource(root) to the provider', async () => {
  await using folder = await tempFolder()
  const docker = fakeDocker()
  await using heddle = await startHeddle({ root: folder.root, provider: docker.provider })
  // The tools bind the thread before its first turn.
  await heddle.session.send('hi')
  expect(docker.created.map((input) => input.workspace?.source)).toEqual([
    { type: 'local', path: folder.root },
  ])
})

test('a FileChanged copies the file back', async () => {
  await using folder = await tempFolder()
  const docker = fakeDocker()
  await using heddle = await startHeddle({
    root: folder.root,
    provider: docker.provider,
    answers: [writeAnswer('src/a.ts', 'export const a = 1\n')],
  })
  await heddle.session.send('write src/a.ts')
  await heddle.sandbox.stop()
  expect(await readFile(join(folder.root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

test('a conflict calls onConflict, and the state is conflict', async () => {
  await using folder = await tempFolder()
  const docker = fakeDocker()
  await using heddle = await startHeddle({ root: folder.root, provider: docker.provider })
  await heddle.session.send('hi')
  // The user changes the file in the folder after the copy into the container.
  const local = join(folder.root, 'a.ts')
  await writeFile(local, 'mine')
  const later = new Date(Date.now() + 60_000)
  await utimes(local, later, later)
  docker.container(FIRST).files.set('/workspace/a.ts', encode('agent'))
  heddle.changed('/workspace/a.ts')
  await heddle.sandbox.stop()
  expect(heddle.conflicts).toEqual([local])
  expect(heddle.states).toEqual(['synced', 'syncing', 'conflict', 'stopped'])
})

test('reattach resumes the same container', async () => {
  await using folder = await tempFolder()
  const docker = fakeDocker()
  const persistence = memoryPersistence()
  {
    await using first = await startHeddle({
      root: folder.root,
      provider: docker.provider,
      persistence,
      answers: [writeAnswer('a.ts', 'one')],
    })
    await first.session.send('write a.ts')
    // heddle exits: the session closes, then the sandbox stops.
    await first.session.close()
    await first.sandbox.stop()
    expect(docker.container(FIRST).running).toBe(false)
  }
  // heddle starts again, and the session resumes.
  await using second = await startHeddle({
    root: folder.root,
    provider: docker.provider,
    persistence,
    answers: [writeAnswer('b.ts', 'two')],
  })
  await second.session.send('write b.ts')
  await second.sandbox.stop()
  expect(docker.created).toHaveLength(1)
  expect(docker.resumed).toEqual([FIRST])
  expect([...docker.container(FIRST).files.keys()].sort()).toEqual([
    '/workspace/a.ts',
    '/workspace/b.ts',
  ])
  expect(await readFile(join(folder.root, 'b.ts'), 'utf8')).toBe('two')
})

test('stop waits for a running copy', async () => {
  await using folder = await tempFolder()
  const docker = fakeDocker()
  await using heddle = await startHeddle({ root: folder.root, provider: docker.provider })
  await heddle.session.send('hi')
  const container = docker.container(FIRST)
  container.files.set('/workspace/a.ts', encode('agent'))
  const gate = docker.hold()
  heddle.changed('/workspace/a.ts')
  let isStopped = false
  const stopped = heddle.sandbox.stop().then(() => {
    isStopped = true
  })
  await Bun.sleep(50)
  // The copy waits for its read, so the container still runs.
  expect(isStopped).toBe(false)
  expect(container.running).toBe(true)
  gate.release()
  await stopped
  expect(await readFile(join(folder.root, 'a.ts'), 'utf8')).toBe('agent')
  expect(container.running).toBe(false)
})

test('Docker not running gives the clear message', async () => {
  await using folder = await tempFolder()
  const down: SandboxProvider = {
    ...fakeDocker().provider,
    create: () => Promise.reject(dockerDownError()),
  }
  // What the model gets back from its tool call.
  let toolResults = ''
  const readResults: FakeResponseStep = ({ request }) => {
    const results = request.messages.filter((message) => message.role === 'tool')
    toolResults = JSON.stringify(results.map((message) => message.content))
    return { text: 'ok' }
  }
  await using heddle = await startHeddle({
    root: folder.root,
    provider: down,
    answers: [writeAnswer('a.ts', 'agent'), readResults],
  })
  await heddle.session.send('write a.ts')
  expect(toolResults).toContain(DOCKER_DOWN)
  expect(heddle.sandbox.state()).toBe('stopped')
})

test('a failed copy goes to the log', async () => {
  await using folder = await tempFolder()
  const docker = fakeDocker()
  await using heddle = await startHeddle({ root: folder.root, provider: docker.provider })
  await heddle.session.send('hi')
  // The container has no such file, so the read for the copy fails.
  heddle.changed('/workspace/gone.ts')
  await heddle.sandbox.stop()
  expect(heddle.logged).toEqual([
    'heddle could not copy /workspace/gone.ts from the sandbox to the folder.',
  ])
})
