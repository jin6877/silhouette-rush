// Pluggable silhouette sources. The game loop only depends on the MaskSource
// interface, so a fake, script-driven source can be injected for automated
// verification without a real webcam or ML model.

import { MASK_W, MASK_H, createMask, type Mask } from './masks'
import { segmentFrame } from './segmentation'

export interface MaskSource {
  start(): Promise<void>
  /** Latest silhouette mask (MASK_W x MASK_H), or null if none yet. */
  read(): Mask | null
  stop(): void
  /** Optional: a canvas holding the current alpha matte for glow rendering. */
  readonly matteCanvas?: HTMLCanvasElement | null
  readonly fps?: number
}

// Processing resolution for MODNet — small enough to stay real-time.
const WORK_W = 256
const WORK_H = 192

/**
 * Real webcam source. The frame is drawn mirrored (selfie view) into a small
 * work canvas, segmented with MODNet, and downsampled into the game grid.
 * The camera image never leaves the device.
 */
export class WebcamMaskSource implements MaskSource {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private work: HTMLCanvasElement
  private matte: HTMLCanvasElement
  private latest: Mask | null = null
  private running = false
  private frameCount = 0
  private lastFpsT = 0
  private _fps = 0
  private readonly facingMode: 'user' | 'environment'

  constructor(facingMode: 'user' | 'environment' = 'user') {
    this.facingMode = facingMode
    this.work = document.createElement('canvas')
    this.work.width = WORK_W
    this.work.height = WORK_H
    this.matte = document.createElement('canvas')
    this.matte.width = WORK_W
    this.matte.height = WORK_H
  }

  get matteCanvas() {
    return this.matte
  }
  get videoEl() {
    return this.video
  }
  get fps() {
    return this._fps
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: this.facingMode,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    })
    this.stream = stream
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    await video.play()
    this.video = video
    this.running = true
    // Warm up the model + start the processing loop (does not block the caller).
    void this.loop()
  }

  private async loop() {
    while (this.running) {
      const video = this.video
      if (!video || video.readyState < 2) {
        await sleep(30)
        continue
      }
      try {
        const wctx = this.work.getContext('2d')!
        // Mirror horizontally for a natural selfie view.
        wctx.save()
        wctx.translate(WORK_W, 0)
        wctx.scale(-1, 1)
        wctx.drawImage(video, 0, 0, WORK_W, WORK_H)
        wctx.restore()

        const matte = await segmentFrame(this.work)
        // Paint alpha matte (cyan-ish) into the matte canvas for rendering.
        this.paintMatte(matte)
        this.latest = downsampleToMask(matte)
      } catch {
        // Transient errors (e.g. context loss) — skip this frame.
        await sleep(60)
      }

      this.frameCount++
      const now = performance.now()
      if (now - this.lastFpsT > 500) {
        this._fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsT))
        this.frameCount = 0
        this.lastFpsT = now
      }
      // Yield to the event loop so the render RAF stays smooth.
      await sleep(0)
    }
  }

  private paintMatte(matte: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }) {
    const w = matte.width
    const h = matte.height
    if (this.matte.width !== w || this.matte.height !== h) {
      this.matte.width = w
      this.matte.height = h
    }
    const ctx = this.matte.getContext('2d')!
    const img = ctx.createImageData(w, h)
    const src = matte.data
    const dst = img.data
    for (let i = 0; i < w * h; i++) {
      const a = src[i]
      dst[i * 4] = 255
      dst[i * 4 + 1] = 255
      dst[i * 4 + 2] = 255
      dst[i * 4 + 3] = a
    }
    ctx.putImageData(img, 0, 0)
  }

  read(): Mask | null {
    return this.latest
  }

  stop(): void {
    this.running = false
    this.stream?.getTracks().forEach((t) => t.stop())
    if (this.video) {
      this.video.srcObject = null
      this.video = null
    }
    this.stream = null
    this.latest = null
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/** Downsample an alpha matte to the fixed game grid, thresholding to 0/255. */
function downsampleToMask(matte: {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
}): Mask {
  const out = createMask(MASK_W, MASK_H)
  const { data, width: sw, height: sh } = matte
  for (let gy = 0; gy < MASK_H; gy++) {
    const sy = Math.min(sh - 1, Math.floor(((gy + 0.5) / MASK_H) * sh))
    for (let gx = 0; gx < MASK_W; gx++) {
      const sx = Math.min(sw - 1, Math.floor(((gx + 0.5) / MASK_W) * sw))
      const a = data[sy * sw + sx]
      out.data[gy * MASK_W + gx] = a > 110 ? 255 : 0
    }
  }
  return out
}

/**
 * Script-driven source for tests / demos. Inject a mask with `setMask`;
 * `read()` returns the most recently set mask.
 */
export class FakeMaskSource implements MaskSource {
  private mask: Mask | null = null
  readonly matteCanvas = null
  async start(): Promise<void> {
    /* no-op */
  }
  read(): Mask | null {
    return this.mask
  }
  stop(): void {
    this.mask = null
  }
  setMask(mask: Mask | null) {
    this.mask = mask
  }
}
