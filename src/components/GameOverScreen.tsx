import { useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../game/useSilhouetteRush'
import { buildScoreCard, downloadCard, copyCard } from '../game/scoreCard'

interface Props {
  snap: Snapshot
  matte: HTMLCanvasElement | null
  onRetry: () => void
  onHome: () => void
}

export function GameOverScreen({ snap, matte, onRetry, onHome }: Props) {
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const [copied, setCopied] = useState(false)
  const isRecord = snap.score >= snap.best && snap.score > 0

  const card = useMemo(() => buildScoreCard(snap, matte), [snap, matte])

  useEffect(() => {
    const c = previewRef.current
    if (!c) return
    const ctx = c.getContext('2d')!
    c.width = card.width
    c.height = card.height
    ctx.drawImage(card, 0, 0)
  }, [card])

  return (
    <div className="stage-lights absolute inset-0 z-20 flex flex-col items-center overflow-y-auto px-5 py-8 no-scrollbar">
      <div className="relative z-10 flex w-full max-w-md flex-col items-center">
        <div className="animate-fade-up text-center">
          <div className="neon-text-pink text-sm font-bold tracking-[0.4em]">GAME OVER</div>
          {isRecord ? (
            <h2 className="text-neon-gradient mt-1 text-4xl font-black">🏆 신기록!</h2>
          ) : (
            <h2 className="mt-1 text-3xl font-black text-mist-50">수고했어요!</h2>
          )}
        </div>

        <div className="animate-pop-in mt-5 w-full overflow-hidden rounded-3xl border border-[rgba(168,85,247,0.35)] shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]">
          <canvas ref={previewRef} className="block w-full" />
        </div>

        <div className="animate-fade-up mt-4 grid w-full grid-cols-3 gap-2">
          {[
            ['통과', `${snap.passes}`],
            ['최고 콤보', `${snap.bestCombo}`],
            ['라운드', `${snap.round}`],
          ].map(([label, value]) => (
            <div key={label} className="glass-panel rounded-xl px-2 py-3 text-center">
              <div className="text-[11px] font-semibold text-mist-400">{label}</div>
              <div className="text-xl font-black text-mist-50">{value}</div>
            </div>
          ))}
        </div>

        <div className="animate-fade-up mt-5 flex w-full flex-col gap-2.5">
          <button
            onClick={onRetry}
            className="btn-neon w-full rounded-2xl px-6 py-3.5 text-base font-black text-stage-950"
          >
            다시 도전 ▸
          </button>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={() => downloadCard(card, `silhouette-rush-${snap.score}.png`)}
              className="rounded-2xl border border-[rgba(34,233,255,0.35)] bg-[rgba(34,233,255,0.08)] px-4 py-3 text-sm font-bold text-neon-cyan-soft transition hover:bg-[rgba(34,233,255,0.16)]"
            >
              ⬇ 이미지 저장
            </button>
            <button
              onClick={async () => {
                const ok = await copyCard(card)
                setCopied(ok)
                setTimeout(() => setCopied(false), 1600)
              }}
              className="rounded-2xl border border-[rgba(255,46,154,0.35)] bg-[rgba(255,46,154,0.08)] px-4 py-3 text-sm font-bold text-neon-pink-soft transition hover:bg-[rgba(255,46,154,0.16)]"
            >
              {copied ? '✓ 복사됨' : '⧉ 결과 복사'}
            </button>
          </div>
          <button
            onClick={onHome}
            className="mt-1 w-full rounded-2xl border border-[rgba(168,85,247,0.3)] px-6 py-2.5 text-sm font-semibold text-mist-400 transition hover:text-mist-50"
          >
            처음 화면으로
          </button>
        </div>
      </div>
    </div>
  )
}
