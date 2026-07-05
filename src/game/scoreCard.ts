// Draws a shareable result card (canvas) combining the score, run stats, and a
// snapshot of the player's final neon silhouette. Everything stays local — the
// image is only saved/copied on the user's device.

import type { Snapshot } from './useSilhouetteRush'

const W = 1080
const H = 1080

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

export function buildScoreCard(snap: Snapshot, matte: HTMLCanvasElement | null): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#1a0a30')
  bg.addColorStop(0.5, '#12071f')
  bg.addColorStop(1, '#0a0416')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // Spotlight
  const rg = ctx.createRadialGradient(W / 2, 120, 20, W / 2, 240, 720)
  rg.addColorStop(0, 'rgba(168,85,247,0.35)')
  rg.addColorStop(1, 'rgba(168,85,247,0)')
  ctx.fillStyle = rg
  ctx.fillRect(0, 0, W, H)

  // Grid floor
  ctx.save()
  ctx.strokeStyle = 'rgba(34,233,255,0.10)'
  ctx.lineWidth = 1
  for (let y = 620; y < H; y += 40) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.stroke()
  }
  ctx.restore()

  // Header
  ctx.textAlign = 'center'
  ctx.fillStyle = '#7ff2ff'
  ctx.font = '700 34px Pretendard, -apple-system, sans-serif'
  ctx.fillText('SILHOUETTE RUSH · 실루엣 러시', W / 2, 92)

  // Silhouette snapshot frame
  const boxX = 300
  const boxY = 140
  const boxW = 480
  const boxH = 380
  ctx.save()
  const boxGrad = ctx.createLinearGradient(boxX, boxY, boxX, boxY + boxH)
  boxGrad.addColorStop(0, 'rgba(61,28,114,0.55)')
  boxGrad.addColorStop(1, 'rgba(20,8,40,0.7)')
  ctx.fillStyle = boxGrad
  roundRect(ctx, boxX, boxY, boxW, boxH, 28)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,46,154,0.55)'
  ctx.lineWidth = 3
  ctx.stroke()

  if (matte && matte.width > 0) {
    roundRect(ctx, boxX + 6, boxY + 6, boxW - 12, boxH - 12, 22)
    ctx.clip()
    // tint the matte cyan/lime
    const tint = document.createElement('canvas')
    tint.width = matte.width
    tint.height = matte.height
    const tctx = tint.getContext('2d')!
    tctx.drawImage(matte, 0, 0)
    tctx.globalCompositeOperation = 'source-in'
    tctx.fillStyle = '#22e9ff'
    tctx.fillRect(0, 0, tint.width, tint.height)
    const scale = Math.max(boxW / matte.width, boxH / matte.height)
    const dw = matte.width * scale
    const dh = matte.height * scale
    ctx.shadowColor = 'rgba(34,233,255,0.9)'
    ctx.shadowBlur = 30
    ctx.drawImage(tint, boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh)
  } else {
    ctx.fillStyle = 'rgba(216,199,240,0.5)'
    ctx.font = '500 24px Pretendard, sans-serif'
    ctx.fillText('실루엣 스냅샷', W / 2, boxY + boxH / 2)
  }
  ctx.restore()

  // Score
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(216,199,240,0.85)'
  ctx.font = '600 30px Pretendard, sans-serif'
  ctx.fillText('최종 점수', W / 2, 610)

  const scoreGrad = ctx.createLinearGradient(W / 2 - 260, 0, W / 2 + 260, 0)
  scoreGrad.addColorStop(0, '#22e9ff')
  scoreGrad.addColorStop(0.5, '#a855f7')
  scoreGrad.addColorStop(1, '#ff2e9a')
  ctx.fillStyle = scoreGrad
  ctx.font = '800 148px Pretendard, -apple-system, sans-serif'
  ctx.shadowColor = 'rgba(168,85,247,0.6)'
  ctx.shadowBlur = 30
  ctx.fillText(String(snap.score), W / 2, 730)
  ctx.shadowBlur = 0

  // Stats cards
  const stats: [string, string][] = [
    ['통과', `${snap.passes}회`],
    ['최고 콤보', `${snap.bestCombo}`],
    ['도달 라운드', `${snap.round}`],
  ]
  const cardW = 300
  const gap = 30
  const totalW = cardW * 3 + gap * 2
  let sx = (W - totalW) / 2
  const sy = 792
  const cardH = 140
  for (const [label, value] of stats) {
    ctx.fillStyle = 'rgba(44,19,82,0.6)'
    roundRect(ctx, sx, sy, cardW, cardH, 20)
    ctx.fill()
    ctx.strokeStyle = 'rgba(34,233,255,0.25)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.fillStyle = 'rgba(216,199,240,0.7)'
    ctx.font = '600 26px Pretendard, sans-serif'
    ctx.fillText(label, sx + cardW / 2, sy + 52)
    ctx.fillStyle = '#f4ecff'
    ctx.font = '800 52px Pretendard, sans-serif'
    ctx.fillText(value, sx + cardW / 2, sy + 112)
    sx += cardW + gap
  }

  // Footer
  ctx.fillStyle = 'rgba(255,46,154,0.9)'
  ctx.font = '700 30px Pretendard, sans-serif'
  ctx.fillText('몸으로 통과하는 벽 · 웹캠 전신 아케이드', W / 2, 1000)
  ctx.fillStyle = 'rgba(216,199,240,0.55)'
  ctx.font = '500 24px Pretendard, sans-serif'
  ctx.fillText('영상은 기기를 떠나지 않습니다', W / 2, 1044)

  return c
}

export function downloadCard(canvas: HTMLCanvasElement, filename = 'silhouette-rush.png') {
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'image/png')
}

export async function copyCard(canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!blob) return false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CI = (window as any).ClipboardItem
    if (!navigator.clipboard || !CI) return false
    await navigator.clipboard.write([new CI({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}
