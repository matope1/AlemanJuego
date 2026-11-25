import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (requested !== root && !requested.startsWith(root + sep)) { response.writeHead(403).end('Forbidden'); return; }
  try {
    const data = await readFile(requested);
    response.writeHead(200, { 'Content-Type': mime[extname(requested)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Deutsch Brava disponible en http://localhost:${port}`));
