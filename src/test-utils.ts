// Test helpers for the modules that draw no screen. Only the tests import this file.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A new temp folder whose name starts with `heddle-`. `using` deletes it after the test. */
export function tempFolder() {
  const path = mkdtempSync(join(tmpdir(), 'heddle-'))
  return {
    path,
    [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }),
  }
}

/** True when ffmpeg and ffprobe are on the PATH. The video tests need them. */
export const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null

/**
 * Makes a video of 1 second at `path`, 64 × 36 pixels: red for 0.5 seconds,
 * then blue. It needs ffmpeg.
 */
export function redThenBlueVideo(path: string) {
  const filter = 'color=c=red:s=64x36:d=0.5[a];color=c=blue:s=64x36:d=0.5[b];[a][b]concat=n=2:v=1[v]'
  const made = Bun.spawnSync(['ffmpeg', '-v', 'error', '-filter_complex', filter, '-map', '[v]', '-pix_fmt', 'yuv420p', path])
  if (made.exitCode !== 0) throw new Error(`ffmpeg could not make the test video: ${made.stderr.toString()}`)
}
