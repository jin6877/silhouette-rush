import { useSilhouetteRush } from './game/useSilhouetteRush'
import { StartScreen } from './components/StartScreen'
import { LoadingOverlay } from './components/LoadingOverlay'
import { FramingPanel } from './components/FramingOverlay'
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

      {/* Game stage — kept mounted while playing/over so the canvas persists.
          During framing a control column sits BESIDE (desktop) or BELOW (narrow)
          the camera view so nothing ever floats over the silhouette. */}
      <div
        className={`h-[100svh] w-full ${
          snap.status === 'framing' ? 'flex flex-col md:flex-row' : 'block'
        } ${showCanvas ? '' : 'hidden'}`}
      >
        <div className="relative min-h-0 w-full flex-1">
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

        {snap.status === 'framing' && (
          <FramingPanel
            snap={snap}
            transform={game.transform}
            onZoom={game.setZoom}
            onOffsetY={game.setOffsetY}
            onRecalibrate={game.recalibrate}
            onReset={game.resetTransform}
            onStart={game.startGame}
            onQuit={game.quit}
          />
        )}
      </div>

      {snap.status === 'loading' && <LoadingOverlay progress={game.modelProgress} />}
    </div>
  )
}
