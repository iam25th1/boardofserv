// The one "rough" filter that makes strokes read as chalk. Rendered once at the
// app root; anything with the .chalky class picks it up through url(#rough).
// Turbulence plus displacement only: it roughens edges, it adds no colour.
export function ChalkFilter() {
  return (
    <svg className="chalk-defs" aria-hidden="true" focusable="false">
      <filter id="rough">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={3} />
        <feDisplacementMap in="SourceGraphic" scale={1.6} />
      </filter>
    </svg>
  );
}
