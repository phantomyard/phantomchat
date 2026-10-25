const cache = new Map<string, string>();

interface BgGradient {
  start: string;
  end: string;
  cloak: string;
  stroke: string;
}

const bgGradients: BgGradient[] = [
  {start: '#27363e', end: '#456c6e', cloak: '#31444e', stroke: '#607c8966'},
  {start: '#283940', end: '#406066', cloak: '#31464e', stroke: '#60838966'},
  {start: '#27363f', end: '#4c6c7a', cloak: '#30434d', stroke: '#607b8966'},

  {start: '#313d26', end: '#65754a', cloak: '#3e4b2f', stroke: '#7a896066'},
  {start: '#2f3c26', end: '#586741', cloak: '#3b482e', stroke: '#79896066'},
  {start: '#343e26', end: '#666e45', cloak: '#424d30', stroke: '#7a896066'},
  {start: '#2b3e26', end: '#4b785b', cloak: '#364f32', stroke: '#60896e66'},

  {start: '#263d35', end: '#3d6256', cloak: '#2e4a41', stroke: '#60897a66'},
  {start: '#263d38', end: '#3e625e', cloak: '#2e4a46', stroke: '#60898366'},
  {start: '#263c32', end: '#36564d', cloak: '#2d473e', stroke: '#60897b66'},

  {start: '#3d3826', end: '#726a47', cloak: '#4c462f', stroke: '#89836066'},
  {start: '#3d3626', end: '#6b6243', cloak: '#4a422e', stroke: '#89826066'},
  {start: '#3e3a26', end: '#6e6845', cloak: '#4e4831', stroke: '#89836066'},

  {start: '#3e3226', end: '#6e5f46', cloak: '#4d3e30', stroke: '#897d6066'},
  {start: '#3d3226', end: '#766a4a', cloak: '#4a3c2e', stroke: '#89806066'},
  {start: '#3e3026', end: '#675540', cloak: '#4b3a2f', stroke: '#897a6066'},

  {start: '#3e2f27', end: '#6e5845', cloak: '#4e3b31', stroke: '#89756066'},
  {start: '#3e2e27', end: '#725947', cloak: '#4e3931', stroke: '#89726066'},
  {start: '#3e2d27', end: '#6c5244', cloak: '#4d3730', stroke: '#89716066'},

  {start: '#422a29', end: '#815454', cloak: '#543635', stroke: '#89606066'},
  {start: '#402a28', end: '#7f5a51', cloak: '#523634', stroke: '#89676066'},
  {start: '#41292e', end: '#7a4d55', cloak: '#53343a', stroke: '#89606566'},

  {start: '#3f2828', end: '#7a4d4d', cloak: '#4f3232', stroke: '#89606066'},
  {start: '#3e2727', end: '#6f4646', cloak: '#4d3030', stroke: '#89606066'},
  {start: '#40282e', end: '#6e454e', cloak: '#513239', stroke: '#89606666'},

  {start: '#3f2838', end: '#784b5e', cloak: '#503246', stroke: '#89607666'},
  {start: '#3e2739', end: '#7b4d64', cloak: '#4e3147', stroke: '#89607666'},
  {start: '#3d273e', end: '#754d7b', cloak: '#4c314e', stroke: '#83608966'},

  {start: '#293242', end: '#485572', cloak: '#343f52', stroke: '#60728966'},
  {start: '#2a3544', end: '#4d5e7a', cloak: '#364357', stroke: '#60738966'},
  {start: '#272e3e', end: '#444e6c', cloak: '#323b50', stroke: '#606f8966'},
  {start: '#2a3842', end: '#44606d', cloak: '#324551', stroke: '#607c8966'},

  {start: '#352941', end: '#614a76', cloak: '#443655', stroke: '#74608966'},
  {start: '#322941', end: '#615380', cloak: '#413554', stroke: '#6a608966'},

  {start: '#253b3a', end: '#446c66', cloak: '#2d4746', stroke: '#60898266'},
  {start: '#282f40', end: '#55657d', cloak: '#323d50', stroke: '#60728966'}
];

const eyePalettes = [
  '#456c6e', '#3d6256', '#766a4a', '#7a4d55',
  '#4c6c7a', '#65754a', '#754d7b', '#7f5d51',
  '#7e7750', '#784b5a', '#466f60', '#6e6088',
  '#6e5d45', '#456a6e', '#596f46', '#8a8a8a'
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
