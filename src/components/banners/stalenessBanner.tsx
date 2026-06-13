export function StalenessBanner(props: {version: string; onUpdate: () => void; onDismiss24h: () => void}) {
  return (
    <div style='position:fixed;top:0;left:0;right:0;background:var(--warning-color);color:#000;padding:0.75rem 1rem;z-index:9998;font-size:0.9rem;display:flex;gap:1rem;justify-content:space-between;align-items:center'>
      <span>Stai usando una versione datata. Patch di sicurezza disponibili in v{props.version}.</span>
      <div style='display:flex;gap:0.5rem'>
        <button onClick={props.onDismiss24h} style='background:transparent;border:1px solid #000;padding:0.25rem 0.5rem'>Posticipa 24h</button>
        <button onClick={props.onUpdate} style='background:#000;color:#fff;border:0;padding:0.25rem 0.75rem;border-radius:0.25rem'>Aggiorna</button>
      </div>
    </div>
  );
}
