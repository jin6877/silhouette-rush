// Web Worker: real-time selfie segmentation off the main thread.
//
// The game's render loop must stay pinned at 60fps, so all ML inference lives
// here. We use MediaPipe's ImageSegmenter (Selfie Segmenter) which is a tiny,
// video-optimized model that runs at 30-60fps in the browser via a WebGL GPU
// delegate (with a CPU fallback). The main thread only ships the latest webcam
// frame in and polls the resulting mask out — it never blocks on inference.

import { ImageSegmenter, FilesetResolver, type MPMask } from '@mediapipe/tasks-vision'
import { MASK_W, MASK_H } from './masks'

type InitMsg = { type: 'init'; modelBuffer: ArrayBuffer; wasmBase: string }
type FrameMsg = { type: 'frame'; id: number; bitmap: ImageBitmap; timestamp: number }
type InMsg = InitMsg | FrameMsg

let segmenter: ImageSegmenter | null = null

const ctx = self as unknown as {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void
  onmessage: ((e: MessageEvent<InMsg>) => void) | null
}

async function createSegmenter(
  modelBuffer: Uint8Array,
  wasmBase: string,
  delegate: 'GPU' | 'CPU',
): Promise<ImageSegmenter> {
  const fileset = await FilesetResolver.forVisionTasks(wasmBase)
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: modelBuffer, delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  })
}

async function init(msg: InitMsg) {
  const buffer = new Uint8Array(msg.modelBuffer)
  try {
    segmenter = await createSegmenter(buffer, msg.wasmBase, 'GPU')
    ctx.postMessage({ type: 'ready', device: 'gpu' })
  } catch {
    // WebGL delegate unavailable (e.g. no GPU in a worker) — fall back to CPU.
    try {
      segmenter = await createSegmenter(buffer, msg.wasmBase, 'CPU')
      ctx.postMessage({ type: 'ready', device: 'cpu' })
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) })
    }
  }
}

function handleResult(id: number, mask: MPMask) {
  const w = mask.width
  const h = mask.height
  const conf = mask.getAsFloat32Array() // single channel, ~[0,1], high = person

  // Downsample to the fixed game grid (soft values; EMA/threshold on main side).
  const grid = new Uint8Array(MASK_W * MASK_H)
  for (let gy = 0; gy < MASK_H; gy++) {
    const sy = Math.min(h - 1, ((gy + 0.5) / MASK_H) * h) | 0
    const row = sy * w
    const grow = gy * MASK_W
    for (let gx = 0; gx < MASK_W; gx++) {
      const sx = Math.min(w - 1, ((gx + 0.5) / MASK_W) * w) | 0
      const v = conf[row + sx] * 255
      grid[grow + gx] = v > 255 ? 255 : v < 0 ? 0 : v
    }
  }

  // Full-resolution alpha matte for the neon silhouette glow.
  const matte = new Uint8Array(w * h)
  for (let i = 0; i < matte.length; i++) {
    const v = conf[i] * 255
    matte[i] = v > 255 ? 255 : v < 0 ? 0 : v
  }

  ctx.postMessage({ type: 'result', id, grid, matte, mw: w, mh: h }, [
    grid.buffer,
    matte.buffer,
  ])
}

function onFrame(msg: FrameMsg) {
  if (!segmenter) {
    msg.bitmap.close()
    ctx.postMessage({ type: 'frameError', id: msg.id })
    return
  }
  try {
    segmenter.segmentForVideo(msg.bitmap, msg.timestamp, (result) => {
      const masks = result.confidenceMasks
      if (masks && masks.length > 0) {
        // For the single-class Selfie Segmenter the last channel is foreground.
        handleResult(msg.id, masks[masks.length - 1])
      } else {
        ctx.postMessage({ type: 'frameError', id: msg.id })
      }
    })
  } catch {
    ctx.postMessage({ type: 'frameError', id: msg.id })
  } finally {
    msg.bitmap.close()
  }
}

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.type === 'init') void init(msg)
  else if (msg.type === 'frame') onFrame(msg)
}
