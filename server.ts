import 'dotenv/config';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

const PORT = Number(process.env.PORT || 3000);
const PYTHON_API_HOST = '127.0.0.1';
const PREFERRED_PYTHON_API_PORT = Number(process.env.PYTHON_API_PORT || 8001);
const isProduction = process.env.NODE_ENV === 'production';

function resolvePythonExecutable(): string {
  const venvPy = path.resolve(process.cwd(), '.venv', 'bin', 'python3');
  if (fs.existsSync(venvPy)) return venvPy;
  return process.env.PYTHON_BIN?.trim() || 'python3';
}

function isTcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, PYTHON_API_HOST, () => {
      probe.close(() => resolve(true));
    });
  });
}

function allocateFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, PYTHON_API_HOST, () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close(() => reject(new Error('Failed to allocate loopback port')));
        return;
      }
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

async function resolvePythonPort(preferred: number): Promise<number> {
  const occupiedV4 = await isTcpReachable(PYTHON_API_HOST, preferred);
  const occupiedV6 = await isTcpReachable('::1', preferred);
  if (!occupiedV4 && !occupiedV6 && (await canBindLoopback(preferred))) {
    return preferred;
  }
  const fallbackPort = await allocateFreeLoopbackPort();
  console.warn(
    `[TRAX LINK Gateway] Port ${preferred} is busy; using free loopback port ${fallbackPort} for Python engine.`
  );
  return fallbackPort;
}

function startPythonBackend(pythonPort: number): ChildProcess {
  const pythonBin = resolvePythonExecutable();
  const child = spawn(
    pythonBin,
    ['-m', 'python_backend', '--host', PYTHON_API_HOST, '--port', String(pythonPort)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  return child;
}

async function waitForPythonHealth(
  pythonPort: number,
  pythonProc: ChildProcess,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `http://${PYTHON_API_HOST}:${pythonPort}/api/health`;
  while (Date.now() < deadline) {
    if (pythonProc.exitCode !== null) {
      throw new Error(`Python backend exited during startup (code=${pythonProc.exitCode})`);
    }
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) {
        const body = (await resp.json().catch(() => null)) as { engine?: string } | null;
        if (body?.engine === 'python') return;
      }
    } catch {
      // Retry until Python HTTP server is listening
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Python backend failed to pass /api/health on port ${pythonPort} within ${timeoutMs}ms`);
}

function createApiProxyMiddleware(io: SocketIOServer, pythonPort: number): express.RequestHandler {
  return (req, res, next) => {
    if (!req.originalUrl.startsWith('/api')) {
      next();
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection') continue;
      headers[k] = v;
    }

    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr && !headers['x-forwarded-for']) {
      headers['x-forwarded-for'] = remoteAddr;
    }

    const proxyReq = http.request(
      {
        hostname: PYTHON_API_HOST,
        port: pythonPort,
        path: req.originalUrl,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const rawEvents = proxyRes.headers['x-trax-events'];
        if (typeof rawEvents === 'string') {
          try {
            const parsed = JSON.parse(rawEvents) as Array<{ event?: string; payload?: unknown }>;
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (item?.event) {
                  io.emit(item.event, item.payload ?? {});
                }
              }
            }
          } catch {
            // Ignore malformed internal event bridge header
          }
        }

        const outHeaders: Record<string, string | string[]> = {};
        for (const [hk, hv] of Object.entries(proxyRes.headers)) {
          if (hv === undefined) continue;
          if (hk.toLowerCase() === 'x-trax-events' || hk.toLowerCase() === 'transfer-encoding') continue;
          outHeaders[hk] = hv;
        }

        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.pipe(res, { end: true });
      }
    );

    proxyReq.on('error', (err) => {
      console.error('[TRAX LINK Gateway] Python API proxy error:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Python billing engine unavailable' });
      }
    });

    req.pipe(proxyReq, { end: true });
  };
}

async function startServer() {
  const pythonPort = await resolvePythonPort(PREFERRED_PYTHON_API_PORT);
  const pythonProc = startPythonBackend(pythonPort);

  const cleanup = () => {
    if (!pythonProc.killed) {
      pythonProc.kill('SIGTERM');
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);

  pythonProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[TRAX LINK Gateway] Python backend exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  const pythonReady = waitForPythonHealth(pythonPort, pythonProc);

  const httpServer = http.createServer();
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    socket.emit('netco:connected', { timestamp: new Date().toISOString(), brand: 'TRAX LINK', engine: 'python' });
  });

  const app = express();
  app.disable('x-powered-by');
  const apiProxy = createApiProxyMiddleware(io, pythonPort);
  app.use((req, res, next) => {
    if (!req.originalUrl.startsWith('/api')) {
      next();
      return;
    }
    pythonReady
      .then(() => apiProxy(req, res, next))
      .catch((err) => {
        if (!res.headersSent) {
          res.status(503).json({
            error: err instanceof Error ? err.message : 'Python billing engine starting',
          });
        }
      });
  });

  if (!isProduction) {
    const viteReady = import('vite').then(({ createServer: createViteServer }) =>
      createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      })
    );
    app.use((req, res, next) => {
      viteReady
        .then((vite) => vite.middlewares(req, res, next))
        .catch(next);
    });
    await Promise.all([pythonReady, viteReady]);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
    await pythonReady;
  }

  httpServer.on('request', app);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, '0.0.0.0', () => {
      httpServer.off('error', reject);
      console.log(
        `TRAX LINK Gateway listening on http://0.0.0.0:${PORT} -> Python WiFi Billing Engine on ${PYTHON_API_HOST}:${pythonPort}`
      );
      resolve();
    });
  });
}

startServer().catch((err) => {
  console.error('Failed to start TRAX LINK server:', err);
  process.exit(1);
});
