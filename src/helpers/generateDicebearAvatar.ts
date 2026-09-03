const cache = new Map<string, string>();

interface BgGradient {
  start: string;
  end: string;
  cloak: string;
  stroke: string;
}

const bgGradients: BgGradient[] = [
  {start: '#0a192f', end: '#1f9bdf', cloak: '#162b4d', stroke: '#38bdf855'},
  {start: '#180b2b', end: '#8b5cf6', cloak: '#271945', stroke: '#a78bfa55'},
  {start: '#06201b', end: '#10b981', cloak: '#0d3830', stroke: '#34d39955'},
  {start: '#1e0a0a', end: '#ef4444', cloak: '#381616', stroke: '#f8717155'},
  {start: '#1e1b4b', end: '#6366f1', cloak: '#2e2a6b', stroke: '#818cf855'},
  {start: '#0f172a', end: '#38bdf8', cloak: '#1e293b', stroke: '#7dd3fc55'},
  {start: '#2e1065', end: '#c084fc', cloak: '#431d87', stroke: '#e9d5ff55'},
  {start: '#022c22', end: '#14b8a6', cloak: '#0f4c3e', stroke: '#5eead455'},
  {start: '#2d0617', end: '#f43f5e', cloak: '#4c1228', stroke: '#fb718555'},
  {start: '#1a1003', end: '#f59e0b', cloak: '#38250b', stroke: '#fbbf2455'},
  {start: '#082f49', end: '#06b6d4', cloak: '#104e70', stroke: '#67e8f955'},
  {start: '#141414', end: '#52525b', cloak: '#27272a', stroke: '#a1a1aa55'}
];

const eyePalettes = [
  '#00f0ff', '#10b981', '#fbbf24', '#f43f5e', '#38bdf8', '#a3e635', '#d946ef', '#ff7849'
];

export function generatePhantomAvatarSvg(hex: string): string {
  const clean = (hex || '00').replace(/[^0-9a-fA-F]/g, '') || '00';
  const bytes: number[] = [];
  for(let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16) || 0);
  }
  while(bytes.length < 16) bytes.push(bytes.length * 31);

  const b0 = bytes[0] || 0;
  const b1 = bytes[1] || 0;
  const b2 = bytes[2] || 0;

  const bg = bgGradients[b0 % bgGradients.length];
  const eyeColor = eyePalettes[b1 % eyePalettes.length];
  const eyeStyle = b2 % 6;
  const id = clean.slice(0, 8) || 'ph';

  let eyeSvg = '';
  switch(eyeStyle) {
    case 0:
      eyeSvg = `<rect x="47" y="65" width="34" height="8" rx="4" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <circle cx="64" cy="69" r="2" fill="#ffffff"/>`;
      break;
    case 1:
      eyeSvg = `<rect x="46" y="66" width="12" height="6" rx="3" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <rect x="70" y="66" width="12" height="6" rx="3" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <circle cx="52" cy="69" r="1.5" fill="#ffffff"/>
                <circle cx="76" cy="69" r="1.5" fill="#ffffff"/>`;
      break;
    case 2:
      eyeSvg = `<path d="M 44 65 L 58 69 L 57 74 L 43 70 Z" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <path d="M 84 65 L 70 69 L 71 74 L 85 70 Z" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <circle cx="51" cy="70" r="1.5" fill="#ffffff"/>
                <circle cx="77" cy="70" r="1.5" fill="#ffffff"/>`;
      break;
    case 3:
      eyeSvg = `<circle cx="52" cy="69" r="5.5" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <circle cx="76" cy="69" r="5.5" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <circle cx="52" cy="69" r="2" fill="#ffffff"/>
                <circle cx="76" cy="69" r="2" fill="#ffffff"/>`;
      break;
    case 4:
      eyeSvg = `<rect x="43" y="66" width="42" height="7" rx="3.5" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <circle cx="53" cy="69.5" r="1.5" fill="#ffffff"/>
                <circle cx="64" cy="69.5" r="1.5" fill="#ffffff"/>
                <circle cx="75" cy="69.5" r="1.5" fill="#ffffff"/>`;
      break;
    default:
      eyeSvg = `<ellipse cx="51" cy="68" rx="6" ry="4.5" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <ellipse cx="77" cy="68" rx="6" ry="4.5" fill="${eyeColor}" filter="url(#glow-${id})"/>
                <ellipse cx="51" cy="68" rx="2" ry="2" fill="#ffffff"/>
                <ellipse cx="77" cy="68" rx="2" ry="2" fill="#ffffff"/>`;
      break;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg.start}"/>
      <stop offset="100%" stop-color="${bg.end}"/>
    </linearGradient>
    <filter id="glow-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <clipPath id="clip-${id}">
      <circle cx="64" cy="64" r="64"/>
    </clipPath>
  </defs>
  <g clip-path="url(#clip-${id})">
    <circle cx="64" cy="64" r="64" fill="url(#bg-${id})"/>
    <circle cx="64" cy="64" r="62" fill="none" stroke="${bg.stroke}" stroke-width="2" opacity="0.5"/>
    
    <!-- Outer Cloak / Hood -->
    <path d="M 64 20 C 38 20 24 44 24 78 C 24 100 32 116 35 128 L 93 128 C 96 116 104 100 104 78 C 104 44 90 20 64 20 Z" fill="${bg.cloak}" stroke="${bg.stroke}" stroke-width="1.5"/>
    
    <!-- Inner Face Void -->
    <path d="M 64 29 C 45 29 34 48 34 74 C 34 92 41 106 45 120 L 83 120 C 87 106 94 92 94 74 C 94 48 83 29 64 29 Z" fill="#0b0e14"/>
    
    <!-- Eyes / Visor -->
    ${eyeSvg}
  </g>
</svg>`;
}

/**
 * Generate a deterministic Phantom avatar blob URL from a hex pubkey.
 * Results are cached in memory — same hex always returns same blob URL.
 */
export async function generateDicebearAvatar(hex: string): Promise<string> {
  const cached = cache.get(hex);
  if(cached) {
    return cached;
  }

  const svg = generatePhantomAvatarSvg(hex);
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  cache.set(hex, url);
  return url;
}

/**
 * Clear all cached blob URLs. Useful for testing.
 */
export function clearDicebearCache(): void {
  for(const url of cache.values()) {
    URL.revokeObjectURL(url);
  }
  cache.clear();
}
