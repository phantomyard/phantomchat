// @ts-nocheck
import http from 'http';

export class LocalManifestServer {
  private servers: http.Server[] = [];
  private manifests: Map<number, string> = new Map();

  async start(ports: number[] = [7801, 7802, 7803]): Promise<void> {
    for(const port of ports) {
      const server = http.createServer((req, res) => {
        if(req.url?.endsWith('/update-manifest.json')) {
          const body = this.manifests.get(port) || '{}';
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          });
          res.end(body);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>(resolve => server.listen(port, resolve));
      this.servers.push(server);
    }
  }

  setManifest(port: number, manifest: any): void {
    this.manifests.set(port, JSON.stringify(manifest));
  }

  async stop(): Promise<void> {
    for(const s of this.servers) {
      await new Promise<void>(r => s.close(() => r()));
    }
  }
}
