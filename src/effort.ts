import { REASONING_LEVELS, type ReasoningLevel } from '@tanstack/ai'
import { configOption, defineCommand, definePlugin } from '@tanstack/ai-harness'

/** `default` lets the model decide. The other choices are the reasoning levels. */
export const EFFORTS: ReadonlyArray<'default' | ReasoningLevel> = ['default', ...REASONING_LEVELS]

/**
 * `/effort` and the `effort` setting: how hard the model thinks from the next
 * turn. A level goes to `chat({ reasoning })`. The adapter changes a level
 * that the model does not have to the nearest level that it has. `default`
 * sends no level. Ported from the effort plugin of the harness-cli example.
 *
 * @example
 * defineHarness({ plugins: () => [effortPicker()] })
 * // then: /effort high
 */
export function effortPicker() {
  return definePlugin({
    name: 'heddle/effort',
    setup: (ctx) => {
      const current = () => EFFORTS.find((effort) => effort === ctx.config.get('effort')) ?? 'default'
      return {
        config: {
          effort: configOption.select({
            options: EFFORTS,
            default: 'default',
            category: 'thought_level',
            description: 'How hard the model thinks',
          }),
        },
        middleware: [
          {
            name: 'heddle/effort',
            onConfig: () => {
              const effort = current()
              return effort === 'default' ? undefined : { reasoning: { level: effort, summary: true } }
            },
          },
        ],
        commands: {
          effort: defineCommand({
            description: 'Show or set how hard the model thinks: /effort <level>',
            run: async (input: unknown) => {
              const name = typeof input === 'string' ? input.trim() : ''
              if (name === '') return `Effort: ${current()}. Choices: ${EFFORTS.join(', ')}.`
              const effort = EFFORTS.find((item) => item === name)
              if (effort === undefined) return `Unknown effort "${name}". Choices: ${EFFORTS.join(', ')}.`
              await ctx.session.setPluginSetting({ key: 'effort', value: effort })
              return `Effort: ${effort}. It applies at the next turn.`
            },
          }),
        },
      }
    },
  })
}
