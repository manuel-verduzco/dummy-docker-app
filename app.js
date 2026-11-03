const http = require('http');
const { createClient } = require('redis');

const PORT = Number(process.env.PORT) || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const client = createClient({ url: REDIS_URL });

// Without an 'error' listener, node-redis errors crash the process.
// Log them instead; the client reconnects automatically in the background.
client.on('error', (err) => console.error('Redis error:', err.message));
client.on('ready', () => console.log('Connected to Redis'));

client.connect().catch((err) => console.error('Initial Redis connect failed:', err.message));

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body + '\n');
};

const server = http.createServer(async (req, res) => {
  // Health check: never touches the counter, never needs Redis.
  if (req.url === '/health') {
    return send(res, 200, 'ok');
  }

  // Browsers also request /favicon.ico etc.; only "/" counts as a visit.
  if (req.url !== '/') {
    return send(res, 404, 'Not found');
  }

  if (!client.isReady) {
    return send(res, 503, 'Service unavailable: cannot reach Redis');
  }

  try {
    const visits = await client.incr('visits');
    send(res, 200, `Hello from Docker! Visits: ${visits}`);
  } catch (err) {
    console.error('Counter failed:', err.message);
    send(res, 500, 'Internal server error');
  }
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));

// Docker sends SIGTERM on `docker stop`; close cleanly instead of being killed.
const shutdown = () => {
  server.close(async () => {
    if (client.isOpen) await client.quit().catch(() => {});
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
