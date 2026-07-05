import { useEffect, useRef } from 'react'
import { POSES, buildPoseMask } from '../game/masks'

interface Props {
  poseName: string | null
  size?: number
  className?: string
}

/** Renders a clean neon silhouette of the target pose so players know the shape. */
export function PosePreview({ poseName, size = 96, className }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = size
    const h = Math.round(size * 0.9)
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const pose = POSES.find((p) => p.name === poseName)
    if (!pose) return
    const mask = buildPoseMask(pose)

    // Build a tinted alpha bitmap of the mask.
    const off = document.createElement('canvas')
    off.width = mask.width
    off.height = mask.height
    const octx = off.getContext('2d')!
    const img = octx.createImageData(mask.width, mask.height)
    for (let i = 0; i < mask.data.length; i++) {
      img.data[i * 4] = 182
      img.data[i * 4 + 1] = 255
      img.data[i * 4 + 2] = 58
      img.data[i * 4 + 3] = mask.data[i]
    }
    octx.putImageData(img, 0, 0)

    const scale = Math.min(w / mask.width, h / mask.height)
    const dw = mask.width * scale
    const dh = mask.height * scale
    ctx.shadowColor = 'rgba(182,255,58,0.9)'
    ctx.shadowBlur = 10
    ctx.drawImage(off, (w - dw) / 2, (h - dh) / 2, dw, dh)
  }, [poseName, size])

  return <canvas ref={ref} style={{ width: size, height: size * 0.9 }} className={className} />
}
