import { useState } from 'react';
import { LocalSession, type GameConfig } from './game/session';
import { GameScreen } from './ui/GameScreen';
import { HomeScreen, type LanTarget } from './ui/HomeScreen';
import { LanScreen } from './ui/LanScreen';

type Screen =
  | { kind: 'home' }
  | { kind: 'solo'; config: GameConfig; seq: number }
  | { kind: 'lan'; target: LanTarget; seq: number };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const playLocal = (config: GameConfig) => setScreen({ kind: 'solo', config, seq: Date.now() });

  if (screen.kind === 'home') {
    return (
      <HomeScreen
        onStart={playLocal}
        onJoinLan={(target) => setScreen({ kind: 'lan', target, seq: Date.now() })}
      />
    );
  }

  if (screen.kind === 'lan') {
    const { target } = screen;
    const offline = target.solo?.config;
    return (
      <LanScreen
        key={screen.seq}
        url={target.url}
        name={target.name}
        solo={target.solo ? { preset: target.solo.preset } : null}
        onLeave={() => setScreen({ kind: 'home' })}
        onOffline={offline ? () => playLocal(offline) : null}
      />
    );
  }

  const { config, seq } = screen;
  return (
    // `key` force un remontage complet : plateau, viewport et chrono repartent
    // à neuf. Le faire changer suffit donc à rejouer la même configuration.
    <SoloGame
      key={seq}
      config={config}
      onExit={() => setScreen({ kind: 'home' })}
      onRestart={() => setScreen({ kind: 'solo', config, seq: seq + 1 })}
    />
  );
}

function SoloGame({
  config,
  onExit,
  onRestart,
}: {
  config: GameConfig;
  onExit: () => void;
  onRestart: () => void;
}) {
  const [session] = useState(() => new LocalSession(config));
  return <GameScreen session={session} config={config} onExit={onExit} onRestart={onRestart} />;
}
