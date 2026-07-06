// Canvas renderer for 실루엣 러시. Draws the neon game-show stage, the player's
// glowing silhouette, the approaching wall (a panel with a pose-shaped hole in
// forced perspective), and pass/fail particle effects. Pure drawing — reads
// game state and the player matte, never mutates game logic.

import { dilateMask, BODY_FRAME, type Mask, type Calibration } from './masks'
import type { GameState, GameEvent } from './engine'

/**
 * What the framing screen needs from the renderer each frame. The guide lines
 * now SNAP to the player's detected head-top / feet-bottom (rather than asking
 * the body to reach fixed lines), and turn red when the body is cut off by the
 * camera frame edge.
 */
export interface FramingView {
  present: boolean
  top: number // normalized detected head-top
  bottom: number // normalized detected feet-bottom
  headCut: boolean
  feetCut: boolean
}

const SPRITE_W = 384
const SPRITE_H = 288

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  color: string
  size: number
}

interface StageRect {
  x: number
  y: number
  w: number
  h: number
}

const spriteCache = new WeakMap<object, HTMLCanvasElement>()

export class GameRenderer {
  private particles: Particle[] = []
  private flash = 0
  private flashColor = '255,255,255'
  private shake = 0
  private t = 0

  reset() {
    this.particles = []
    this.flash = 0
    this.shake = 0
    this.t = 0
  }

  handleEvents(events: GameEvent[], cssW: number, cssH: number) {
    const stage = fitStage(cssW, cssH)
    for (const e of events) {
      if (e.type === 'pass') {
        this.flash = Math.min(1, 0.35 + e.quality * 0.4)
        this.flashColor = '120,255,180'
        this.burst(stage, e.combo >= 5 ? 60 : 40, ['182,255,58', '34,233,255', '124,255,196'])
      } else if (e.type === 'fail') {
        this.flash = 0.7
        this.flashColor = '255,60,120'
        this.shake = 16
        this.burst(stage, 46, ['255,46,154', '255,120,80', '255,220,120'])
      }
    }
  }

  private burst(stage: StageRect, n: number, colors: string[]) {
    const cx = stage.x + stage.w / 2
    const cy = stage.y + stage.h / 2
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 120 + Math.random() * 520
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 0,
        maxLife: 0.6 + Math.random() * 0.7,
        color: colors[(Math.random() * colors.length) | 0],
        size: 2 + Math.random() * 4,
      })
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    matte: HTMLCanvasElement | null,
    dt: number,
    cssW: number,
    cssH: number,
    dpr: number,
  ) {
    this.t += dt
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const stage = fitStage(cssW, cssH)

    // Screen shake
    let ox = 0
    let oy = 0
    if (this.shake > 0.2) {
      ox = (Math.random() - 0.5) * this.shake
      oy = (Math.random() - 0.5) * this.shake
      this.shake *= Math.pow(0.001, dt) // fast decay
      ctx.translate(ox, oy)
    }

    this.drawBackground(ctx, stage, cssW, cssH)
    this.drawPlayer(ctx, state, matte, stage)
    if (state.wall) this.drawWall(ctx, state, stage)
    this.drawParticles(ctx, dt)

    // Flash overlay
    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(${this.flashColor},${this.flash * 0.5})`
      ctx.fillRect(-40, -40, cssW + 80, cssH + 80)
      this.flash *= Math.pow(0.0005, dt)
    }

    ctx.restore()
  }

  private drawBackground(ctx: CanvasRenderingContext2D, stage: StageRect, cssW: number, cssH: number) {
    // Deep stage gradient
    const g = ctx.createLinearGradient(0, 0, 0, cssH)
    g.addColorStop(0, '#150826')
    g.addColorStop(0.55, '#0d0518')
    g.addColorStop(1, '#08030f')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, cssW, cssH)

    const cx = stage.x + stage.w / 2
    const vpY = stage.y + stage.h * 0.42 // vanishing point

    // Perspective floor lines converging to vanishing point
    ctx.save()
    ctx.lineWidth = 1
    const floorTop = stage.y + stage.h * 0.62
    for (let i = -6; i <= 6; i++) {
      const fx = cx + (i / 6) * stage.w * 0.75
      ctx.strokeStyle = i % 2 === 0 ? 'rgba(34,233,255,0.16)' : 'rgba(255,46,154,0.13)'
      ctx.beginPath()
      ctx.moveTo(cx + (fx - cx) * 0.02, vpY)
      ctx.lineTo(fx, cssH + 10)
      ctx.stroke()
    }
    // Horizontal floor bands
    for (let i = 1; i <= 8; i++) {
      const tt = i / 8
      const yy = floorTop + (cssH - floorTop) * (tt * tt)
      ctx.strokeStyle = `rgba(140,120,220,${0.05 + tt * 0.14})`
      ctx.beginPath()
      ctx.moveTo(stage.x - 40, yy)
      ctx.lineTo(stage.x + stage.w + 40, yy)
      ctx.stroke()
    }
    ctx.restore()

    // Spotlight glow from the top
    const rg = ctx.createRadialGradient(cx, stage.y - stage.h * 0.1, 10, cx, stage.y, stage.w * 0.7)
    rg.addColorStop(0, 'rgba(168,85,247,0.32)')
    rg.addColorStop(1, 'rgba(168,85,247,0)')
    ctx.fillStyle = rg
    ctx.fillRect(0, 0, cssW, cssH)

    // Stage frame
    ctx.strokeStyle = 'rgba(168,85,247,0.28)'
    ctx.lineWidth = 2
    roundRect(ctx, stage.x, stage.y, stage.w, stage.h, 18)
    ctx.stroke()
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    matte: HTMLCanvasElement | null,
    stage: StageRect,
  ) {
    if (!matte || matte.width === 0) return // no silhouette yet
    // Color by live fit: green when fitting, cyan idle, pink when hitting wall.
    let color = '34,233,255'
    if (state.wall) {
      if (state.live.fitting) color = '182,255,58'
      else if (state.live.present && state.live.collisionRatio > 0.28) color = '255,46,154'
    }
    if (state.calibration) {
      // Body-relative view: a dim ghost shows where you actually are in the
      // camera, and the bright silhouette is your body mapped into the arena
      // frame (exactly what judgment sees) so it lines up with the hole.
      drawSilhouette(ctx, matte, stage, '128,150,210', 0.2)
      drawSilhouetteCalibrated(ctx, matte, state.calibration, stage, color)
    } else {
      drawSilhouette(ctx, matte, stage, color, 1)
    }
  }

  /**
   * Framing screen: live silhouette + guide lines that SNAP to the player's own
   * detected head-top / feet-bottom. The lines are pure viewfinder feedback ("이게
   * 네 머리/발 위치야"); they turn red when the body is cut off by the frame edge.
   * All instructions and controls live OUTSIDE the viewport (side/bottom panel),
   * so nothing floats over the body.
   */
  drawFraming(
    ctx: CanvasRenderingContext2D,
    matte: HTMLCanvasElement | null,
    view: FramingView,
    dt: number,
    cssW: number,
    cssH: number,
    dpr: number,
  ) {
    this.t += dt
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)
    const stage = fitStage(cssW, cssH)
    this.drawBackground(ctx, stage, cssW, cssH)
    const cut = view.headCut || view.feetCut
    const color = !view.present ? '34,233,255' : cut ? '255,86,140' : '182,255,58'
    if (matte && matte.width > 0) drawSilhouette(ctx, matte, stage, color, 1)
    if (view.present) this.drawFramingGuides(ctx, stage, view)
    ctx.restore()
  }

  /**
   * Head / feet guide lines snapped to the detected body. Green when the body is
   * fully inside the frame, red at whichever edge is cut off.
   */
  private drawFramingGuides(ctx: CanvasRenderingContext2D, stage: StageRect, view: FramingView) {
    const yHead = stage.y + Math.max(2, view.top * stage.h)
    const yFeet = stage.y + Math.min(view.bottom * stage.h, stage.h - 2)

    ctx.save()
    ctx.beginPath()
    roundRect(ctx, stage.x, stage.y, stage.w, stage.h, 18)
    ctx.clip()

    const line = (y: number, cut: boolean, label: string) => {
      const rgb = cut ? '255,86,140' : '182,255,58'
      ctx.save()
      ctx.lineWidth = 3
      ctx.strokeStyle = `rgba(${rgb},0.95)`
      ctx.shadowColor = `rgba(${rgb},0.85)`
      ctx.shadowBlur = 12
      ctx.beginPath()
      ctx.moveTo(stage.x + 6, y)
      ctx.lineTo(stage.x + stage.w - 6, y)
      ctx.stroke()
      ctx.restore()

      ctx.save()
      ctx.font = '700 13px "Pretendard Variable", system-ui, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const text = cut ? `${label} · 잘림!` : label
      const padX = 9
      const chipH = 24
      const chipW = ctx.measureText(text).width + padX * 2
      const chipX = stage.x + 14
      const chipY = Math.min(Math.max(y, stage.y + chipH / 2 + 6), stage.y + stage.h - chipH / 2 - 6)
      ctx.fillStyle = cut ? 'rgba(46,10,24,0.9)' : 'rgba(24,44,8,0.85)'
      roundRect(ctx, chipX, chipY - chipH / 2, chipW, chipH, 12)
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = `rgba(${rgb},0.9)`
      roundRect(ctx, chipX, chipY - chipH / 2, chipW, chipH, 12)
      ctx.stroke()
      ctx.fillStyle = cut ? '#ffd8e4' : '#e8ffc8'
      ctx.fillText(text, chipX + padX, chipY + 0.5)
      ctx.restore()
    }

    line(yHead, view.headCut, '👤 머리')
    line(yFeet, view.feetCut, '👣 발')
    ctx.restore()
  }

  private drawWall(ctx: CanvasRenderingContext2D, state: GameState, stage: StageRect) {
    const wall = state.wall!
    const sprite = getWallSprite(wall)
    const p = wall.progress
    // Ease-in: starts far & slow, rushes in at the end.
    const eased = p * p
    const scale = 0.12 + eased * 0.88
    const cx = stage.x + stage.w / 2
    // Emerge slightly above center then settle to center.
    const cy = stage.y + stage.h * (0.42 + eased * 0.08)
    const dw = stage.w * scale
    const dh = stage.h * scale
    const dx = cx - dw / 2
    const dy = cy - dh / 2

    ctx.save()
    ctx.globalAlpha = Math.min(1, 0.25 + p * 1.2)
    // Distance haze glow behind the panel
    ctx.shadowColor = 'rgba(120,60,200,0.6)'
    ctx.shadowBlur = 40 * scale
    ctx.drawImage(sprite, dx, dy, dw, dh)
    ctx.restore()

    // Urgency ring when close
    if (p > 0.55) {
      const a = (p - 0.55) / 0.45
      ctx.save()
      ctx.strokeStyle = `rgba(255,46,154,${0.15 + a * 0.5 * (0.6 + 0.4 * Math.sin(this.t * 14))})`
      ctx.lineWidth = 3 + a * 4
      roundRect(ctx, dx - 6, dy - 6, dw + 12, dh + 12, 20 * scale)
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, dt: number) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const next: Particle[] = []
    for (const pt of this.particles) {
      pt.life += dt
      if (pt.life >= pt.maxLife) continue
      pt.vy += 900 * dt // gravity
      pt.vx *= Math.pow(0.2, dt)
      pt.x += pt.vx * dt
      pt.y += pt.vy * dt
      const k = 1 - pt.life / pt.maxLife
      ctx.fillStyle = `rgba(${pt.color},${k})`
      ctx.shadowColor = `rgba(${pt.color},${k})`
      ctx.shadowBlur = 12
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, pt.size * (0.4 + k * 0.6), 0, Math.PI * 2)
      ctx.fill()
      next.push(pt)
    }
    this.particles = next
    ctx.restore()
  }
}

// --- helpers ------------------------------------------------------------

/** Draw the neon silhouette (matte tinted `colorRGB`) as "cover" into the stage. */
function drawSilhouette(
  ctx: CanvasRenderingContext2D,
  matte: HTMLCanvasElement,
  stage: StageRect,
  colorRGB: string,
  alpha = 1,
) {
  const tint = tintCanvas(matte, colorRGB)
  ctx.save()
  const scale = Math.max(stage.w / matte.width, stage.h / matte.height)
  const dw = matte.width * scale
  const dh = matte.height * scale
  const dx = stage.x + (stage.w - dw) / 2
  const dy = stage.y + (stage.h - dh) / 2
  ctx.beginPath()
  roundRect(ctx, stage.x, stage.y, stage.w, stage.h, 18)
  ctx.clip()
  ctx.shadowColor = `rgba(${colorRGB},0.95)`
  ctx.shadowBlur = 26
  ctx.globalAlpha = 0.9 * alpha
  ctx.drawImage(tint, dx, dy, dw, dh)
  // second pass boosts the core
  ctx.shadowBlur = 8
  ctx.globalAlpha = 0.85 * alpha
  ctx.drawImage(tint, dx, dy, dw, dh)
  ctx.restore()
}

/**
 * Draw the silhouette warped by the standing `cal` into the canonical pose
 * frame — the exact mapping judgment uses — so the on-screen body lines up with
 * the hole no matter where/how big the player is in the camera.
 */
function drawSilhouetteCalibrated(
  ctx: CanvasRenderingContext2D,
  matte: HTMLCanvasElement,
  cal: Calibration,
  stage: StageRect,
  colorRGB: string,
) {
  const tint = tintCanvas(matte, colorRGB)
  const s = (BODY_FRAME.feetY - BODY_FRAME.headY) / Math.max(1e-3, cal.bottom - cal.top)
  const dw = s * stage.w
  const dh = s * stage.h
  const dx = stage.x + (0.5 - cal.centerX * s) * stage.w
  const dy = stage.y + (BODY_FRAME.headY - cal.top * s) * stage.h
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, stage.x, stage.y, stage.w, stage.h, 18)
  ctx.clip()
  ctx.shadowColor = `rgba(${colorRGB},0.95)`
  ctx.shadowBlur = 26
  ctx.globalAlpha = 0.9
  ctx.drawImage(tint, dx, dy, dw, dh)
  ctx.shadowBlur = 8
  ctx.globalAlpha = 0.85
  ctx.drawImage(tint, dx, dy, dw, dh)
  ctx.restore()
}

function fitStage(cssW: number, cssH: number): StageRect {
  const aspect = 4 / 3
  let w = cssW * 0.98
  let h = w / aspect
  if (h > cssH * 0.98) {
    h = cssH * 0.98
    w = h * aspect
  }
  return { x: (cssW - w) / 2, y: (cssH - h) / 2, w, h }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// Reusable scratch canvases so we don't allocate every frame.
let tintScratch: HTMLCanvasElement | null = null
function tintCanvas(src: HTMLCanvasElement, colorRGB: string): HTMLCanvasElement {
  if (!tintScratch) tintScratch = document.createElement('canvas')
  const c = tintScratch
  if (c.width !== src.width || c.height !== src.height) {
    c.width = src.width
    c.height = src.height
  }
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(src, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = `rgb(${colorRGB})`
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.globalCompositeOperation = 'source-over'
  return c
}

function maskToAlphaCanvas(mask: Mask): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = mask.width
  c.height = mask.height
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

/** Builds (and caches) the wall panel sprite with the pose-shaped hole. */
function getWallSprite(wall: { holeMask: Mask }): HTMLCanvasElement {
  const cached = spriteCache.get(wall)
  if (cached) return cached

  const c = document.createElement('canvas')
  c.width = SPRITE_W
  c.height = SPRITE_H
  const ctx = c.getContext('2d')!

  // Panel body: deep neon-magenta plate with a subtle grid + bevel border.
  const g = ctx.createLinearGradient(0, 0, SPRITE_W, SPRITE_H)
  g.addColorStop(0, '#3a1668')
  g.addColorStop(0.5, '#511b7a')
  g.addColorStop(1, '#2a0f52')
  ctx.fillStyle = g
  roundRect(ctx, 4, 4, SPRITE_W - 8, SPRITE_H - 8, 22)
  ctx.fill()

  // grid texture
  ctx.save()
  roundRect(ctx, 4, 4, SPRITE_W - 8, SPRITE_H - 8, 22)
  ctx.clip()
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'
  ctx.lineWidth = 1
  for (let x = 0; x < SPRITE_W; x += 24) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, SPRITE_H)
    ctx.stroke()
  }
  for (let y = 0; y < SPRITE_H; y += 24) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(SPRITE_W, y)
    ctx.stroke()
  }
  ctx.restore()

  // Neon border
  ctx.strokeStyle = 'rgba(34,233,255,0.55)'
  ctx.lineWidth = 5
  ctx.shadowColor = 'rgba(34,233,255,0.7)'
  ctx.shadowBlur = 14
  roundRect(ctx, 6, 6, SPRITE_W - 12, SPRITE_H - 12, 20)
  ctx.stroke()
  ctx.shadowBlur = 0

  // Cut the hole (dilated a touch so it matches the forgiving judgment).
  const holeMask = dilateMask(wall.holeMask, 3)
  const holeCanvas = maskToAlphaCanvas(holeMask)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(holeCanvas, 0, 0, SPRITE_W, SPRITE_H)
  ctx.restore()

  // Glowing rim around the hole (edge = dilate(hole) minus hole).
  const rim = edgeMask(wall.holeMask, 3, 6)
  const rimCanvas = tintMask(rim, '236,255,120')
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.shadowColor = 'rgba(182,255,58,0.9)'
  ctx.shadowBlur = 16
  ctx.globalAlpha = 0.9
  ctx.drawImage(rimCanvas, 0, 0, SPRITE_W, SPRITE_H)
  ctx.restore()

  spriteCache.set(wall, c)
  return c
}

function tintMask(mask: Mask, colorRGB: string): HTMLCanvasElement {
  const c = maskToAlphaCanvas(mask)
  const ctx = c.getContext('2d')!
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = `rgb(${colorRGB})`
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.globalCompositeOperation = 'source-over'
  return c
}

/** Ring mask: dilate(inner..outer) around the hole boundary. */
function edgeMask(hole: Mask, inner: number, outer: number): Mask {
  const big = dilateMask(hole, outer)
  const small = dilateMask(hole, inner)
  const out: Mask = { data: new Uint8Array(hole.data.length), width: hole.width, height: hole.height }
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = big.data[i] > 128 && small.data[i] <= 128 ? 255 : 0
  }
  return out
}
