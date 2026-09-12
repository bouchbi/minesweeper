import { useState } from 'react';
import { LocalSession, type GameConfig } from './game/session';
import { GameScreen } from './ui/GameScreen';
import { HomeScreen } from './ui/HomeScreen';
import { LanScreen } from './ui/LanScreen';

type Screen =
  | { kind: 'home' }
  | { kind: 'solo'; config: GameConfig; seq: number }
  | { kind: 'lan'; url: string; name: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });

  if (screen.kind === 'home') {
    return (
      <HomeScreen
        onStart={(config) => setScreen({ kind: 'solo', config, seq: Date.now() })}
        onJoinLan={(url, name) => setScreen({ kind: 'lan', url, name })}
      />
    );
  }

  if (screen.kind === 'lan') {
    return (
      <LanScreen
        key={screen.url}
        url={screen.url}
        name={screen.name}
        onLeave={() => setScreen({ kind: 'home' })}
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
