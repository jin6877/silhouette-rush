import { useSilhouetteRush } from './game/useSilhouetteRush'
import { StartScreen } from './components/StartScreen'
import { LoadingOverlay } from './components/LoadingOverlay'
import { FramingOverlay } from './components/FramingOverlay'
import { Hud } from './components/Hud'
import { GameOverScreen } from './components/GameOverScreen'

export default function App() {
  const game = useSilhouetteRush()
  const { snap } = game
  const showCanvas =
    snap.status === 'playing' || snap.status === 'gameover' || snap.status === 'framing'

  return (
    <div className="relative min-h-[100svh] w-full overflow-hidden bg-stage-950">
      {snap.status === 'idle' && (
        <StartScreen
          best={snap.best}
          error={game.error}
          errorDetail={game.errorDetail}
          onStart={() => game.start()}
          onDemo={() => game.start({ fake: true })}
        />
      )}

      {/* Game stage — kept mounted while playing/over so the canvas persists */}
      <div className={`relative h-[100svh] w-full ${showCanvas ? 'block' : 'hidden'}`}>
        <canvas ref={game.canvasRef} className="block h-full w-full" />

        {snap.status === 'framing' && (
          <FramingOverlay snap={snap} onStart={game.startGame} onQuit={game.quit} />
        )}

        {snap.status === 'playing' && <Hud snap={snap} onQuit={game.quit} />}

        {snap.status === 'gameover' && (
          <GameOverScreen
            snap={snap}
            matte={game.getLastMatte()}
            onRetry={game.restart}
            onHome={game.quit}
          />
        )}
      </div>

      {snap.status === 'loading' && <LoadingOverlay progress={game.modelProgress} />}
    </div>
  )
}
