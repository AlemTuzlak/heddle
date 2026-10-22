import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateImage } from '@tanstack/ai'
import {
  defineAIPersistence,
  memoryPersistence,
  withGenerationPersistence,
} from '@tanstack/ai-persistence'
import { MEDIA_DIR, mediaBlobs, mediaPath } from './media'
import { tempFolder } from './test-utils'
import type { ImageAdapter, Logger } from '@tanstack/ai'

/** A PNG of 4 × 4 pixels: red at the top, blue at the bottom. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP4z8AARwwoHDQuggMAnqMP8dxMDd4AAAAASUVORK5CYII='

/** A logger that keeps the warnings. */
function warnings() {
  const messages: Array<string> = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message) => messages.push(message),
    error: () => {},
  }
  return { logger, messages }
}

/** An image model that gives the {@link PNG} as base64. */
function imageModel() {
  const adapter: ImageAdapter<string> = {
    kind: 'image',
    name: 'test-image-provider',
    model: 'test-image-model',
    '~types': {
      providerOptions: {},
      modelProviderOptionsByName: {},
      modelSizeByName: {},
      modelInputModalitiesByName: {},
    },
    generateImages: async () => ({ id: 'result-1', model: 'test-image-model', images: [{ b64Json: PNG }] }),
  }
  return adapter
}

test('mediaPath names the file by its id, with the extension of its type', () => {
  expect(mediaPath('/code/app', { id: 'artifact-1', mimeType: 'image/png' })).toBe(
    join('/code/app', MEDIA_DIR, 'artifact-1.png'),
  )
  expect(mediaPath('/code/app', { id: 'a', mimeType: 'image/jpeg' })).toEndWith('a.jpg')
  expect(mediaPath('/code/app', { id: 'a', mimeType: 'audio/mpeg' })).toEndWith('a.mp3')
  expect(mediaPath('/code/app', { id: 'a', mimeType: '' })).toEndWith('a.bin')
})

test('an image that a model made is saved in heddle-media, and the harness still reads it', async () => {
  using folder = tempFolder()
  const { logger, messages } = warnings()
  const memory = memoryPersistence().stores
  const persistence = defineAIPersistence({
    stores: {
      artifacts: memory.artifacts,
      generationRuns: memory.generationRuns,
      blobs: mediaBlobs(folder.path, logger),
    },
  })
  const result = await generateImage({
    adapter: imageModel(),
    prompt: 'a red and blue square',
    threadId: 'thread-1',
    middleware: [withGenerationPersistence(persistence)],
  })
  const made = result.artifacts?.[0]
  if (made === undefined) throw new Error('The persistence kept no image.')
  const png = new Uint8Array(Buffer.from(PNG, 'base64'))
  const file = mediaPath(folder.path, { id: made.artifactId, mimeType: made.mimeType })
  expect(new Uint8Array(readFileSync(file))).toEqual(png)
  const kept = await persistence.stores.blobs.get(`artifacts/${made.runId}/${made.artifactId}`)
  expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(png)
  expect(messages).toEqual([])
})

test('a file of a request is kept in memory only', async () => {
  using folder = tempFolder()
  const blobs = mediaBlobs(folder.path, warnings().logger)
  await blobs.put('artifacts/run-1/artifact-1', new Uint8Array([1, 2, 3]), {
    contentType: 'image/png',
    customMetadata: { role: 'input' },
  })
  expect(existsSync(join(folder.path, MEDIA_DIR))).toBe(false)
  expect(await blobs.head('artifacts/run-1/artifact-1')).not.toBeNull()
})

test('a copy that fails is logged, and the file is still kept', async () => {
  using folder = tempFolder()
  const { logger, messages } = warnings()
  // A file where the folder must be: the copy cannot make the folder.
  await Bun.write(join(folder.path, MEDIA_DIR), 'not a folder')
  const blobs = mediaBlobs(folder.path, logger)
  await blobs.put('artifacts/run-1/artifact-1', new Uint8Array([1, 2, 3]), {
    contentType: 'image/png',
    customMetadata: { role: 'output' },
  })
  expect(messages).toEqual(['heddle could not save a file that an agent made.'])
  expect(await blobs.head('artifacts/run-1/artifact-1')).not.toBeNull()
  expect(readdirSync(folder.path)).toEqual([MEDIA_DIR])
})

test('a video that comes as a stream is saved too', async () => {
  using folder = tempFolder()
  const blobs = mediaBlobs(folder.path, warnings().logger)
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 4))
      controller.enqueue(bytes.subarray(4))
      controller.close()
    },
  })
  await blobs.put('artifacts/run-1/artifact-9', body, {
    contentType: 'video/mp4',
    customMetadata: { role: 'output' },
  })
  const file = mediaPath(folder.path, { id: 'artifact-9', mimeType: 'video/mp4' })
  expect(file).toEndWith('artifact-9.mp4')
  expect(new Uint8Array(readFileSync(file))).toEqual(bytes)
})
