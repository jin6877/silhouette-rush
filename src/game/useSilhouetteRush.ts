import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createGame,
  defaultConfig,
  stepGame,
  timeToImpact,
  finalScore,
  type GameState,
} from './engine'
import { GameRenderer } from './render'
import { WebcamMaskSource, FakeMaskSource, type MaskSource } from './maskSource'
import { onModelProgress, getDevice } from './segmentation'
import {
  MASK_W,
  MASK_H,
  erodeMask,
  createMask,
  type Mask,
} from './masks'

export type Status = 'idle' | 'loading' | 'playing' | 'gameover'

const BEST_KEY = 'silhouette-rush:best'

export interface Snapshot {
  status: Status
  phase: GameState['phase']
  score: number
  combo: number
  bestCombo: number
  hearts: number
  maxHearts: number
  round: number
  passes: number
  fails: number
  best: number
  poseName: string | null
  timeToImpact: number
  progress: number
  fitting: boolean
  present: boolean
  collisionRatio: number
  fillRatio: number
  fps: number
}

interface Runtime {
  source: MaskSource
  state: GameState
  renderer: GameRenderer
  raf: number
  lastT: number
  dpr: number
  fakeMatte: HTMLCanvasElement | null
  lastMatte: HTMLCanvasElement | null
}

function emptySnapshot(best: number): Snapshot {
  return {
    status: 'idle',
    phase: 'ready',
    score: 0,
    combo: 0,
    bestCombo: 0,
    hearts: 3,
    maxHearts: 3,
    round: 0,
    passes: 0,
    fails: 0,
    best,
    poseName: null,
    timeToImpact: 0,
    progress: 0,
    fitting: false,
    present: false,
    collisionRatio: 0,
    fillRatio: 0,
    fps: 0,
  }
}

export interface SilhouetteRushApi {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  snap: Snapshot
  modelProgress: number
  device: string | null
  error: string | null
  /** Raw underlying failure message (worker/engine), shown as a small detail. */
  errorDetail: string | null
  start: (opts?: { fake?: boolean }) => Promise<void>
  restart: () => void
  quit: () => void
  getLastMatte: () => HTMLCanvasElement | null
}

export function useSilhouetteRush(): SilhouetteRushApi {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rt = useRef<Runtime | null>(null)
  const [best, setBest] = useState(0)
  const [snap, setSnap] = useState<Snapshot>(() => emptySnapshot(0))
  const [modelProgress, setModelProgress] = useState(0)
  const [device, setDevice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const lastOptsRef = useRef<{ fake?: boolean } | undefined>(undefined)

  useEffect(() => {
    const raw = Number(localStorage.getItem(BEST_KEY) || '0')
    const b = Number.isNaN(raw) ? 0 : raw
    setBest(b)
    setSnap((s) => ({ ...s, best: b }))
  }, [])

  useEffect(() => onModelProgress((p) => setModelProgress(p)), [])

  const stop = useCallback(() => {
    if (rt.current) {
      cancelAnimationFrame(rt.current.raf)
      rt.current.source.stop()
      rt.current = null
    }
  }, [])

  const sizeCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    return dpr
  }, [])

  const commitGameOver = useCallback((state: GameState) => {
    const fs = finalScore(state)
    setBest((prev) => {
      const next = Math.max(prev, fs)
      localStorage.setItem(BEST_KEY, String(next))
      return next
    })
  }, [])

  const loop = useCallback(
    (now: number) => {
      const r = rt.current
      const canvas = canvasRef.current
      if (!r || !canvas) return
      const dt = Math.min(0.05, (now - r.lastT) / 1000 || 0)
      r.lastT = now

      const mask = r.source.read()

      // Resolve a matte canvas for rendering (real source provides one; for the
      // fake source we synthesize one from the injected mask).
      let matte = r.source.matteCanvas ?? null
      if (!matte && mask) {
        matte = paintMaskToCanvas(mask, r.fakeMatte)
        r.fakeMatte = matte
      }
      if (matte && matte.width > 0) r.lastMatte = matte

      // Resize backing store if needed.
      const rect = canvas.getBoundingClientRect()
      const needW = Math.round(rect.width * r.dpr)
      const needH = Math.round(rect.height * r.dpr)
      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = Math.max(1, needW)
        canvas.height = Math.max(1, needH)
      }

      if (r.state.phase !== 'gameover') {
        stepGame(r.state, mask, dt)
        r.renderer.handleEvents(r.state.events, rect.width, rect.height)
        for (const e of r.state.events) {
          if (e.type === 'gameover') commitGameOver(r.state)
        }
      }

      const ctx = canvas.getContext('2d')!
      r.renderer.draw(ctx, r.state, r.lastMatte, dt, rect.width, rect.height, r.dpr)

      // Publish snapshot for the HUD.
      const st = r.state
      setSnap((s) => ({
        ...s,
        status: st.phase === 'gameover' ? 'gameover' : 'playing',
        phase: st.phase,
        score: st.score,
        combo: st.combo,
        bestCombo: st.bestCombo,
        hearts: st.hearts,
        maxHearts: st.maxHearts,
        round: st.round,
        passes: st.passes,
        fails: st.fails,
        poseName: st.wall?.pose.name ?? null,
        timeToImpact: timeToImpact(st),
        progress: st.wall?.progress ?? 0,
        fitting: st.live.fitting,
        present: st.live.present,
        collisionRatio: st.live.collisionRatio,
        fillRatio: st.live.fillRatio,
        fps: (r.source as { fps?: number }).fps ?? 0,
      }))

      r.raf = requestAnimationFrame(loop)
    },
    [commitGameOver],
  )

  const begin = useCallback(
    async (opts?: { fake?: boolean }) => {
      const canvas = canvasRef.current
      if (!canvas) return
      lastOptsRef.current = opts
      setError(null)
      setErrorDetail(null)
      setModelProgress(opts?.fake ? 1 : 0)

      const source: MaskSource = opts?.fake ? new FakeMaskSource() : new WebcamMaskSource('user')

      if (!opts?.fake) {
        setSnap((s) => ({ ...s, status: 'loading' }))
        // start() acquires the camera AND loads the segmentation worker/model
        // (driving the progress bar). Classify the failure for a helpful message.
        try {
          await source.start()
        } catch (e) {
          const name = (e as DOMException)?.name
          const rawMessage = (e as Error)?.message ?? String(e)
          // Always log the real cause so failures are diagnosable from devtools.
          console.error('[silhouette-rush] start() failed:', e)
          if (name === 'NotAllowedError' || name === 'SecurityError') {
            setError('카메라 권한이 거부됐어요. 주소창의 카메라 아이콘에서 허용해 주세요.')
            setErrorDetail(null)
          } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
            setError('카메라를 찾을 수 없어요. 웹캠을 연결한 뒤 다시 시도해 주세요.')
            setErrorDetail(null)
          } else {
            // Segmentation-engine failures: surface the underlying worker/engine
            // message so the real cause is visible on screen, not just in logs.
            setError('실루엣 인식 엔진을 불러오지 못했어요. 네트워크(카메라·모델 CDN)를 확인해 주세요.')
            setErrorDetail(rawMessage || null)
          }
          setSnap((s) => ({ ...s, status: 'idle' }))
          source.stop()
          return
        }
        try {
          setDevice(await getDevice())
        } catch {
          /* device label is best-effort */
        }
      } else {
        await source.start()
      }

      const dpr = sizeCanvas(canvas)
      const renderer = new GameRenderer()
      renderer.reset()
      const state = createGame(defaultConfig(), (Date.now() & 0xffffffff) >>> 0)

      rt.current = {
        source,
        state,
        renderer,
        raf: 0,
        lastT: performance.now(),
        dpr,
        fakeMatte: null,
        lastMatte: null,
      }
      setSnap((s) => ({ ...emptySnapshot(s.best), status: 'playing', best: s.best }))
      rt.current.raf = requestAnimationFrame(loop)
    },
    [loop, sizeCanvas],
  )

  const start = useCallback(
    (opts?: { fake?: boolean }) => {
      stop()
      return begin(opts)
    },
    [begin, stop],
  )

  const restart = useCallback(() => {
    start(lastOptsRef.current)
  }, [start])

  const quit = useCallback(() => {
    stop()
    setSnap((s) => ({ ...emptySnapshot(s.best) }))
  }, [stop])

  const getLastMatte = useCallback(() => rt.current?.lastMatte ?? null, [])

  useEffect(() => () => stop(), [stop])

  // Keep the HUD's best in sync.
  useEffect(() => {
    setSnap((s) => ({ ...s, best }))
  }, [best])

  // --- Test / demo hooks for headless verification (Playwright) ---
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    const fitMaskForWall = (): Mask | null => {
      const st = rt.current?.state
      if (!st?.wall) return null
      return erodeMask(st.wall.holeMask, 2)
    }
    const missMask = (): Mask => {
      const m = createMask()
      for (let y = Math.floor(0.05 * MASK_H); y < Math.floor(0.98 * MASK_H); y++)
        for (let x = 0; x < Math.floor(0.3 * MASK_W); x++) m.data[y * MASK_W + x] = 255
      return m
    }
    w.__silhouetteRush = {
      startFake: () => start({ fake: true }),
      setFit: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(fitMaskForWall())
      },
      setMiss: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(missMask())
      },
      setNone: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(null)
      },
      autopilot: () => {
        const s = rt.current?.source
        if (s instanceof FakeMaskSource) s.setMask(fitMaskForWall())
      },
      state: () => {
        const st = rt.current?.state
        return {
          phase: st?.phase ?? null,
          score: st?.score ?? 0,
          combo: st?.combo ?? 0,
          hearts: st?.hearts ?? 0,
          round: st?.round ?? 0,
          passes: st?.passes ?? 0,
          fails: st?.fails ?? 0,
          hasWall: !!st?.wall,
          progress: st?.wall?.progress ?? 0,
          poseName: st?.wall?.pose.name ?? null,
        }
      },
    }
    return () => {
      delete w.__silhouetteRush
    }
  }, [start])

  return {
    canvasRef,
    snap,
    modelProgress,
    device,
    error,
    errorDetail,
    start,
    restart,
    quit,
    getLastMatte,
  }
}

function paintMaskToCanvas(mask: Mask, reuse: HTMLCanvasElement | null): HTMLCanvasElement {
  const c = reuse ?? document.createElement('canvas')
  if (c.width !== mask.width || c.height !== mask.height) {
    c.width = mask.width
    c.height = mask.height
  }
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(mask.width, mask.height)
  for (let i = 0; i < mask.data.length; i++) {
    img.data[i * 4] = 255
    img.data[i * 4 + 1] = 255
    img.data[i * 4 + 2] = 255
    img.data[i * 4 + 3] = mask.data[i]
  }
  ctx.putImageData(img, 0, 0)
  return c
}
