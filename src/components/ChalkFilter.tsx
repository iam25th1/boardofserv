// The one "rough" filter that makes strokes read as chalk. Rendered once at the
// app root; anything with the .chalky class picks it up through url(#rough).
// Turbulence plus displacement only: it roughens edges, it adds no colour.
export function ChalkFilter() {
  return (
    <svg className="chalk-defs" aria-hidden="true" focusable="false">
      {/* A tall region, so thin strokes in short boxes are not clipped. */}
      <filter id="rough" x="-10%" y="-100%" width="120%" height="300%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={3} />
        <feDisplacementMap in="SourceGraphic" scale={1.6} />
      </filter>
    </svg>
  );
}
