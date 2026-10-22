import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeText } from '@tanstack/ai/testing'
import { MODELS } from './harness'
import { createFileLogger, startHeddle } from './session'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { FakeResponse, FakeResponseStep } from '@tanstack/ai/testing'
import type { SessionView, SessionViewState } from '@tanstack/ai-harness/view'
import type { HeddleConfig } from './config'
import type { Heddle } from './session'
import { tempFolder } from './test-utils'

/** The config of the tests: no sandbox, no code mode, and no MCP servers. */
const CONFIG: HeddleConfig = { sandbox: false, codeMode: false, mcp: {} }

/** No test signs in. If one did, this keeps the browser closed. */
const noBrowser = () => {}

/** A fake with no answers for each model of MODELS, with its real model id. */
function silentModels() {
  return Object.fromEntries(
    MODELS.map((choice) => [choice.name, fakeText({ model: choice.model })] as const),
  )
}

/** A fake opus that gives `answers`, one for each model call. */
function opusWith(answers: Array<FakeResponseStep>) {
  const opus = fakeText({ model: 'claude-opus-5-5' })
  opus.setResponses(answers)
  return opus
}

/**
 * A model call that answers only when heddle stops its turn, as when the
 * user quits. `called` resolves when the call starts.
 */
function stalledCall() {
  const called = Promise.withResolvers<void>()
  const step: FakeResponseStep = ({ request }) => {
    called.resolve()
    const signal = request.request?.signal ?? request.abortController?.signal
    const answer = Promise.withResolvers<FakeResponse>()
    signal?.addEventListener('abort', () => answer.resolve({ error: 'The turn stopped.' }), {
      once: true,
    })
    return answer.promise
  }
  return { step, called: called.promise }
}

/** What a test can change in {@link start}. */
interface StartOptions {
  /** The temp folder of the test. The home and the projects are in it. */
  folder: string
  /** The name of the project folder. Default `project`. */
  project?: string
  /** The fake of opus, the model of the turns. Default: a fake with no answers. */
  opus?: AnyTextAdapter
}

/**
 * heddle in the project `<folder>/<project>`, with the home `<folder>/home`.
 * The other models are fakes with no answers, so each title call fails, and
 * no session gets a title by itself. `await using` quits heddle.
 */
async function start({
  folder,
  project = 'project',
  opus = fakeText({ model: 'claude-opus-5-5' }),
}: StartOptions) {
  const root = join(folder, project)
  mkdirSync(root, { recursive: true })
  const heddle = await startHeddle({
    root,
    home: join(folder, 'home'),
    config: CONFIG,
    models: { ...silentModels(), opus },
    openUrl: noBrowser,
  })
  return { ...heddle, [Symbol.asyncDispose]: () => heddle.shutdown() }
}

/** Starts heddle, runs `steps`, then quits heddle, also after an error. Gives what `steps` gives. */
async function runAndQuit<T>(options: StartOptions, steps: (heddle: Heddle) => Promise<T>) {
  await using heddle = await start(options)
  // `return await`, so the steps end before heddle quits.
  return await steps(heddle)
}

/** Clears the key variables of the providers for one test. `using` puts them back. */
function withoutEnvKeys() {
  const names = [...new Set(MODELS.map((choice) => choice.env))]
  const saved = names.map((name) => [name, process.env[name]] as const)
  for (const name of names) delete process.env[name]
  return {
    [Symbol.dispose]: () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
  }
}

/** Resolves with the state of `view` when `isDone` is true for it. */
function waitFor(view: SessionView, isDone: (state: SessionViewState) => boolean) {
  const { promise, resolve } = Promise.withResolvers<SessionViewState>()
  const check = (state: SessionViewState) => {
    if (isDone(state)) resolve(state)
  }
  const subscription = view.store.subscribe(check)
  check(view.store.get())
  return promise.finally(() => subscription.unsubscribe())
}

/** Resolves when the next chat turn of `view` ends. */
function nextTurnEnd(view: SessionView) {
  const { promise, resolve } = Promise.withResolvers<void>()
  const stop = view.on('turnEnd', () => resolve())
  return promise.finally(stop)
}

/** Sends `text` in `view`, and resolves when its turn ends. */
async function sendAndWait(view: SessionView, text: string) {
  const ended = nextTurnEnd(view)
  await view.send(text)
  await ended
}

/** The text of each user and assistant message of `state`. The notices of the view are left out. */
function textsOf(state: SessionViewState) {
  return state.messages.flatMap((message) => {
    switch (message.role) {
      case 'user':
        return [message.text]
      case 'assistant':
        return [message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')]
      case 'notice':
        return []
    }
  })
}

test('the file logger leaves out secret fields', () => {
  using folder = tempFolder()
  // The logs folder does not exist yet: the logger makes it.
  const path = join(folder.path, 'logs', 'heddle.log')
  const logger = createFileLogger(path)
  logger.warn('The copy failed.', {
    path: 'src/a.ts',
    apiKey: 'sk-test-123',
    auth: { accessToken: 'token-123', user: 'ana' },
    error: new Error('Disk full'),
  })
  const text = readFileSync(path, 'utf8')
  expect(text).toMatch(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z warn The copy failed\. \{"path":"src\/a\.ts","auth":\{"user":"ana"\}\}\nError: Disk full\n/,
  )
  expect(text).not.toContain('sk-test-123')
  expect(text).not.toContain('token-123')
})

test('a new session is listed for the folder', async () => {
  using folder = tempFolder()
  // A session of another project, in the same home.
  await using other = await start({ folder: folder.path, project: 'other' })
  await other.open()
  await using heddle = await start({ folder: folder.path })
  const { threadId } = await heddle.open()
  expect(await heddle.listSessions()).toEqual([
    {
      id: threadId,
      title: 'New session',
      status: 'done',
      place: 'local',
      updatedAt: expect.any(Number),
    },
  ])
})

test('latest gives the newest', async () => {
  using folder = tempFolder()
  await using heddle = await start({ folder: folder.path })
  expect(await heddle.latest()).toBeUndefined()
  await heddle.open()
  // So the second session gets a later time.
  await Bun.sleep(5)
  const { threadId } = await heddle.open()
  expect(await heddle.latest()).toBe(threadId)
})

test('a running session is live in the list', async () => {
  using folder = tempFolder()
  const reply = Promise.withResolvers<void>()
  const opus = opusWith([
    async () => {
      await reply.promise
      return { text: 'Done.' }
    },
  ])
  await using heddle = await start({ folder: folder.path, opus })
  const { view } = await heddle.open()
  const ended = nextTurnEnd(view)
  await view.send('hello')
  await waitFor(view, (state) => state.status === 'running')
  const statuses = (await heddle.listSessions()).map((row) => row.status)
  // The model answers, so the turn ends before heddle quits.
  reply.resolve()
  await ended
  expect(statuses).toEqual(['live'])
})

test('close and open again keeps the messages', async () => {
  using folder = tempFolder()
  const threadId = await runAndQuit(
    { folder: folder.path, opus: opusWith([{ text: 'Hi there.' }]) },
    async (heddle) => {
      const opened = await heddle.open()
      await sendAndWait(opened.view, 'hello')
      await opened.close()
      return opened.threadId
    },
  )
  await using heddle = await start({ folder: folder.path })
  const { view } = await heddle.open(threadId)
  await view.ready
  expect(textsOf(view.store.get())).toEqual(['hello', 'Hi there.'])
})

test('an approval waits again after a reopen', async () => {
  using folder = tempFolder()
  const bash = { toolCalls: [{ name: 'bash', input: { command: 'npm test' } }] }
  // The user quits while the approval waits.
  await runAndQuit({ folder: folder.path, opus: opusWith([bash]) }, async (heddle) => {
    const { view } = await heddle.open()
    await view.send('run the tests')
    await waitFor(view, (state) => state.status === 'requires_action')
  })
  // Then `heddle -c` opens the newest session.
  await using heddle = await start({
    folder: folder.path,
    opus: opusWith([{ text: 'I did not run the tests.' }]),
  })
  expect((await heddle.listSessions()).map((row) => row.status)).toEqual(['needs-you'])
  const { view } = await heddle.open(await heddle.latest())
  await view.ready
  const { approvals } = view.store.get()
  expect(approvals.map((approval) => approval.tool)).toEqual(['bash'])
  // The user can answer it: a no goes back to the model.
  const ended = nextTurnEnd(view)
  view.reject({ id: approvals[0].id })
  await ended
  expect(view.store.get().approvals).toEqual([])
  expect(textsOf(view.store.get()).at(-1)).toBe('I did not run the tests.')
})

test('a turn that runs at quit goes on after a reopen', async () => {
  using folder = tempFolder()
  const stalled = stalledCall()
  // The user quits while the model works on its answer.
  const threadId = await runAndQuit(
    { folder: folder.path, opus: opusWith([stalled.step]) },
    async (heddle) => {
      const { view, threadId } = await heddle.open()
      await view.send('hello')
      await stalled.called
      return threadId
    },
  )
  // The open runs the turn again, and the model answers this time.
  await using heddle = await start({ folder: folder.path, opus: opusWith([{ text: 'Done.' }]) })
  const { view } = await heddle.open(threadId)
  const state = await waitFor(view, (current) => textsOf(current).includes('Done.'))
  expect(textsOf(state)).toEqual(['hello', 'Done.'])
})

test('rename changes the title', async () => {
  using folder = tempFolder()
  await using heddle = await start({ folder: folder.path })
  const { threadId } = await heddle.open()
  await heddle.rename(threadId, 'Fix the add test')
  expect((await heddle.listSessions()).map((row) => row.title)).toEqual(['Fix the add test'])
  await expect(heddle.rename('no-such-session', 'Lost')).rejects.toThrow(
    'heddle has no session no-such-session.',
  )
})

test('fork gives a new id', async () => {
  using folder = tempFolder()
  await using heddle = await start({
    folder: folder.path,
    opus: opusWith([{ text: 'Hi there.' }]),
  })
  const source = await heddle.open()
  await sendAndWait(source.view, 'hello')
  await heddle.rename(source.threadId, 'Say hello')
  const forkId = await heddle.fork(source.threadId)
  expect(forkId).not.toBe(source.threadId)
  const rows = await heddle.listSessions()
  expect(Object.fromEntries(rows.map((row) => [row.id, row.title]))).toEqual({
    [source.threadId]: 'Say hello',
    [forkId]: 'Say hello (fork)',
  })
  const fork = await heddle.open(forkId)
  await fork.view.ready
  expect(textsOf(fork.view.store.get())).toEqual(['hello', 'Hi there.'])
})

test('a docker session opens in docker again', async () => {
  using folder = tempFolder()
  await using heddle = await start({ folder: folder.path })
  // No turn runs, so heddle makes no container and does not call Docker.
  const first = await heddle.open(undefined, { place: 'docker' })
  expect({ place: first.place, root: first.root, sync: first.sync?.state() }).toEqual({
    place: 'docker',
    root: '/workspace',
    sync: 'starting',
  })
  await first.close()
  // The config has no sandbox, so only the session can say docker.
  const again = await heddle.open(first.threadId)
  expect(again.place).toBe('docker')
  expect((await heddle.listSessions()).map((row) => row.place)).toEqual(['docker'])
})

test('missingKey gives anthropic without a key', async () => {
  using _keys = withoutEnvKeys()
  using folder = tempFolder()
  await using heddle = await start({ folder: folder.path })
  const { missingKey } = await heddle.open()
  expect(await missingKey()).toBe('anthropic')
  process.env.ANTHROPIC_API_KEY = 'sk-env-123'
  expect(await missingKey()).toBeUndefined()
})

test('missingKey follows the model of the session', async () => {
  using _keys = withoutEnvKeys()
  using folder = tempFolder()
  await using heddle = await start({ folder: folder.path })
  const { view, missingKey } = await heddle.open()
  await view.runCommand({ name: 'model', input: 'gpt' })
  await waitFor(view, (state) =>
    state.config.some((entry) => entry.key === 'model' && entry.value === 'gpt'),
  )
  expect(await missingKey()).toBe('openai')
})

test('the log file has no secret', async () => {
  using _keys = withoutEnvKeys()
  using folder = tempFolder()
  await runAndQuit({ folder: folder.path }, async (heddle) => {
    const { view, missingKey } = await heddle.open()
    await view.runCommand({ name: 'connect:anthropic' })
    const { questions } = await waitFor(view, (state) =>
      state.questions.some((question) => question.secret === true),
    )
    await questions[0].answer('sk-test-123')
    await waitFor(view, (state) =>
      state.messages.some(
        (message) => message.role === 'notice' && message.text.startsWith('Connected to Anthropic'),
      ),
    )
    // The saved key counts.
    expect(await missingKey()).toBeUndefined()
  })
  const log = readFileSync(join(folder.path, 'home', '.heddle', 'logs', 'heddle.log'), 'utf8')
  // The logger wrote while the key went in.
  expect(log).toContain('heddle opened session')
  expect(log).not.toContain('sk-test-123')
})
