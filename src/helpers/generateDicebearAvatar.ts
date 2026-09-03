const cache = new Map<string, string>();

interface BgGradient {
  start: string;
  end: string;
  cloak: string;
  stroke: string;
}

const bgGradients: BgGradient[] = [
  // 1. Electric Cyans / Neon Aqua
  {start: '#032030', end: '#00f2fe', cloak: '#094a6b', stroke: '#38bdf888'},
  {start: '#02293a', end: '#06b6d4', cloak: '#08536f', stroke: '#22d3ee88'},
  {start: '#042232', end: '#38bdf8', cloak: '#0c4764', stroke: '#7dd3fc88'},

  // 2. Acid Lime / Neon Green
  {start: '#152b02', end: '#a3e635', cloak: '#38600a', stroke: '#bef26488'},
  {start: '#122602', end: '#84cc16', cloak: '#2f5509', stroke: '#a3e63588'},
  {start: '#1c2e03', end: '#ccff00', cloak: '#42680a', stroke: '#d9f99d88'},
  {start: '#0f2908', end: '#4ade80', cloak: '#245f1b', stroke: '#86efac88'},

  // 3. Vivid Emerald / Mint
  {start: '#022b1c', end: '#10b981', cloak: '#0a5c40', stroke: '#34d39988'},
  {start: '#032a22', end: '#14b8a6', cloak: '#0c5c4e', stroke: '#2dd4bf88'},
  {start: '#022617', end: '#059669', cloak: '#075239', stroke: '#10b98188'},

  // 4. Bright Gold / Sun Yellow
  {start: '#2b2302', end: '#facc15', cloak: '#634f09', stroke: '#fef08a88'},
  {start: '#2a1f02', end: '#eab308', cloak: '#5e4308', stroke: '#fde04788'},
  {start: '#2e2603', end: '#ffd700', cloak: '#6b570a', stroke: '#fef08a88'},

  // 5. Amber / Honey
  {start: '#2e1903', end: '#f59e0b', cloak: '#693709', stroke: '#fbbf2488'},
  {start: '#2b1702', end: '#fbbf24', cloak: '#613207', stroke: '#fde68a88'},
  {start: '#2c1504', end: '#d97706', cloak: '#5f2d0a', stroke: '#f59e0b88'},

  // 6. Tangerine / Vibrant Orange
  {start: '#331202', end: '#ff7700', cloak: '#6e2b07', stroke: '#fdba7488'},
  {start: '#301003', end: '#f97316', cloak: '#6b250a', stroke: '#fb923c88'},
  {start: '#320e02', end: '#ea580c', cloak: '#692008', stroke: '#f9731688'},

  // 7. Coral / Watermelon
  {start: '#340f0c', end: '#ff5757', cloak: '#6d2621', stroke: '#fca5a588'},
  {start: '#320d09', end: '#ff6b4a', cloak: '#6e231b', stroke: '#ff8a7088'},
  {start: '#330c14', end: '#f43f5e', cloak: '#6e1d2e', stroke: '#fda4af88'},

  // 8. Ferrari Red / Crimson / Ruby
  {start: '#330505', end: '#ef4444', cloak: '#6b1111', stroke: '#f8717188'},
  {start: '#300404', end: '#dc2626', cloak: '#630e0e', stroke: '#ef444488'},
  {start: '#350611', end: '#e11d48', cloak: '#6d1326', stroke: '#fb718588'},

  // 9. Hot Pink / Neon Rose
  {start: '#330524', end: '#ff2a85', cloak: '#6b144e', stroke: '#f472b688'},
  {start: '#2f0525', end: '#ec4899', cloak: '#641351', stroke: '#f472b688'},
  {start: '#2d0430', end: '#d946ef', cloak: '#5e1363', stroke: '#e879f988'},

  // 10. Royal Blue / Electric Cobalt
  {start: '#05183b', end: '#2563eb', cloak: '#10367a', stroke: '#60a5fa88'},
  {start: '#071f45', end: '#3b82f6', cloak: '#13408a', stroke: '#93c5fd88'},
  {start: '#051230', end: '#1d4ed8', cloak: '#0f2c6e', stroke: '#3b82f688'},
  {start: '#06263e', end: '#0ea5e9', cloak: '#114a72', stroke: '#38bdf888'},

  // 11. Cyber Violet
  {start: '#1f0738', end: '#9333ea', cloak: '#47187c', stroke: '#c084fc88'},
  {start: '#1a0736', end: '#8b5cf6', cloak: '#3d1678', stroke: '#a78bfa88'},

  // 12. Cyber Steel / Teal
  {start: '#022423', end: '#00f5d4', cloak: '#0a4f4d', stroke: '#5eead488'},
  {start: '#131926', end: '#94a3b8', cloak: '#303b4f', stroke: '#cbd5e188'}
];

const eyePalettes = [
  '#00f0ff', '#10b981', '#fbbf24', '#f43f5e',
  '#38bdf8', '#a3e635', '#d946ef', '#ff7849',
  '#fde047', '#ff2a6d', '#05ffa1', '#b388ff',
  '#ff9100', '#00e5ff', '#76ff03', '#ffffff'
];

function hashString(str: string): number[] {
  let h1 = 0x811c9dc5;
  let h2 = 0x5bd1e995;
  for(let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x5bd1e995);
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h2 = (h2 ^ (h2 >>> 13)) >>> 0;

  return [
    h1,
    h2,
    (h1 ^ h2) >>> 0,
    ((h1 * 31) ^ h2) >>> 0
  ];
}

function renderEyeSvg(style: number, color: string, filterId: string): string {
  switch(style) {
    case 0:
      return `<rect x="47" y="65" width="34" height="8" rx="4" fill="${color}" filter="url(#${filterId})"/>
              <circle cx="64" cy="69" r="2" fill="#ffffff"/>`;
    case 1:
      return `<rect x="46" y="66" width="12" height="6" rx="3" fill="${color}" filter="url(#${filterId})"/>
              <rect x="70" y="66" width="12" height="6" rx="3" fill="${color}" filter="url(#${filterId})"/>
              <circle cx="52" cy="69" r="1.5" fill="#ffffff"/>
              <circle cx="76" cy="69" r="1.5" fill="#ffffff"/>`;
    case 2:
      return `<path d="M 44 65 L 58 69 L 57 74 L 43 70 Z" fill="${color}" filter="url(#${filterId})"/>
              <path d="M 84 65 L 70 69 L 71 74 L 85 70 Z" fill="${color}" filter="url(#${filterId})"/>
              <circle cx="51" cy="70" r="1.5" fill="#ffffff"/>
              <circle cx="77" cy="70" r="1.5" fill="#ffffff"/>`;
    case 3:
      return `<circle cx="52" cy="69" r="5.5" fill="${color}" filter="url(#${filterId})"/>
              <circle cx="76" cy="69" r="5.5" fill="${color}" filter="url(#${filterId})"/>
              <circle cx="52" cy="69" r="2" fill="#ffffff"/>
              <circle cx="76" cy="69" r="2" fill="#ffffff"/>`;
    case 4:
      return `<rect x="43" y="66" width="42" height="7" rx="3.5" fill="${color}" filter="url(#${filterId})"/>
              <circle cx="53" cy="69.5" r="1.5" fill="#ffffff"/>
              <circle cx="64" cy="69.5" r="1.5" fill="#ffffff"/>
              <circle cx="75" cy="69.5" r="1.5" fill="#ffffff"/>`;
    default:
      return `<ellipse cx="51" cy="68" rx="6" ry="4.5" fill="${color}" filter="url(#${filterId})"/>
              <ellipse cx="77" cy="68" rx="6" ry="4.5" fill="${color}" filter="url(#${filterId})"/>
              <ellipse cx="51" cy="68" rx="2" ry="2" fill="#ffffff"/>
              <ellipse cx="77" cy="68" rx="2" ry="2" fill="#ffffff"/>`;
  }
}

function renderPhantomBody(cx: number, cy: number, scale: number, bg: BgGradient, eyeSvg: string): string {
  return `<g transform="translate(${cx}, ${cy}) scale(${scale}) translate(-64, -64)">
    <path d="M 64 20 C 38 20 24 44 24 78 C 24 100 32 116 35 128 L 93 128 C 96 116 104 100 104 78 C 104 44 90 20 64 20 Z" fill="${bg.cloak}" stroke="${bg.stroke}" stroke-width="${1.5 / scale}"/>
    <path d="M 64 29 C 45 29 34 48 34 74 C 34 92 41 106 45 120 L 83 120 C 87 106 94 92 94 74 C 94 48 83 29 64 29 Z" fill="#0b0e14"/>
    ${eyeSvg}
  </g>`;
}

export function generatePhantomAvatarSvg(seed: string): string {
  const clean = (seed || '').trim().toLowerCase().replace(/^-/, '') || 'phantom-seed';
  const hashes = hashString(clean);

  const bg = bgGradients[hashes[0] % bgGradients.length];
  const eyeColor = eyePalettes[hashes[1] % eyePalettes.length];
  const eyeStyle = hashes[2] % 6;
  const id = (hashes[0].toString(36) + hashes[1].toString(36)).slice(0, 10);
  const eyeSvg = renderEyeSvg(eyeStyle, eyeColor, `glow-${id}`);

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

export function generatePhantomSquadAvatarSvg(seed: string): string {
  const clean = (seed || '').trim().toLowerCase().replace(/^-/, '') || 'phantom-group-seed';
  const hashes = hashString(clean);
  const id = (hashes[0].toString(36) + hashes[1].toString(36)).slice(0, 10);

  const bg = bgGradients[hashes[0] % bgGradients.length];

  // Hero phantom (foreground center leader)
  const heroBg = bgGradients[hashes[1] % bgGradients.length];
  const heroEyeColor = eyePalettes[hashes[2] % eyePalettes.length];
  const heroEyeStyle = (hashes[1] >> 4) % 6;
  const heroEyeSvg = renderEyeSvg(heroEyeStyle, heroEyeColor, `glow-${id}`);

  // Left sentinel
  const leftBg = bgGradients[(hashes[2] + 7) % bgGradients.length];
  const leftEyeColor = eyePalettes[(hashes[3] + 3) % eyePalettes.length];
  const leftEyeStyle = (hashes[2] >> 2) % 6;
  const leftEyeSvg = renderEyeSvg(leftEyeStyle, leftEyeColor, `glow-${id}`);

  // Right sentinel
  const rightBg = bgGradients[(hashes[3] + 13) % bgGradients.length];
  const rightEyeColor = eyePalettes[(hashes[0] + 9) % eyePalettes.length];
  const rightEyeStyle = (hashes[3] >> 5) % 6;
  const rightEyeSvg = renderEyeSvg(rightEyeStyle, rightEyeColor, `glow-${id}`);

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
    <filter id="hero-shadow-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.7"/>
    </filter>
    <clipPath id="clip-${id}">
      <circle cx="64" cy="64" r="64"/>
    </clipPath>
  </defs>
  <g clip-path="url(#clip-${id})">
    <circle cx="64" cy="64" r="64" fill="url(#bg-${id})"/>
    <circle cx="64" cy="64" r="62" fill="none" stroke="${bg.stroke}" stroke-width="2" opacity="0.4"/>
    
    <!-- Mesh Whisper Lines -->
    <g opacity="0.3" stroke-dasharray="2 2">
      <line x1="36" y1="56" x2="64" y2="82" stroke="${leftBg.stroke}" stroke-width="1"/>
      <line x1="92" y1="56" x2="64" y2="82" stroke="${rightBg.stroke}" stroke-width="1"/>
      <line x1="36" y1="56" x2="92" y2="56" stroke="${heroBg.stroke}" stroke-width="1" opacity="0.5"/>
    </g>

    <!-- Left Background Sentinel -->
    ${renderPhantomBody(36, 56, 0.52, leftBg, leftEyeSvg)}

    <!-- Right Background Sentinel -->
    ${renderPhantomBody(92, 56, 0.52, rightBg, rightEyeSvg)}

    <!-- Center Hero Leader (Foreground) -->
    <g filter="url(#hero-shadow-${id})">
      ${renderPhantomBody(64, 82, 0.72, heroBg, heroEyeSvg)}
    </g>
  </g>
</svg>`;
}

/**
 * Generate a deterministic Phantom avatar blob URL from a hex pubkey or seed.
 * Results are cached in memory — same seed + isGroup flag always returns same blob URL.
 */
export async function generateDicebearAvatar(hex: string, isGroup = false): Promise<string> {
  const normalizedHex = typeof hex === 'string' ? hex.replace(/^-/, '') : String(hex).replace(/^-/, '');
  const cacheKey = isGroup ? `group:${normalizedHex}` : normalizedHex;
  const cached = cache.get(cacheKey);
  if(cached) {
    return cached;
  }

  const svg = isGroup ? generatePhantomSquadAvatarSvg(normalizedHex) : generatePhantomAvatarSvg(normalizedHex);
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  cache.set(cacheKey, url);
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
