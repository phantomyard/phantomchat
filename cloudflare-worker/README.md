# nostra-ipfs-gateway (Cloudflare Worker)

Serves `https://ipfs.nostra.chat` by:

1. Reading the `_dnslink.ipfs.nostra.chat` TXT record via Cloudflare DoH (updated automatically by `.github/workflows/deploy.yml` on every release tag).
2. Extracting the CID and proxying the request to `https://<cid>.ipfs.dweb.link<path>` — the subdomain form of dweb.link, which has wildcard TLS and works without custom-hostname registration.
3. Adding `x-ipfs-gateway`, `x-ipfs-cid`, `x-dnslink-source` response headers for debugging.

## Why a Worker?

`dweb.link` no longer accepts arbitrary custom hostnames via direct CNAME — hits Cloudflare error 1014 (CNAME Cross-User Banned) when proxied, and 403 when DNS-only. The Worker is the free workaround.

## First deploy (manual, one-time)

```bash
cd cloudflare-worker
pnpm install
npx wrangler login       # OAuth flow in browser
npx wrangler deploy
```

The route `ipfs.nostra.chat/*` is declared in `wrangler.toml` and bound automatically on deploy.

## DNS record required

Before the route can serve traffic, `ipfs.nostra.chat` must exist as a proxied DNS record on Cloudflare so that the Worker route can intercept it. Use a dummy AAAA — the Worker overrides it before the record ever resolves:

| Type | Name | Content | Proxy | TTL |
|---|---|---|---|---|
| AAAA | `ipfs` | `100::` | **Proxied** (orange) | Auto |

Delete the old `ipfs CNAME → ipfs.nostra.chat.ipns.dweb.link` — it's obsolete and causes error 1014.

The `_dnslink.ipfs` TXT record must stay — the Worker reads it on every request.

## Verifying

```bash
curl -sI https://ipfs.nostra.chat | grep -i "x-ipfs\|http"
# Expected:
#   HTTP/2 200
#   x-ipfs-gateway: dweb.link
#   x-ipfs-cid: bafybei...
#   x-dnslink-source: _dnslink.ipfs.nostra.chat
```

## CI deployment (optional, later)

To enable `wrangler deploy` from GitHub Actions, create a token with `Account → Workers Scripts: Edit` + `Zone → Workers Routes: Edit` (scoped to `nostra.chat`), store as `CLOUDFLARE_WORKERS_API_TOKEN`, and add a `deploy-worker` job to `.github/workflows/deploy.yml`.
