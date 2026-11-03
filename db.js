// PostgreSQL access: a connection pool, a tiny migration runner, and the few queries the app needs.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE from the environment, so no
// password ever appears in code or in a connection string.
// A pool keeps a few connections open and lends them out, instead of reconnecting on every request.
const pool = new Pool({ max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });

// An error on an idle connection (for example the database restarts) must not crash the process.
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK = 727274; // any fixed number; it names the advisory lock below

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Applies each migrations/*.sql file that has not run yet, in name order.
// Each file runs in its own transaction: it fully applies or not at all.
async function migrate() {
  const client = await pool.connect();
  try {
    // If two copies of the app start together, only one runs migrations at a time.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

// The database can take a few seconds to accept connections after a restart. Wait, then migrate.
async function waitAndMigrate(attempts = 15) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`Waiting for the database (${i}/${attempts}): ${err.message}`);
      await sleep(2000);
    }
  }
  await migrate();
}

// Every value reaches the database as a numbered parameter ($1, $2), never glued into the SQL text.
// That is what makes SQL injection impossible here.

// Returns false when the username already exists (unique violation, code 23505).
async function createUser(username, passwordHash) {
  try {
    await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, passwordHash]);
    return true;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function getPasswordHash(username) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE username = $1', [username]);
  return rows[0] ? rows[0].password_hash : null;
}

async function recordLogin(username) {
  await pool.query('UPDATE users SET last_login_at = now() WHERE username = $1', [username]);
}

// Adds one and returns the new total, in a single atomic statement. Null if the user no longer exists.
async function incrementVisits(username) {
  const { rows } = await pool.query('UPDATE users SET visits = visits + 1 WHERE username = $1 RETURNING visits', [username]);
  return rows[0] ? rows[0].visits : null;
}

module.exports = { pool, waitAndMigrate, createUser, getPasswordHash, recordLogin, incrementVisits };
