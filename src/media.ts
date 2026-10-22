// The files that agents make: the image and video agents, and a copy of each
// file in the `heddle-media` folder of the project.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EventType, defineAgent, keyedAdapter } from '@tanstack/ai'
import { createGrokVideo } from '@tanstack/ai-grok'
import { grokByok } from '@tanstack/ai-grok/byok'
import { createOpenaiImage, createOpenaiVideo } from '@tanstack/ai-openai'
import { openaiByok } from '@tanstack/ai-openai/byok'
import { memoryPersistence } from '@tanstack/ai-persistence'
import { isRecord } from './utils'
import type { AnyVideoAdapter, Logger } from '@tanstack/ai'
import type { BlobStore } from '@tanstack/ai-persistence'

/** The folder of the project where heddle saves the files that agents make. */
export const MEDIA_DIR = 'heddle-media'

/** The file extension of each media type. Another type uses its subtype, such as `wav`. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'audio/mpeg': 'mp3',
  'image/svg+xml': 'svg',
}

/**
 * The file of the media `id` in the project `folder`, such as
 * `<folder>/heddle-media/<id>.png`. The id keeps the name unique.
 *
 * @example
 * mediaPath('/code/app', { id: 'artifact-1', mimeType: 'image/png' })
 * // '/code/app/heddle-media/artifact-1.png'
 */
export function mediaPath(folder: string, media: { id: string; mimeType: string }) {
  const subtype = media.mimeType.split('/')[1]?.replace(/\W/g, '')
  const extension = EXTENSIONS[media.mimeType] ?? (subtype || 'bin')
  return join(folder, MEDIA_DIR, `${media.id}.${extension}`)
}

/**
 * A blob store for `createHarnessHost`. It keeps the bytes in memory, as the
 * host does without a store, and it writes a copy of each file that an agent
 * makes to `<folder>/heddle-media/`, at {@link mediaPath}. The copy is
 * there before the view gets the file, so the timeline can show it, also
 * after a restart.
 *
 * ponytail: the memory keeps the bytes until heddle quits, and a restart
 * loses them. The copies stay. Keep the media records in the database too if
 * the model must see old files after a restart.
 *
 * A copy that fails goes to `logger`. The agent still gets its file.
 *
 * @example
 * const persistence = defineAIPersistence({
 *   stores: { ...stores.persistence.stores, blobs: mediaBlobs(root, logger) },
 * })
 */
export function mediaBlobs(folder: string, logger: Logger) {
  const memory = memoryPersistence().stores.blobs
  const blobs: BlobStore = {
    put: async (key, body, options) => {
      const record = await memory.put(key, body, options)
      // The harness saves the files of a request too. Only the files that it made are copied.
      const isMade = options?.customMetadata?.role === 'output'
      // The key is `artifacts/<run id>/<media id>`.
      const id = key.split('/').at(-1)
      if (!isMade || id === undefined) return record
      const path = mediaPath(folder, { id, mimeType: options?.contentType ?? '' })
      try {
        const saved = await memory.get(key)
        if (saved === null) throw new Error(`The memory has no file ${key}.`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, new Uint8Array(await saved.arrayBuffer()))
      } catch (error) {
        logger.warn('heddle could not save a file that an agent made.', { path, error })
      }
      return record
    },
    get: (key, options) => memory.get(key, options),
    head: (key) => memory.head(key),
    delete: (key) => memory.delete(key),
    list: (options) => memory.list(options),
  }
  return blobs
}

// The models of the agents, with the key of the user: the key from
// `/connect <provider>`, else the environment variable.
const gptImage = keyedAdapter(openaiByok, (key) => createOpenaiImage('gpt-image-2.5-flare', key))
const grokImagine = keyedAdapter(grokByok, (key) => createGrokVideo('grok-imagine-video-1.5', key))
const sora = keyedAdapter(openaiByok, (key) => createOpenaiVideo('sora-2', key))

/** The text field `name` of the input of an agent. It throws when the field is missing. */
function textInput(input: unknown, name: string) {
  const value = isRecord(input) ? input[name] : undefined
  if (typeof value !== 'string') throw new Error(`The tool needs a ${name}.`)
  return value
}

/**
 * Makes one image with OpenAI. The main model calls it as the `image` tool.
 * The harness keeps the image, {@link mediaBlobs} saves it in `heddle-media/`,
 * and the timeline shows it.
 *
 * ponytail: no reference images, because the input sends `@` paths as text.
 */
export const imageAgent = defineAgent({
  name: 'image',
  description:
    'Makes one image from a detailed visual prompt. The user sees the image, and heddle saves it in the heddle-media folder of the project.',
  produces: 'image',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'A detailed description of the image' } },
    required: ['prompt'],
    additionalProperties: false,
  },
  run: async (ctx) => {
    const adapter = await ctx.keys.adapter(gptImage)
    const prompt = textInput(ctx.input, 'prompt')
    const result = await ctx.generateImage({ adapter, prompt, size: '1024x1024' })
    if (result.images.length === 0) throw new Error('The image model gave no image.')
    return `Made the image with ${result.model}. The user sees it.`
  },
})

/**
 * Makes one short video: with Grok Imagine when the user has an xAI key,
 * else with Sora. The main model calls it as the `video` tool. The harness
 * keeps only a streamed video, so it uses `stream: true`: one stream from the
 * start of the job to the file.
 */
export const videoAgent = defineAgent({
  name: 'video',
  description:
    'Makes one short video clip from a detailed visual prompt. It takes a minute or two. The user sees the video, and heddle saves it in the heddle-media folder of the project.',
  produces: 'video',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string', description: 'A detailed description of the scene and the motion' } },
    required: ['prompt'],
    additionalProperties: false,
  },
  run: async (ctx) => {
    const hasGrokKey = (await ctx.keys.get(grokByok)) !== null
    const adapter: AnyVideoAdapter = hasGrokKey ? await ctx.keys.adapter(grokImagine) : await ctx.keys.adapter(sora)
    const prompt = textInput(ctx.input, 'prompt')
    for await (const chunk of ctx.generateVideo({ adapter, prompt, stream: true })) {
      // The stream tells of a failed or stopped job with an event. It does not throw.
      if (chunk.type === EventType.RUN_ERROR) throw new Error(chunk.message)
    }
    return `Made the video with ${adapter.model}. The user sees it.`
  },
})
