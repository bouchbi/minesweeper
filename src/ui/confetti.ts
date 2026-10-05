/**
 * Pluie de confettis plein écran pour la victoire. Un canvas posé par-dessus
 * tout, sans capter la souris, retiré de lui-même à la fin.
 *
 * @returns de quoi l'arrêter avant la fin (démontage du composant).
 */
const COLORS = ['#fbbf24', '#f472b6', '#60a5fa', '#4ade80', '#a78bfa', '#f87171'];
const COUNT = 180;
const DURATION_MS = 4200;
/** Durée du fondu final, comprise dans DURATION_MS. */
const FADE_MS = 900;

type Piece = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; w: number; h: number; color: string };

export function launchConfetti(): () => void {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0;
  let h = 0;
  const resize = () => {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  // Deux salves depuis les coins bas, vers le centre et le haut.
  const pieces: Piece[] = Array.from({ length: COUNT }, (_, k) => {
    const left = k % 2 === 0;
    return {
      x: left ? 0 : w,
      y: h * (0.75 + Math.random() * 0.15),
      vx: (left ? 1 : -1) * (3 + Math.random() * 10),
      vy: -(10 + Math.random() * 11),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      w: 6 + Math.random() * 6,
      h: 3 + Math.random() * 4,
      color: COLORS[k % COLORS.length],
    };
  });

  const t0 = performance.now();
  let last = t0;
  let raf = 0;
  const frame = (now: number) => {
    // Pas de temps normalisé à 60 i/s : même trajectoire sur un écran 120 Hz.
    const dt = Math.min(3, (now - last) / 16.7);
    last = now;
    const age = now - t0;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = Math.min(1, (DURATION_MS - age) / FADE_MS);
    for (const p of pieces) {
      p.vy += 0.32 * dt;
      p.vx *= 0.985 ** dt;
      p.vy *= 0.985 ** dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // Écrasé sur un axe au rythme de la rotation : effet de papier qui tourne.
      ctx.scale(1, Math.cos(p.rot * 2));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (age < DURATION_MS) raf = requestAnimationFrame(frame);
    else stop();
  };
  raf = requestAnimationFrame(frame);

  function stop(): void {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    canvas.remove();
  }
  return stop;
}
