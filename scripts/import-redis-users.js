// One-off: copy user accounts from Redis (where they lived before) into PostgreSQL.
//
//   docker compose exec web node scripts/import-redis-users.js
//   docker compose -f docker-compose.prod.yml exec web node scripts/import-redis-users.js
//
// Safe to run more than once: accounts that already exist in PostgreSQL are skipped.
// Nothing is deleted from Redis, so it stays as a backup of the old accounts.
const { createClient } = require('redis');
const { pool, waitAndMigrate } = require('../db');

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

(async () => {
  await waitAndMigrate();
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
  await redis.connect();

  let imported = 0;
  let skipped = 0;
  let invalid = 0;
  for await (const keys of redis.scanIterator({ MATCH: 'user:*', COUNT: 100 })) {
    for (const key of [].concat(keys)) {
      const username = key.slice('user:'.length);
      const hash = await redis.hGet(key, 'hash');
      if (!USERNAME_RE.test(username) || !hash) {
        invalid++;
        continue;
      }
      const visits = Number.parseInt(await redis.hGet(key, 'visits'), 10) || 0;
      const result = await pool.query(
        'INSERT INTO users (username, password_hash, visits) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
        [username, hash, visits]
      );
      if (result.rowCount === 1) imported++;
      else skipped++;
    }
  }
  console.log(`Imported ${imported} user(s); ${skipped} already in PostgreSQL; ${invalid} ignored (not a valid account).`);
  await redis.quit();
  await pool.end();
})().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
