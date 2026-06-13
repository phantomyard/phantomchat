#!/usr/bin/env node
// Sign dist/update-manifest.json using the test key from /tmp/test-priv.b64
import {readFileSync, writeFileSync} from 'fs';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

const privB64 = readFileSync('/tmp/test-priv.b64', 'utf8').trim();
const priv = Uint8Array.from(Buffer.from(privB64, 'base64'));
const manifest = readFileSync('dist/update-manifest.json');
const sig = await ed.signAsync(manifest, priv);
writeFileSync('dist/update-manifest.json.sig', Buffer.from(sig).toString('base64'));
console.log(`Signed dist/update-manifest.json → dist/update-manifest.json.sig (${sig.length} bytes)`);
