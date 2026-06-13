#!/usr/bin/env node
import {readFileSync} from 'fs';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

const manifest = readFileSync('dist/update-manifest.json');
const sigB64 = readFileSync('dist/update-manifest.json.sig', 'utf8').trim();
const tsContent = readFileSync('src/lib/update/signing/trusted-pubkey.generated.ts', 'utf8');
const pubB64 = tsContent.match(/TRUSTED_PUBKEY_B64 = '(.+)'/)[1];

const sig = Uint8Array.from(Buffer.from(sigB64, 'base64'));
const pub = Uint8Array.from(Buffer.from(pubB64, 'base64'));

const ok = await ed.verifyAsync(sig, manifest, pub);
console.log('Pubkey:', pubB64.slice(0, 20) + '...');
console.log('Sig:', sigB64.slice(0, 20) + '...');
console.log('Manifest size:', manifest.length);
console.log('verify OK:', ok);
process.exit(ok ? 0 : 1);
