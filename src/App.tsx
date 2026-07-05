import { useSilhouetteRush } from './game/useSilhouetteRush'
import { StartScreen } from './components/StartScreen'
import { LoadingOverlay } from './components/LoadingOverlay'
import { Hud } from './components/Hud'
import { GameOverScreen } from './components/GameOverScreen'

export default function App() {
  const game = useSilhouetteRush()
  const { snap } = game
  const showCanvas = snap.status === 'playing' || snap.status === 'gameover'

  return (
    <div className="relative min-h-[100svh] w-full overflow-hidden bg-stage-950">
      {snap.status === 'idle' && (
        <StartScreen
          best={snap.best}
          error={game.error}
          onStart={() => game.start()}
          onDemo={() => game.start({ fake: true })}
        />
      )}

      {/* Game stage — kept mounted while playing/over so the canvas persists */}
      <div className={`relative h-[100svh] w-full ${showCanvas ? 'block' : 'hidden'}`}>
        <canvas ref={game.canvasRef} className="block h-full w-full" />

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
