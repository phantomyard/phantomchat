import {verifyDetachedSignature} from './signing/verify';

export const MANIFEST_URL = '/update-manifest.json';
export const SIG_URL = '/update-manifest.json.sig';

export interface ProbeResult {
  outcome:
    | 'up-to-date'
    | 'update-available'
    | 'invalid-signature'
    | 'downgrade-rejected'
    | 'network-error'
    | 'parse-error';
  manifest?: any;
  manifestText?: string;   // exact bytes the signature was computed over
  signature?: string;
  reason?: string;
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for(let i = 0; i < 3; i++) {
    if(pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {cache: 'no-cache'});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function probe(trustedPubkeyB64: string, activeVersion?: string): Promise<ProbeResult> {
  let manifestText: string;
  let sigText: string;
  try {
    [manifestText, sigText] = await Promise.all([fetchText(MANIFEST_URL), fetchText(SIG_URL)]);
  } catch(e) {
    return {outcome: 'network-error', reason: String(e)};
  }

  let manifest: any;
  try {
    manifest = JSON.parse(manifestText);
  } catch{
    return {outcome: 'parse-error'};
  }

  const manifestBytes = new TextEncoder().encode(manifestText);
  const ok = await verifyDetachedSignature(manifestBytes, sigText.trim(), trustedPubkeyB64);
  if(!ok) return {outcome: 'invalid-signature'};

  const sigTrimmed = sigText.trim();
  if(activeVersion && manifest.version === activeVersion) {
    return {outcome: 'up-to-date', manifest, manifestText, signature: sigTrimmed};
  }

  if(activeVersion && cmpSemver(manifest.version, activeVersion) < 0 && !manifest.securityRollback) {
    return {outcome: 'downgrade-rejected', manifest, manifestText, reason: `New ${manifest.version} < active ${activeVersion}`};
  }

  return {outcome: 'update-available', manifest, manifestText, signature: sigTrimmed};
}
