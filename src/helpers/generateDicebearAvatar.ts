const cache = new Map<string, string>();

interface BgGradient {
  start: string;
  end: string;
  cloak: string;
  stroke: string;
}

const bgGradients: BgGradient[] = [
  {start: '#31434e', end: '#56878a', cloak: '#3d5561', stroke: '#789bab66'},
  {start: '#324750', end: '#50787f', cloak: '#3d5862', stroke: '#78a4ab66'},
  {start: '#31444f', end: '#5f8798', cloak: '#3c5460', stroke: '#789aab66'},

  {start: '#3d4c30', end: '#7e925c', cloak: '#4e5e3b', stroke: '#98ab7866'},
  {start: '#3b4b2f', end: '#6e8151', cloak: '#4a5a39', stroke: '#97ab7866'},
  {start: '#414d30', end: '#808a56', cloak: '#52603c', stroke: '#99ab7866'},
  {start: '#364d30', end: '#5e9672', cloak: '#43633e', stroke: '#78ab8a66'},

  {start: '#304c42', end: '#4c7a6b', cloak: '#3a5d51', stroke: '#78ab9866'},
  {start: '#304c46', end: '#4d7b76', cloak: '#3a5d57', stroke: '#78aba466'},
  {start: '#2f4b3f', end: '#446c60', cloak: '#38594e', stroke: '#78ab9a66'},

  {start: '#4c4630', end: '#8f8459', cloak: '#5f573b', stroke: '#aba47866'},
  {start: '#4c442f', end: '#867a54', cloak: '#5d523a', stroke: '#aba37866'},
  {start: '#4d4830', end: '#8a8256', cloak: '#615a3d', stroke: '#aba47866'},

  {start: '#4d3f30', end: '#8a7757', cloak: '#604e3c', stroke: '#ab9c7866'},
  {start: '#4c3e30', end: '#93845c', cloak: '#5d4b3a', stroke: '#aba07866'},
  {start: '#4d3c30', end: '#816a50', cloak: '#5e493b', stroke: '#ab987866'},

  {start: '#4e3b31', end: '#8a6e56', cloak: '#614a3d', stroke: '#ab927866'},
  {start: '#4e3931', end: '#8f6f59', cloak: '#61473d', stroke: '#ab8f7866'},
  {start: '#4e3831', end: '#876655', cloak: '#60453c', stroke: '#ab8d7866'},

  {start: '#523533', end: '#a16969', cloak: '#694442', stroke: '#ab787866'},
  {start: '#503532', end: '#9f7065', cloak: '#674441', stroke: '#ab817866'},
  {start: '#513339', end: '#99606a', cloak: '#684149', stroke: '#ab787e66'},

  {start: '#4f3232', end: '#996060', cloak: '#633e3e', stroke: '#ab787866'},
  {start: '#4e3131', end: '#8b5757', cloak: '#603c3c', stroke: '#ab787866'},
  {start: '#503239', end: '#8a5662', cloak: '#653f47', stroke: '#ab787f66'},

  {start: '#4f3246', end: '#965e76', cloak: '#643f58', stroke: '#ab789366'},
  {start: '#4e3147', end: '#9a607d', cloak: '#623d59', stroke: '#ab789366'},
  {start: '#4c314e', end: '#92609a', cloak: '#5f3d62', stroke: '#a478ab66'},

  {start: '#333e52', end: '#5a6a8f', cloak: '#414f67', stroke: '#788fab66'},
  {start: '#354255', end: '#607599', cloak: '#44546d', stroke: '#7890ab66'},
  {start: '#313a4e', end: '#556287', cloak: '#3e4a64', stroke: '#788bab66'},
  {start: '#344653', end: '#557888', cloak: '#3f5665', stroke: '#789bab66'},

  {start: '#423351', end: '#795c93', cloak: '#55436a', stroke: '#9178ab66'},
  {start: '#3f3351', end: '#7968a0', cloak: '#514269', stroke: '#8578ab66'},

  {start: '#2e4a49', end: '#558780', cloak: '#385958', stroke: '#78aba366'},
  {start: '#323b50', end: '#6a7e9c', cloak: '#3f4c64', stroke: '#788fab66'}
];

const eyePalettes = [
  '#56878a', '#4c7a6b', '#93845c', '#99606a',
  '#5f8798', '#7e925c', '#92609a', '#9f7465',
  '#9e9564', '#965e70', '#578b78', '#8a78aa',
  '#8a7456', '#56858a', '#6f8b57', '#adadad'
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
      <feGaussianBlur stdDeviation="0.7" result="blur"/>
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
  const wingmanBg = bgGradients[(hashes[0] + 7) % bgGradients.length];
  const ringColorIdx = hashes[1] % eyePalettes.length;
  const ringColor = eyePalettes[ringColorIdx];
  const accentColor = eyePalettes[(ringColorIdx + 5) % eyePalettes.length];
  const leaderEyeColor = eyePalettes[(hashes[3] + 2) % eyePalettes.length];
  const wingmanEyeColor = eyePalettes[(hashes[3] + 5) % eyePalettes.length];

  const eyeStyle = hashes[2] % 6;
  const leaderEyeSvg = renderEyeSvg(eyeStyle, leaderEyeColor, `glow-${id}`);
  const wingmanEyeSvg = renderEyeSvg((eyeStyle + 1) % 6, wingmanEyeColor, `glow-w-${id}`);

  // Deterministic orbital ring rotation
  const rot = (hashes[0] % 12) * 30;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg.start}"/>
      <stop offset="100%" stop-color="${bg.end}"/>
    </linearGradient>
    <filter id="glow-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="0.7" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="glow-w-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="0.6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="shadow-${id}" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="-2" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.7"/>
    </filter>
    <clipPath id="clip-${id}">
      <circle cx="64" cy="64" r="64"/>
    </clipPath>
  </defs>
  <g clip-path="url(#clip-${id})">
    <circle cx="64" cy="64" r="64" fill="url(#bg-${id})"/>
    <circle cx="64" cy="64" r="62" fill="none" stroke="${bg.stroke}" stroke-width="2" opacity="0.5"/>
    
    <!-- Orbital Encryption Ring / Key Sigil -->
    <g transform="rotate(${rot} 64 64)">
      <!-- Outer Segmented Encryption Ring -->
      <circle cx="64" cy="64" r="54" fill="none" stroke="${ringColor}" stroke-width="2.5" stroke-dasharray="24 10 14 10 32 10" opacity="0.85"/>
      <circle cx="64" cy="64" r="48" fill="none" stroke="${accentColor}" stroke-width="1" stroke-dasharray="3 5" opacity="0.45"/>
      
      <!-- Key Ring Sigil Brackets / Hash Markers -->
      <path d="M 64 8 L 64 16 M 64 112 L 64 120 M 8 64 L 16 64 M 112 64 L 120 64" stroke="${ringColor}" stroke-width="2" stroke-linecap="round"/>
      <path d="M 24 24 L 30 30 M 98 98 L 104 104 M 104 24 L 98 30 M 24 104 L 30 98" stroke="${accentColor}" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>

      <!-- Glowing Orbital Key Nodes -->
      <circle cx="64" cy="10" r="3.5" fill="${ringColor}" filter="url(#glow-${id})"/>
      <circle cx="64" cy="10" r="1.5" fill="#ffffff"/>
      <circle cx="118" cy="64" r="3.5" fill="${ringColor}" filter="url(#glow-${id})"/>
      <circle cx="118" cy="64" r="1.5" fill="#ffffff"/>
      <circle cx="10" cy="64" r="3" fill="${accentColor}" filter="url(#glow-${id})"/>
      <circle cx="10" cy="64" r="1.2" fill="#ffffff"/>
      <circle cx="64" cy="118" r="3" fill="${accentColor}" filter="url(#glow-${id})"/>
      <circle cx="64" cy="118" r="1.2" fill="#ffffff"/>
    </g>

    <!-- Whisper Sync Trace between Duo -->
    <line x1="48" y1="56" x2="74" y2="70" stroke="${accentColor}" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.6"/>

    <!-- Wingman Phantom (Back Left, Scaled Down) -->
    <g opacity="0.82">
      ${renderPhantomBody(48, 56, 0.54, wingmanBg, wingmanEyeSvg)}
    </g>

    <!-- Foreground Leader Phantom (Right Center, Drop Shadow) -->
    <g filter="url(#shadow-${id})">
      ${renderPhantomBody(74, 70, 0.70, bg, leaderEyeSvg)}
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
