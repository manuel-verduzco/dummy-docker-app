const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createClient } = require('redis');

const PORT = Number(process.env.PORT) || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
// Set REGISTRATION_OPEN=false to stop new sign-ups (existing users can still log in).
const REGISTRATION_OPEN = process.env.REGISTRATION_OPEN !== 'false';

// Signs the session cookie. Must come from the environment, never from a file.
// Without one (local dev) a random secret is used and sessions reset on restart.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set: using a random one; sessions reset on restart.');
}

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const BCRYPT_ROUNDS = 10;
const MAX_FAILED_LOGINS = 5;
const FAIL_WINDOW_SECONDS = 15 * 60;
// Compared against when the user doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const client = createClient({ url: REDIS_URL });

// Without an 'error' listener, node-redis errors crash the process.
// Log them instead; the client reconnects automatically in the background.
client.on('error', (err) => console.error('Redis error:', err.message));
client.on('ready', () => console.log('Connected to Redis'));

client.connect().catch((err) => console.error('Initial Redis connect failed:', err.message));

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><body style="font-family:monospace;max-width:32rem;margin:2rem auto;padding:0 1rem">` +
  `${body}</body>\n`;

const form = (action, button, extra = '') =>
  `<form method="post" action="${action}">` +
  `<p><label>Username<br><input name="username" required minlength="3" maxlength="20" autocomplete="username"></label></p>` +
  `<p><label>Password<br><input name="password" type="password" required minlength="8" maxlength="72" ` +
  `autocomplete="${action === '/register' ? 'new-password' : 'current-password'}"></label></p>` +
  `${extra}<p><button>${button}</button></p></form>`;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // one proxy hop (Caddy): real client IP and https detection

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  next();
});

// Health check: before sessions and Redis checks, so it never touches the counter or creates a session.
app.get('/health', (req, res) => res.type('text').send('ok\n'));

app.use((req, res, next) => {
  if (!client.isReady) return res.status(503).type('text').send('Service unavailable: cannot reach Redis\n');
  next();
});

app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(
  session({
    store: new RedisStore({ client, prefix: 'sess:' }),
    secret: SESSION_SECRET,
    name: 'sid',
    resave: false,
    saveUninitialized: false, // anonymous visitors get no session or cookie
    cookie: {
      httpOnly: true, // JavaScript can't read the cookie
      sameSite: 'lax', // not sent on cross-site POSTs (CSRF protection)
      secure: 'auto', // Secure flag whenever the request came in over HTTPS
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

const requireLogin = (req, res, next) => (req.session.user ? next() : res.redirect('/login'));

// Only "/" counts as a global visit; browsers also request /favicon.ico etc., which 404.
app.get('/', async (req, res) => {
  const visits = await client.incr('visits');
  const user = req.session.user;
  res.send(
    page(
      'Home',
      `<h1>Hello from Docker v4!</h1><p>Visits: ${visits}</p>` +
        (user
          ? `<p>Logged in as <b>${esc(user)}</b>. <a href="/dashboard">Dashboard</a></p>` +
            `<form method="post" action="/logout"><button>Log out</button></form>`
          : `<p><a href="/login">Log in</a> or <a href="/register">register</a></p>`)
    )
  );
});

app.get('/register', (req, res) => {
  if (!REGISTRATION_OPEN) return res.status(403).send(page('Register', '<p>Registration is closed.</p>'));
  res.send(page('Register', `<h1>Register</h1>${form('/register', 'Create account')}<p><a href="/login">Log in</a></p>`));
});

app.post('/register', async (req, res) => {
  if (!REGISTRATION_OPEN) return res.status(403).send(page('Register', '<p>Registration is closed.</p>'));
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const fail = (status, msg) =>
    res.status(status).send(page('Register', `<p><b>${esc(msg)}</b></p>${form('/register', 'Create account')}`));

  if (!USERNAME_RE.test(username)) return fail(400, 'Username: 3-20 characters, a-z, 0-9 or _.');
  // bcrypt only uses the first 72 bytes of a password.
  if (password.length < 8 || Buffer.byteLength(password) > 72) return fail(400, 'Password: 8-72 characters.');

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // The database's unique index decides: two simultaneous sign-ups for one name can't both succeed.
  const created = await db.createUser(username, hash);
  if (!created) return fail(409, 'That username is taken.');
  res.redirect('/login?registered=1');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const note = req.query.registered ? '<p>Account created. Please log in.</p>' : '';
  res.send(page('Log in', `<h1>Log in</h1>${note}${form('/login', 'Log in')}<p><a href="/register">Register</a></p>`));
});

app.post('/login', async (req, res, next) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const failKey = `loginfail:${req.ip}`;
  const reject = (status, msg) =>
    res.status(status).send(page('Log in', `<p><b>${esc(msg)}</b></p>${form('/login', 'Log in')}`));

  if (Number(await client.get(failKey)) >= MAX_FAILED_LOGINS) {
    return reject(429, 'Too many failed attempts. Try again in 15 minutes.');
  }

  const stored = USERNAME_RE.test(username) ? await db.getPasswordHash(username) : null;
  const ok = await bcrypt.compare(password.slice(0, 72), stored || DUMMY_HASH);
  if (!stored || !ok) {
    const fails = await client.incr(failKey);
    if (fails === 1) await client.expire(failKey, FAIL_WINDOW_SECONDS);
    // Same message for "no such user" and "wrong password".
    return reject(401, 'Invalid username or password.');
  }

  await client.del(failKey);
  await db.recordLogin(username);
  // New session ID on login prevents session fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = username;
    req.session.save((err2) => (err2 ? next(err2) : res.redirect('/dashboard')));
  });
});

app.get('/dashboard', requireLogin, async (req, res) => {
  const mine = await db.incrementVisits(req.session.user);
  if (mine === null) {
    // The account was deleted while this session was still open: end the session.
    return req.session.destroy(() => res.clearCookie('sid').redirect('/login'));
  }
  res.send(
    page(
      'Dashboard',
      `<h1>Dashboard</h1><p>Welcome, <b>${esc(req.session.user)}</b>.</p>` +
        `<p>You have opened this page ${mine} time(s).</p>` +
        `<p><a href="/">Home</a></p><form method="post" action="/logout"><button>Log out</button></form>`
    )
  );
});

app.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('sid');
    res.redirect('/');
  });
});

app.use((req, res) => res.status(404).type('text').send('Not found\n'));

// Errors that mean "cannot reach the database right now" (as opposed to a bug in our code).
const DB_UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03', '08001', '08006']);
const dbUnreachable = (err) =>
  DB_UNREACHABLE.has(err.code) || /connection terminated|timeout exceeded when trying to connect/i.test(err.message);

app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);
  if (res.headersSent) return next(err);
  if (dbUnreachable(err)) return res.status(503).type('text').send('Service unavailable: cannot reach the database\n');
  res.status(500).type('text').send('Internal server error\n');
});

// Wait for the database and apply any pending migrations before taking requests.
// If it never comes up we exit, and Docker's restart policy tries again.
let server;
db.waitAndMigrate()
  .then(() => {
    server = app.listen(PORT, () => console.log(`Listening on ${PORT}`));
  })
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    process.exit(1);
  });

// Docker sends SIGTERM on `docker stop`; close cleanly instead of being killed.
const shutdown = () => {
  const finish = async () => {
    if (client.isOpen) await client.quit().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  if (server) server.close(finish);
  else finish();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
