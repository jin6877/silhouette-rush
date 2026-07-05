interface Props {
  progress: number
}

export function LoadingOverlay({ progress }: Props) {
  const pct = Math.round(progress * 100)
  return (
    <div className="stage-lights absolute inset-0 z-30 flex flex-col items-center justify-center px-6">
      <div className="glass-panel w-full max-w-sm rounded-3xl p-7 text-center">
        <div className="relative mx-auto mb-5 h-16 w-16">
          <div className="absolute inset-0 animate-pulse-glow rounded-2xl bg-gradient-to-br from-neon-cyan to-neon-pink blur-md" />
          <div className="relative flex h-full w-full items-center justify-center rounded-2xl bg-[rgba(10,5,20,0.7)] text-3xl">
            🕺
          </div>
        </div>
        <h3 className="text-lg font-black text-mist-50">무대 준비 중…</h3>
        <p className="mt-1 text-sm text-mist-400">
          실루엣 인식 엔진을 불러오고 있어요.
          <br />첫 실행에는 잠시 걸릴 수 있어요.
        </p>
        <div className="mt-5 h-2.5 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
          <div
            className="progress-neon h-full rounded-full transition-[width] duration-200"
            style={{ width: `${Math.max(4, pct)}%` }}
          />
        </div>
        <div className="mt-2 text-sm font-bold tabular-nums text-mist-200">{pct}%</div>
        <p className="mt-4 text-xs text-mist-500">🔒 카메라 영상은 기기 안에서만 처리됩니다</p>
      </div>
    </div>
  )
}
