// Pure, DOM-free mask utilities and the pose-hole library.
// A Mask is a low-resolution grid of "occupancy" values 0..255 where high
// means "filled" (for a wall) or "body present" (for a player silhouette).
// Everything the game judges on lives at this resolution so it is cheap and
// deterministic — the webcam segmentation output is downsampled into it.

export const MASK_W = 128
export const MASK_H = 96 // 4:3, matches a typical webcam frame

export interface Mask {
  data: Uint8Array // length MASK_W * MASK_H, 0..255
  width: number
  height: number
}

export function createMask(width = MASK_W, height = MASK_H): Mask {
  return { data: new Uint8Array(width * height), width, height }
}

export function cloneMask(m: Mask): Mask {
  return { data: new Uint8Array(m.data), width: m.width, height: m.height }
}

/** Fraction of cells above `threshold`. */
export function maskArea(m: Mask, threshold = 128): number {
  let count = 0
  const d = m.data
  for (let i = 0; i < d.length; i++) if (d[i] > threshold) count++
  return count / d.length
}

export interface MaskBounds {
  present: boolean
  top: number // normalized 0..1 — highest filled row (head/hands)
  bottom: number // normalized 0..1 — lowest filled row (feet)
  left: number
  right: number
  centerX: number // normalized centroid x of filled cells
  area: number
}

/**
 * Tight bounding box (+ x centroid) of the filled region, in normalized 0..1
 * coordinates. Pure — used both to derive the pose reference frame and to
 * measure where the live player's head/feet currently sit for the framing step.
 */
export function maskBounds(m: Mask, threshold = 128): MaskBounds {
  const { width: w, height: h, data } = m
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let sumX = 0
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        sumX += x
        count++
      }
    }
  }
  if (count === 0) {
    return { present: false, top: 0, bottom: 1, left: 0, right: 1, centerX: 0.5, area: 0 }
  }
  return {
    present: true,
    top: minY / h,
    bottom: (maxY + 1) / h,
    left: minX / w,
    right: (maxX + 1) / w,
    centerX: sumX / count / w,
    area: count / (w * h),
  }
}

// --- Geometry primitives (normalized 0..1 coordinates) ------------------

function fillCircle(m: Mask, cx: number, cy: number, r: number, value = 255) {
  const { width: w, height: h, data } = m
  const px = cx * w
  const py = cy * h
  const pr = r * w
  const pr2 = pr * pr
  const y0 = Math.max(0, Math.floor(py - pr))
  const y1 = Math.min(h - 1, Math.ceil(py + pr))
  const x0 = Math.max(0, Math.floor(px - pr))
  const x1 = Math.min(w - 1, Math.ceil(px + pr))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - px
      const dy = y + 0.5 - py
      if (dx * dx + dy * dy <= pr2) data[y * w + x] = value
    }
  }
}

/** Thick capsule (rounded line) from (ax,ay) to (bx,by) with radius r. */
function fillCapsule(
  m: Mask,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
  value = 255,
) {
  const { width: w, height: h, data } = m
  const pax = ax * w
  const pay = ay * h
  const pbx = bx * w
  const pby = by * h
  const pr = r * w
  const pr2 = pr * pr
  const minX = Math.max(0, Math.floor(Math.min(pax, pbx) - pr))
  const maxX = Math.min(w - 1, Math.ceil(Math.max(pax, pbx) + pr))
  const minY = Math.max(0, Math.floor(Math.min(pay, pby) - pr))
  const maxY = Math.min(h - 1, Math.ceil(Math.max(pay, pby) + pr))
  const vx = pbx - pax
  const vy = pby - pay
  const len2 = vx * vx + vy * vy || 1
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - pax
      const py = y + 0.5 - pay
      let t = (px * vx + py * vy) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const dx = px - t * vx
      const dy = py - t * vy
      if (dx * dx + dy * dy <= pr2) data[y * w + x] = value
    }
  }
}

// --- Pose definitions ---------------------------------------------------
// Each pose draws a clean, thickened human silhouette into a fresh mask,
// where value 255 = "the open hole you must fit your body into". The hole is
// drawn generously (thick limbs) so real players can realistically pass.

export interface Pose {
  id: string
  name: string // Korean label
  difficulty: number // 1 (easy) .. 5 (hard)
  draw: (m: Mask) => void
}

// Common body-part radii (normalized to width). Generous on purpose.
const HEAD_R = 0.058
const TORSO_R = 0.075
const LIMB_R = 0.05

/** Builds a standing figure from joint positions (all normalized 0..1). */
function figure(
  m: Mask,
  j: {
    head: [number, number]
    neck: [number, number]
    hip: [number, number]
    lHand: [number, number]
    rHand: [number, number]
    lElbow?: [number, number]
    rElbow?: [number, number]
    lFoot: [number, number]
    rFoot: [number, number]
    lKnee?: [number, number]
    rKnee?: [number, number]
  },
) {
  const shoulderY = j.neck[1] + 0.02
  const lShoulder: [number, number] = [j.neck[0] - 0.075, shoulderY]
  const rShoulder: [number, number] = [j.neck[0] + 0.075, shoulderY]
  const lElbow = j.lElbow ?? mid(lShoulder, j.lHand)
  const rElbow = j.rElbow ?? mid(rShoulder, j.rHand)
  const lKnee = j.lKnee ?? mid(j.hip, j.lFoot)
  const rKnee = j.rKnee ?? mid(j.hip, j.rFoot)
  // torso
  fillCapsule(m, j.neck[0], j.neck[1], j.hip[0], j.hip[1], TORSO_R)
  // head
  fillCircle(m, j.head[0], j.head[1], HEAD_R)
  fillCapsule(m, j.head[0], j.head[1] + 0.03, j.neck[0], j.neck[1], LIMB_R * 0.8)
  // arms
  fillCapsule(m, lShoulder[0], lShoulder[1], lElbow[0], lElbow[1], LIMB_R)
  fillCapsule(m, lElbow[0], lElbow[1], j.lHand[0], j.lHand[1], LIMB_R * 0.9)
  fillCapsule(m, rShoulder[0], rShoulder[1], rElbow[0], rElbow[1], LIMB_R)
  fillCapsule(m, rElbow[0], rElbow[1], j.rHand[0], j.rHand[1], LIMB_R * 0.9)
  // legs
  fillCapsule(m, j.hip[0] - 0.03, j.hip[1], lKnee[0], lKnee[1], LIMB_R * 1.05)
  fillCapsule(m, lKnee[0], lKnee[1], j.lFoot[0], j.lFoot[1], LIMB_R)
  fillCapsule(m, j.hip[0] + 0.03, j.hip[1], rKnee[0], rKnee[1], LIMB_R * 1.05)
  fillCapsule(m, rKnee[0], rKnee[1], j.rFoot[0], j.rFoot[1], LIMB_R)
}

function mid(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

// The library spans four difficulty tiers so the round can scale from big,
// symmetric, easy-to-read shapes (tier 1–2) to narrow, awkward, asymmetric ones
// (tier 4–5). Left/right asymmetry is used heavily so consecutive poses read as
// clearly different. `difficulty`: 1 (easiest) .. 5 (hardest).
export const POSES: Pose[] = [
  // ---- Tier 1 · big symmetric (easy, low entry barrier) ----------------
  {
    id: 'stand',
    name: '차렷 자세',
    difficulty: 1,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.16],
        neck: [0.5, 0.28],
        hip: [0.5, 0.6],
        lHand: [0.4, 0.6],
        rHand: [0.6, 0.6],
        lFoot: [0.44, 0.95],
        rFoot: [0.56, 0.95],
      }),
  },
  {
    id: 'tpose',
    name: '양팔 벌리기',
    difficulty: 1,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.17],
        neck: [0.5, 0.29],
        hip: [0.5, 0.62],
        lHand: [0.12, 0.31],
        rHand: [0.88, 0.31],
        lFoot: [0.44, 0.96],
        rFoot: [0.56, 0.96],
      }),
  },
  {
    id: 'vDown',
    name: '양팔 아래로 벌리기 (A자)',
    difficulty: 1,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.17],
        neck: [0.5, 0.29],
        hip: [0.5, 0.61],
        lHand: [0.24, 0.68],
        rHand: [0.76, 0.68],
        lFoot: [0.42, 0.96],
        rFoot: [0.58, 0.96],
      }),
  },
  // ---- Tier 2 · symmetric but tighter ----------------------------------
  {
    id: 'cheer',
    name: '만세! 두 팔 위로',
    difficulty: 2,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.2],
        neck: [0.5, 0.31],
        hip: [0.5, 0.63],
        lHand: [0.28, 0.05],
        rHand: [0.72, 0.05],
        lElbow: [0.34, 0.2],
        rElbow: [0.66, 0.2],
        lFoot: [0.45, 0.96],
        rFoot: [0.55, 0.96],
      }),
  },
  {
    id: 'goalpost',
    name: '양팔 ㄷ자 (골대)',
    difficulty: 2,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.18],
        neck: [0.5, 0.3],
        hip: [0.5, 0.62],
        lElbow: [0.26, 0.31],
        rElbow: [0.74, 0.31],
        lHand: [0.26, 0.13],
        rHand: [0.74, 0.13],
        lFoot: [0.44, 0.96],
        rFoot: [0.56, 0.96],
      }),
  },
  {
    id: 'oneArmSide',
    name: '한 팔만 옆으로',
    difficulty: 2,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.17],
        neck: [0.5, 0.29],
        hip: [0.5, 0.61],
        lHand: [0.12, 0.3],
        rHand: [0.6, 0.6],
        lFoot: [0.45, 0.96],
        rFoot: [0.55, 0.96],
      }),
  },
  // ---- Tier 3 · asymmetric upper body ----------------------------------
  {
    id: 'oneArm',
    name: '한 팔 번쩍',
    difficulty: 3,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.18],
        neck: [0.5, 0.3],
        hip: [0.5, 0.62],
        lHand: [0.32, 0.04],
        lElbow: [0.36, 0.18],
        rHand: [0.66, 0.6],
        lFoot: [0.45, 0.96],
        rFoot: [0.55, 0.96],
      }),
  },
  {
    id: 'lean',
    name: '옆으로 기울이기',
    difficulty: 3,
    draw: (m) =>
      figure(m, {
        head: [0.36, 0.2],
        neck: [0.42, 0.31],
        hip: [0.54, 0.62],
        lHand: [0.2, 0.42],
        rHand: [0.6, 0.28],
        rElbow: [0.56, 0.4],
        lFoot: [0.5, 0.96],
        rFoot: [0.62, 0.96],
      }),
  },
  {
    id: 'hipHand',
    name: '한 손 허리 + 한 팔 위',
    difficulty: 3,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.18],
        neck: [0.5, 0.3],
        hip: [0.5, 0.61],
        lElbow: [0.3, 0.44],
        lHand: [0.42, 0.52],
        rElbow: [0.62, 0.2],
        rHand: [0.64, 0.04],
        lFoot: [0.45, 0.96],
        rFoot: [0.55, 0.96],
      }),
  },
  {
    id: 'disco',
    name: '대각선 뻗기',
    difficulty: 3,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.18],
        neck: [0.5, 0.3],
        hip: [0.5, 0.61],
        lHand: [0.16, 0.1],
        rHand: [0.84, 0.62],
        lFoot: [0.45, 0.96],
        rFoot: [0.55, 0.96],
      }),
  },
  {
    id: 'chestCross',
    name: '가슴 앞 X',
    difficulty: 3,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.18],
        neck: [0.5, 0.3],
        hip: [0.5, 0.61],
        lElbow: [0.32, 0.42],
        lHand: [0.6, 0.36],
        rElbow: [0.68, 0.42],
        rHand: [0.4, 0.36],
        lFoot: [0.45, 0.96],
        rFoot: [0.55, 0.96],
      }),
  },
  // ---- Tier 4 · legs involved / big asymmetry --------------------------
  {
    id: 'star',
    name: '점프 스타 (팔·다리 활짝)',
    difficulty: 4,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.18],
        neck: [0.5, 0.29],
        hip: [0.5, 0.58],
        lHand: [0.14, 0.12],
        rHand: [0.86, 0.12],
        lElbow: [0.3, 0.22],
        rElbow: [0.7, 0.22],
        lFoot: [0.24, 0.94],
        rFoot: [0.76, 0.94],
        lKnee: [0.36, 0.76],
        rKnee: [0.64, 0.76],
      }),
  },
  {
    id: 'oneLeg',
    name: '한쪽 다리 옆차기',
    difficulty: 4,
    draw: (m) =>
      figure(m, {
        head: [0.46, 0.18],
        neck: [0.47, 0.3],
        hip: [0.48, 0.58],
        lHand: [0.2, 0.34],
        rHand: [0.62, 0.16],
        rElbow: [0.58, 0.32],
        lFoot: [0.46, 0.94],
        rFoot: [0.86, 0.66],
        rKnee: [0.68, 0.62],
      }),
  },
  {
    id: 'kneeUp',
    name: '한 무릎 올리기',
    difficulty: 4,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.2],
        neck: [0.5, 0.31],
        hip: [0.5, 0.6],
        lHand: [0.36, 0.6],
        rHand: [0.64, 0.6],
        lFoot: [0.46, 0.96],
        rKnee: [0.6, 0.62],
        rFoot: [0.5, 0.72],
      }),
  },
  {
    id: 'tree',
    name: '나무 자세',
    difficulty: 4,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.19],
        neck: [0.5, 0.3],
        hip: [0.5, 0.6],
        lElbow: [0.42, 0.2],
        lHand: [0.44, 0.06],
        rElbow: [0.58, 0.2],
        rHand: [0.56, 0.06],
        lFoot: [0.5, 0.96],
        rKnee: [0.64, 0.66],
        rFoot: [0.46, 0.68],
      }),
  },
  {
    id: 'skew',
    name: '반대로 크게 기울이기',
    difficulty: 4,
    draw: (m) =>
      figure(m, {
        head: [0.64, 0.2],
        neck: [0.58, 0.31],
        hip: [0.46, 0.62],
        lHand: [0.4, 0.28],
        rElbow: [0.72, 0.34],
        rHand: [0.82, 0.44],
        lFoot: [0.38, 0.96],
        rFoot: [0.5, 0.96],
      }),
  },
  // ---- Tier 5 · narrow / compound / awkward ----------------------------
  {
    id: 'crouch',
    name: '웅크리기',
    difficulty: 5,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.42],
        neck: [0.5, 0.52],
        hip: [0.5, 0.7],
        lHand: [0.34, 0.66],
        rHand: [0.66, 0.66],
        lElbow: [0.32, 0.58],
        rElbow: [0.68, 0.58],
        lFoot: [0.4, 0.95],
        rFoot: [0.6, 0.95],
        lKnee: [0.36, 0.82],
        rKnee: [0.64, 0.82],
      }),
  },
  {
    id: 'deepCrouch',
    name: '깊게 웅크리기',
    difficulty: 5,
    draw: (m) =>
      figure(m, {
        head: [0.5, 0.5],
        neck: [0.5, 0.59],
        hip: [0.5, 0.74],
        lElbow: [0.33, 0.64],
        lHand: [0.38, 0.74],
        rElbow: [0.67, 0.64],
        rHand: [0.62, 0.74],
        lFoot: [0.4, 0.96],
        rFoot: [0.6, 0.96],
        lKnee: [0.36, 0.87],
        rKnee: [0.64, 0.87],
      }),
  },
  {
    id: 'asymReach',
    name: '한 팔 위 + 반대 다리 옆',
    difficulty: 5,
    draw: (m) =>
      figure(m, {
        head: [0.46, 0.19],
        neck: [0.48, 0.3],
        hip: [0.5, 0.6],
        lElbow: [0.4, 0.2],
        lHand: [0.34, 0.06],
        rElbow: [0.6, 0.4],
        rHand: [0.64, 0.5],
        lFoot: [0.44, 0.96],
        rKnee: [0.66, 0.64],
        rFoot: [0.84, 0.7],
      }),
  },
  {
    id: 'captain',
    name: '대각 팔 + 옆 다리',
    difficulty: 5,
    draw: (m) =>
      figure(m, {
        head: [0.54, 0.19],
        neck: [0.52, 0.3],
        hip: [0.5, 0.6],
        lElbow: [0.6, 0.22],
        lHand: [0.72, 0.08],
        rElbow: [0.44, 0.42],
        rHand: [0.4, 0.52],
        lFoot: [0.56, 0.96],
        rKnee: [0.36, 0.64],
        rFoot: [0.18, 0.72],
      }),
  },
]

/** Returns a fresh hole mask for a pose (255 = open hole). */
export function buildPoseMask(pose: Pose): Mask {
  const m = createMask()
  pose.draw(m)
  return m
}

/**
 * The reference body frame the pose library is drawn in, in normalized 0..1
 * stage coordinates: `headY` is where a standing head-top sits and `feetY`
 * where the feet-bottom sits. Derived directly from the canonical upright pose
 * (`stand`, arms down) so it always matches the holes the player must fit. The
 * framing step and the on-canvas guide lines both use this so that lining a
 * standing body up to the head/feet lines lands the silhouette in exactly the
 * vertical band the holes occupy.
 */
export const BODY_FRAME: { headY: number; feetY: number } = (() => {
  const b = maskBounds(buildPoseMask(POSES[0]))
  return { headY: b.top, feetY: b.bottom }
})()

/**
 * Builds the SOLID wall mask for a pose (255 = solid, 0 = open hole).
 * The hole is dilated a little so players are not punished for imperfect edges.
 */
export function buildWallMask(pose: Pose, dilate = 3): Mask {
  const hole = buildPoseMask(pose)
  const dilated = dilateMask(hole, dilate)
  const wall = createMask(hole.width, hole.height)
  for (let i = 0; i < wall.data.length; i++) {
    wall.data[i] = dilated.data[i] > 128 ? 0 : 255
  }
  return wall
}

/** Simple square-kernel dilation by `radius` cells. */
export function dilateMask(m: Mask, radius: number): Mask {
  if (radius <= 0) return cloneMask(m)
  const { width: w, height: h, data } = m
  const out = createMask(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] <= 128) continue
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(h - 1, y + radius)
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(w - 1, x + radius)
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) out.data[yy * w + xx] = 255
      }
    }
  }
  return out
}

/** Erode: shrink the filled region — used to synthesize a "perfect fit" player. */
export function erodeMask(m: Mask, radius: number): Mask {
  if (radius <= 0) return cloneMask(m)
  const { width: w, height: h, data } = m
  const out = createMask(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = true
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(h - 1, y + radius)
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(w - 1, x + radius)
      for (let yy = y0; yy <= y1 && keep; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (data[yy * w + xx] <= 128) {
            keep = false
            break
          }
        }
      }
      out.data[y * w + x] = keep && data[y * w + x] > 128 ? 255 : 0
    }
  }
  return out
}

export interface JudgeResult {
  present: boolean // enough body in frame
  playerArea: number // fraction of grid covered by player
  collisionRatio: number // fraction of player body hitting solid wall
  fillRatio: number // fraction of the hole the player fills
  pass: boolean
  quality: number // 0..1 how clean the pass was (for combos / stars)
}

export interface JudgeConfig {
  minArea: number // minimum player area to count as "present"
  maxCollision: number // collision ratio above which you crash
  minFill: number // must fill at least this much of the hole
}

export const DEFAULT_JUDGE: JudgeConfig = {
  minArea: 0.04,
  maxCollision: 0.2,
  minFill: 0.28,
}

/**
 * Core judgment: does the player silhouette fit through the wall's hole?
 * `wall`: 255 = solid. `player`: 255 = body. Both must share resolution.
 */
export function judge(
  wall: Mask,
  player: Mask,
  cfg: JudgeConfig = DEFAULT_JUDGE,
): JudgeResult {
  const d = wall.data
  const p = player.data
  let playerCount = 0
  let collision = 0
  let holeCount = 0
  let holeFilled = 0
  for (let i = 0; i < d.length; i++) {
    const solid = d[i] > 128
    const body = p[i] > 128
    if (body) playerCount++
    if (!solid) {
      holeCount++
      if (body) holeFilled++
    }
    if (solid && body) collision++
  }
  const total = d.length
  const playerArea = playerCount / total
  const collisionRatio = playerCount > 0 ? collision / playerCount : 0
  const fillRatio = holeCount > 0 ? holeFilled / holeCount : 0
  const present = playerArea >= cfg.minArea
  const pass =
    present && collisionRatio <= cfg.maxCollision && fillRatio >= cfg.minFill
  // quality: reward low collision and good fill
  const quality = Math.max(
    0,
    Math.min(1, (1 - collisionRatio / cfg.maxCollision) * 0.6 + fillRatio * 0.4),
  )
  return { present, playerArea, collisionRatio, fillRatio, pass, quality }
}
