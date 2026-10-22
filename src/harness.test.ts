import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeText } from '@tanstack/ai/testing'
import { createHarnessHost } from '@tanstack/ai-harness'
import { hostBackend } from '@tanstack/ai-harness/plugins/coding'
import { memoryPersistence } from '@tanstack/ai-persistence'
import { MODELS, createHarness } from './harness'
import type { AnyTextAdapter } from '@tanstack/ai'
import type { WorkspaceBinder } from '@tanstack/ai-harness/plugins/coding'
import type { McpServerConfig } from '@tanstack/ai-mcp/harness'
import type { HeddleConfig } from './config'
import { tempFolder } from './test-utils'

/** The config when there is no config file. */
const CONFIG: HeddleConfig = {
  sandbox: false,
  codeMode: { directCalls: 'keep' },
  mcp: {},
}

/**
 * A fake for each model of MODELS. Each fake answers every call with its own
 * model id, so a test can see which model answered.
 */
function fakeModels() {
  const entries = MODELS.map((choice) => {
    const fake = fakeText({ model: choice.model })
    // More answers than a test needs.
    fake.setResponses(Array.from({ length: 10 }, () => ({ text: choice.model })))
    return [choice.name, fake] as const
  })
  return Object.fromEntries(entries)
}

/**
 * A session of the harness, on memory stores, in a new temp folder. `await
 * using` closes the session and the host, then deletes the folder.
 *
 * `models` is fakes by default. `'keyed'` gives the real keyed adapters of
 * heddle: then the test must not send, because a turn needs a real key.
 */
async function openSession(
  options: {
    config?: Partial<HeddleConfig>
    model?: string
    models?: Record<string, AnyTextAdapter> | 'keyed'
    place?: 'local' | 'docker'
    workspace?: WorkspaceBinder
  } = {},
) {
  const folder = tempFolder()
  const root = join(folder.path, 'project')
  mkdirSync(root)
  const harness = createHarness({
    root,
    home: join(folder.path, 'home'),
    config: { ...CONFIG, ...options.config },
    model: options.model ?? 'opus',
    place: options.place ?? 'local',
    workspace: options.workspace,
    snapshotsDir: join(folder.path, 'snapshots'),
    models:
      options.models === 'keyed' ? undefined : (options.models ?? fakeModels()),
  })
  const host = createHarnessHost({ persistence: memoryPersistence() })
  const session = await host.open(harness, {
    threadId: 'thread-1',
    user: { id: 'local' },
  })
  return {
    session,
    root,
    [Symbol.asyncDispose]: async () => {
      await session.close()
      await host.close()
      folder[Symbol.dispose]()
    },
  }
}

/**
 * Opens a session with `config`, and sends one message. Gives the names of
 * the tools that the model got in that turn.
 */
async function toolsOfTurn(config: Partial<HeddleConfig>) {
  const names: Array<string> = []
  const opus = fakeText({ model: 'claude-opus-5-5' })
  opus.setResponses([
    ({ request }) => {
      names.push(...(request.tools ?? []).map((tool) => tool.name))
      return { text: 'done' }
    },
  ])
  await using opened = await openSession({
    config,
    models: { ...fakeModels(), opus },
  })
  await opened.session.send('hello')
  return names
}

test('the local harness has the tools and commands', async () => {
  // The harness as heddle ships it. describe() calls no model.
  await using opened = await openSession({ models: 'keyed' })
  const { tools, commands } = opened.session.describe()
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['read_file', 'edit_file', 'bash']),
  )
  expect(commands.map((command) => command.name)).toEqual(
    expect.arrayContaining([
      'connect:anthropic',
      'connect:openai',
      'connect:grok',
      'goal',
    ]),
  )
  // Code mode adds its tool when a turn starts, so describe() does not list it.
  expect(await toolsOfTurn({})).toContain('execute_typescript')
})

test('codeMode false has no execute_typescript', async () => {
  const tools = await toolsOfTurn({ codeMode: false })
  expect(tools).toContain('read_file')
  expect(tools).not.toContain('execute_typescript')
})

test('directCalls remove leaves only programs for the coding tools', async () => {
  const tools = await toolsOfTurn({ codeMode: { directCalls: 'remove' } })
  expect(tools).toContain('execute_typescript')
  expect(tools).not.toContain('read_file')
  // Code mode does not take bash, so the model still calls it directly.
  expect(tools).toContain('bash')
})

test('an mcp server adds connect:linear', async () => {
  const requests: Array<string | URL | Request> = []
  const linear: McpServerConfig = {
    type: 'http',
    // Nothing listens on port 9, so a request that gets past `fetch` fails at once.
    url: 'http://127.0.0.1:9/mcp',
    oauth: true,
    fetch: Object.assign(
      async (input: string | URL | Request) => {
        requests.push(input)
        throw new Error('This test makes no network calls.')
      },
      { preconnect: fetch.preconnect },
    ),
  }
  await using opened = await openSession({ config: { mcp: { linear } } })
  const { commands } = opened.session.describe()
  expect(commands.map((command) => command.name)).toEqual(
    expect.arrayContaining(['connect:linear', 'disconnect:linear']),
  )
  expect(requests).toEqual([])
})

test.each([
  ['opus', ['fake/claude-haiku-5-5', 'fake/claude-opus-5-5']],
  ['gpt', ['fake/gpt-6-luna', 'fake/gpt-6.1-sol']],
  ['grok', ['fake/grok-4.7']],
])('fast follows the provider: %s', async (model, answered) => {
  await using opened = await openSession({ model })
  await opened.session.send('one')
  await opened.session.send('two')
  // The summary of /compact comes from the small model of the provider.
  await opened.session.runCommand({ name: 'compact' })
  const { byModel } = opened.session.usage()
  expect(Object.keys(byModel).sort()).toEqual(answered)
})

test('the docker harness works in the bound workspace', async () => {
  using container = tempFolder()
  writeFileSync(join(container.path, 'note.txt'), 'from the container')
  const workspace: WorkspaceBinder = {
    bind: async () => ({ ...hostBackend, root: container.path }),
  }
  const results: Array<string> = []
  const opus = fakeText({ model: 'claude-opus-5-5' })
  opus.setResponses([
    { toolCalls: [{ name: 'read_file', input: { path: 'note.txt' } }] },
    ({ request }) => {
      for (const { role, content } of request.messages) {
        const isToolText = role === 'tool' && typeof content === 'string'
        if (isToolText) results.push(content)
      }
      return { text: 'done' }
    },
  ])
  await using opened = await openSession({
    place: 'docker',
    workspace,
    models: { ...fakeModels(), opus },
  })
  writeFileSync(join(opened.root, 'note.txt'), 'from the folder')
  await opened.session.send('read the note')
  expect(results.join('\n')).toContain('from the container')
})

/** Makes the harness with `overrides`. It opens no session, so no folder is used. */
function createWith(overrides: Partial<Parameters<typeof createHarness>[0]>) {
  return () =>
    createHarness({
      root: '/project',
      home: '/home',
      config: CONFIG,
      model: 'opus',
      place: 'local',
      snapshotsDir: '/snapshots',
      ...overrides,
    })
}

test('an unknown model name throws', () => {
  expect(createWith({ model: 'gpt5' })).toThrow(
    new Error(
      'Unknown model "gpt5". Use one of: opus, sonnet, haiku, gpt, luna, grok.',
    ),
  )
})

test('the docker place without a workspace throws', () => {
  expect(createWith({ place: 'docker' })).toThrow(
    new Error(
      'createHarness: the docker place needs the workspace of the sandbox.',
    ),
  )
})

test('models without the small model of the provider throws', () => {
  expect(createWith({ models: { opus: fakeText() } })).toThrow(
    new Error('createHarness: models has no adapter for "haiku".'),
  )
})
