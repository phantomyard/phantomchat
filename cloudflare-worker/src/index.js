const DNSLINK_NAME = '_dnslink.ipfs.nostra.chat';
const UPSTREAM_GATEWAY_SUFFIX = '.ipfs.dweb.link';
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNSLINK_CACHE_TTL = 60;
const CONTENT_CACHE_TTL = 300;

async function resolveDnsLinkCID() {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(DNSLINK_NAME)}&type=TXT`;
  const resp = await fetch(url, {
    headers: {accept: 'application/dns-json'},
    cf: {cacheTtl: DNSLINK_CACHE_TTL, cacheEverything: true}
  });
  if(!resp.ok) throw new Error(`DoH lookup failed: ${resp.status}`);
  const data = await resp.json();
  const value = (data.Answer || [])
    .map((a) => String(a.data || '').replace(/^"|"$/g, ''))
    .find((v) => v.startsWith('dnslink=/ipfs/'));
  if(!value) throw new Error('No DNSLink TXT record found');
  return value.slice('dnslink=/ipfs/'.length);
}

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    // Phase A: manifest must never be cached — freshness is security-critical.
    if(reqUrl.pathname === '/update-manifest.json') {
      try {
        const cid = await resolveDnsLinkCID();
        const upstreamUrl = `https://${cid}${UPSTREAM_GATEWAY_SUFFIX}${reqUrl.pathname}${reqUrl.search}`;
        const upstreamResp = await fetch(upstreamUrl, {
          cf: {cacheTtl: 0, cacheEverything: false}
        });
        const response = new Response(upstreamResp.body, upstreamResp);
        response.headers.set('Cache-Control', 'no-cache, must-revalidate');
        response.headers.set('x-ipfs-gateway', 'dweb.link');
        response.headers.set('x-ipfs-cid', cid);
        response.headers.set('x-dnslink-source', DNSLINK_NAME);
        return response;
      } catch(e) {
        return new Response(`IPFS gateway error: ${e.message}\n`, {
          status: 502,
          headers: {'content-type': 'text/plain; charset=utf-8'}
        });
      }
    }

    try {
      const cid = await resolveDnsLinkCID();
      const upstreamUrl = `https://${cid}${UPSTREAM_GATEWAY_SUFFIX}${reqUrl.pathname}${reqUrl.search}`;

      const upstreamReq = new Request(upstreamUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow'
      });

      const upstreamResp = await fetch(upstreamReq, {
        cf: {cacheTtl: CONTENT_CACHE_TTL, cacheEverything: true}
      });

      const response = new Response(upstreamResp.body, upstreamResp);
      response.headers.set('x-ipfs-gateway', 'dweb.link');
      response.headers.set('x-ipfs-cid', cid);
      response.headers.set('x-dnslink-source', DNSLINK_NAME);
      return response;
    } catch(e) {
      return new Response(`IPFS gateway error: ${e.message}\n`, {
        status: 502,
        headers: {'content-type': 'text/plain; charset=utf-8'}
      });
    }
  }
};
