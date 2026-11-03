-- The users table. Runs once, in a transaction, then is recorded in schema_migrations.
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL,
  password_hash text        NOT NULL,            -- bcrypt hash, never the password
  visits        integer     NOT NULL DEFAULT 0,  -- how often this user opened the dashboard
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- The database enforces the same rule as the app, so bad data cannot get in by any route.
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_]{3,20}$')
);

-- One account per username. This is what makes two simultaneous sign-ups for the same name safe:
-- the database lets exactly one INSERT win and rejects the other (error code 23505).
CREATE UNIQUE INDEX users_username_key ON users (username);
