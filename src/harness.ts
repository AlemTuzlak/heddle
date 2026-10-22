import { join } from 'node:path'
import { keyedAdapter } from '@tanstack/ai'
import { createAnthropicChat } from '@tanstack/ai-anthropic'
import { anthropicByok } from '@tanstack/ai-anthropic/byok'
import { codeMode } from '@tanstack/ai-code-mode/harness'
import { createGrokText } from '@tanstack/ai-grok'
import { grokByok } from '@tanstack/ai-grok/byok'
import { defineHarness } from '@tanstack/ai-harness'
import {
  compact,
  goal,
  modelPicker,
  permissions,
  providerKeys,
  title,
  todos,
  usage,
} from '@tanstack/ai-harness/plugins'
import { snapshots, workspaceTools } from '@tanstack/ai-harness/plugins/coding'
import { agents, projectInstructions } from '@tanstack/ai-harness/plugins/node'
import { createQuickJSIsolateDriver } from '@tanstack/ai-isolate-quickjs'
import { mcp } from '@tanstack/ai-mcp/harness'
import { createOpenaiChat } from '@tanstack/ai-openai'
import { openaiByok } from '@tanstack/ai-openai/byok'
import type { AnyTextAdapter, KeyedAdapter } from '@tanstack/ai'
import type { HarnessPlugin } from '@tanstack/ai-harness'
import type { WorkspaceBinder } from '@tanstack/ai-harness/plugins/coding'
import type { HeddleConfig } from './config'

/** A model that heddle can use. */
export interface ModelChoice {
  /** The name in `/model <name>` and in the config, such as `'opus'`. */
  name: string
  /** The provider of the model. `/connect <provider>` saves its key. */
  provider: 'anthropic' | 'openai' | 'grok'
  /** The model id of the provider, such as `'claude-opus-5-5'`. */
  model: string
  /** The environment variable that can hold the key of the provider. */
  env: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'XAI_API_KEY'
  /**
   * The size of the context window, in tokens, for the context meter.
   * ponytail: copied from `context_window` in each adapter's `model-meta.ts`,
   * because the adapters do not export it. Read it from them when they do.
   */
  contextWindow: number
}

// `as const` keeps each model id as it is: the adapter factories take only
// the model ids that they know.
const CHOICES = [
  {
    name: 'opus',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    env: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
  },
  {
    name: 'sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    env: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
  },
  {
    name: 'haiku',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    env: 'ANTHROPIC_API_KEY',
    contextWindow: 1_000_000,
  },
  {
    name: 'gpt',
    provider: 'openai',
    model: 'gpt-6.1-sol',
    env: 'OPENAI_API_KEY',
    contextWindow: 1_050_000,
  },
  {
    name: 'luna',
    provider: 'openai',
    model: 'gpt-6-luna',
    env: 'OPENAI_API_KEY',
    contextWindow: 1_050_000,
  },
  {
    name: 'grok',
    provider: 'grok',
    model: 'grok-4.7',
    env: 'XAI_API_KEY',
    contextWindow: 500_000,
  },
] as const satisfies ReadonlyArray<ModelChoice>

/**
 * The models of heddle, in the order of a model menu. The first one (`opus`)
 * is the model of a new session when the config names no model.
 *
 * @example
 * ```ts
 * const choice = MODELS.find((each) => each.name === 'gpt')
 * // { name: 'gpt', provider: 'openai', model: 'gpt-6.1-sol', env: 'OPENAI_API_KEY', contextWindow: 1_050_000 }
 * ```
 */
export const MODELS: ReadonlyArray<ModelChoice> = CHOICES

type Choice = (typeof CHOICES)[number]

/**
 * The small model of each provider. It writes the titles and the summaries,
 * and it checks the goals.
 */
const FAST_MODEL: Record<ModelChoice['provider'], Choice['name']> = {
  anthropic: 'haiku',
  openai: 'luna',
  grok: 'grok',
}

/** The coding tools that a code mode program can call. */
const CODE_MODE_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep',
  'edit_file',
  'write_file',
  'patch',
])

/** The folder of the project in the Docker container. */
const CONTAINER_ROOT = '/workspace'

const SYSTEM_PROMPT =
  'You are heddle, a careful coding agent in a terminal. Read the code before you change it. Make small changes, and check your work. Keep your answers short.'

/** The model with the name or the model id `model`. */
function choiceOf(model: string) {
  const choice = CHOICES.find(
    (each) => each.name === model || each.model === model,
  )
  if (choice === undefined) {
    const names = CHOICES.map((each) => each.name).join(', ')
    throw new Error(`Unknown model "${model}". Use one of: ${names}.`)
  }
  return choice
}

/**
 * The adapter of `choice`. The session makes the real adapter before each
 * model call, with the key of the user: the key from `/connect`, else the
 * environment variable.
 */
function keyedAdapterOf(choice: Choice) {
  switch (choice.provider) {
    case 'anthropic': {
      const { model } = choice
      return keyedAdapter(anthropicByok, (key) =>
        createAnthropicChat(model, key),
      )
    }
    case 'openai': {
      const { model } = choice
      return keyedAdapter(openaiByok, (key) => createOpenaiChat(model, key))
    }
    case 'grok': {
      const { model } = choice
      return keyedAdapter(grokByok, (key) => createGrokText(model, key))
    }
  }
}

/**
 * The harness of heddle: the models, the file and shell tools, code mode,
 * the agents, and the MCP servers of the config. Open a session of it with
 * `host.open(harness, { threadId, user })`.
 *
 * The plugins of each session, in order: `providerKeys`, `modelPicker`,
 * `permissions`, `workspaceTools`, `snapshots`, `codeMode` (when
 * `config.codeMode` is set), `goal`, `agents`, `todos`, `title`, `usage`,
 * `compact`, `mcp` (when `config.mcp` has servers), `options.plugins`, and
 * `projectInstructions`. Titles, summaries, and goal checks use the small
 * model of the provider of `model`: `haiku`, `luna`, or `grok`.
 *
 * @param options.root - The local project folder.
 * @param options.home - The home folder of the user. Agent files are read
 *   from `<home>/.heddle/agents` and `<root>/.heddle/agents`. A project agent
 *   replaces a home agent with the same name.
 * @param options.config - The config from `loadConfig`.
 * @param options.model - The model of a new session: a name of {@link MODELS},
 *   or its model id. `/model <name>` changes it in a session.
 * @param options.place - `'local'`: the tools work in `root`. `'docker'`: the
 *   tools work in the container of `workspace`, at `/workspace`.
 * @param options.workspace - The workspace of each thread, from the sandbox.
 *   The docker place needs it.
 * @param options.plugins - More plugins, such as the sync of the sandbox.
 * @param options.snapshotsDir - The folder for the snapshots of the files.
 *   It is on the machine where the tools work: in the docker place, it is a
 *   path in the container.
 * @param options.models - For tests only: an adapter for each model name, in
 *   place of the real models. It must have `model`, and the small model of
 *   its provider.
 * @throws Error when `model` is not a model of {@link MODELS}, when the docker
 *   place has no `workspace`, or when `models` misses a model that the
 *   harness needs.
 *
 * @example
 * ```ts
 * const harness = createHarness({
 *   root: process.cwd(),
 *   home: os.homedir(),
 *   config,
 *   model: config.model ?? MODELS[0].name,
 *   place: 'local',
 *   snapshotsDir: join(os.homedir(), '.heddle', 'snapshots'),
 * })
 * const session = await host.open(harness, { threadId, user: { id: 'local' } })
 * ```
 */
export function createHarness(options: {
  root: string
  home: string
  config: HeddleConfig
  model: string
  place: 'local' | 'docker'
  workspace?: WorkspaceBinder
  plugins?: ReadonlyArray<HarnessPlugin>
  snapshotsDir: string
  models?: Record<string, AnyTextAdapter>
}) {
  const { root, home, config, place, workspace, snapshotsDir } = options
  const isDockerWithoutWorkspace = place === 'docker' && workspace === undefined
  if (isDockerWithoutWorkspace) {
    throw new Error(
      'createHarness: the docker place needs the workspace of the sandbox.',
    )
  }
  const choice = choiceOf(options.model)
  const adapters: Record<
    string,
    AnyTextAdapter | KeyedAdapter<AnyTextAdapter>
  > =
    options.models ??
    Object.fromEntries(CHOICES.map((each) => [each.name, keyedAdapterOf(each)]))
  /** The adapter of the model `name`. Only the `models` of a test can miss one. */
  const adapterOf = (name: string) => {
    const adapter = adapters[name]
    if (adapter === undefined) {
      throw new Error(`createHarness: models has no adapter for "${name}".`)
    }
    return adapter
  }
  const main = adapterOf(choice.name)
  const fast = adapterOf(FAST_MODEL[choice.provider])
  const { codeMode: codeModeConfig } = config
  // One mcp() for the harness, so that its sessions share the stdio servers.
  const servers =
    Object.keys(config.mcp).length > 0 ? [mcp({ servers: config.mcp })] : []
  return defineHarness({
    name: `heddle/${place}`,
    // The model picker picks the model of each turn. This one is used only
    // when no plugin picks a model.
    adapter: main,
    systemPrompts: [SYSTEM_PROMPT],
    plugins: () => [
      providerKeys({ providers: [anthropicByok, openaiByok, grokByok] }),
      modelPicker({ choices: adapters, default: choice.name }),
      // The rules see the paths where the tools work.
      permissions({ root: place === 'docker' ? CONTAINER_ROOT : root }),
      workspaceTools(workspace ? { workspace } : { root }),
      // With a workspace, each thread keeps its snapshots in its own workspace.
      snapshots(
        workspace ? { dataDir: snapshotsDir } : { root, dataDir: snapshotsDir },
      ),
      ...(codeModeConfig
        ? [
            codeMode({
              driver: createQuickJSIsolateDriver(),
              include: (tool) => CODE_MODE_TOOLS.has(tool.name),
              directCalls: codeModeConfig.directCalls,
            }),
          ]
        : []),
      goal({ judge: fast }),
      agents({
        // An agent file names its model by name or by model id. A subagent
        // with no model gets the model id of the turn that starts it.
        adapter: (model) => adapterOf(choiceOf(model).name),
        // A later folder wins, so the project agents come last.
        dirs: [join(home, '.heddle', 'agents'), join(root, '.heddle', 'agents')],
      }),
      todos(),
      title({ adapter: fast }),
      usage(),
      compact({ adapter: fast }),
      ...servers,
      ...(options.plugins ?? []),
      // Last, so that a change of an instruction file keeps the prompt cache.
      projectInstructions({ root }),
    ],
  })
}
