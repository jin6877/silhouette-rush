// Real-time human silhouette segmentation using @huggingface/transformers.
// Reuses the nukki-studio engine-loading pattern (WebGPU with WASM fallback +
// download-progress events) but swaps the heavy RMBG image model for MODNet,
// a lightweight portrait-matting model designed for real-time video. We feed
// small frames (~256px) so it runs at interactive frame-rates.

import {
  AutoModel,
  AutoProcessor,
  RawImage,
  env,
  type PreTrainedModel,
  type Processor,
} from '@huggingface/transformers'

env.allowLocalModels = false

const MODEL_ID = 'Xenova/modnet'

export type EngineDevice = 'webgpu' | 'wasm'

interface Engine {
  model: PreTrainedModel
  processor: Processor
  device: EngineDevice
}

type ProgressListener = (progress: number) => void

let enginePromise: Promise<Engine> | null = null
const progressListeners = new Set<ProgressListener>()

export function onModelProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  return () => progressListeners.delete(listener)
}

function emitProgress(p: number) {
  for (const listener of progressListeners) listener(p)
}

async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter()
    return adapter != null
  } catch {
    return false
  }
}

async function loadEngine(): Promise<Engine> {
  const files = new Map<string, { loaded: number; total: number }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progress_callback = (item: any) => {
    if (item?.status === 'progress' && item.total) {
      files.set(item.file, { loaded: item.loaded, total: item.total })
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      if (total > 0) emitProgress(Math.min(0.99, loaded / total))
    }
  }

  const preferWebGPU = await detectWebGPU()
  let device: EngineDevice = preferWebGPU ? 'webgpu' : 'wasm'

  let model: PreTrainedModel
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = await AutoModel.from_pretrained(MODEL_ID, {
      device,
      dtype: 'fp32',
      progress_callback,
    } as any)
  } catch (err) {
    if (device === 'wasm') throw err
    device = 'wasm'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model = await AutoModel.from_pretrained(MODEL_ID, {
      device,
      dtype: 'fp32',
      progress_callback,
    } as any)
  }

  const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback,
  })

  emitProgress(1)
  return { model, processor, device }
}

export function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

export async function getDevice(): Promise<EngineDevice> {
  return (await getEngine()).device
}

/**
 * Runs MODNet on `input` (a canvas holding the current, already-mirrored video
 * frame) and returns a single-channel alpha matte as a RawImage at the input's
 * resolution. High alpha = person.
 */
export async function segmentFrame(input: HTMLCanvasElement): Promise<RawImage> {
  const { model, processor } = await getEngine()
  const ctx = input.getContext('2d', { willReadFrequently: true })!
  const { data, width, height } = ctx.getImageData(0, 0, input.width, input.height)
  const image = new RawImage(new Uint8ClampedArray(data), width, height, 4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { pixel_values } = await (processor as any)(image)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any = await model({ input: pixel_values })
  let tensor = out.output ?? out.alpha ?? Object.values(out)[0]
  // Some builds return logits; MODNet matte is already 0..1.
  const matte = await RawImage.fromTensor(tensor[0].mul(255).to('uint8')).resize(
    image.width,
    image.height,
  )
  return matte
}
