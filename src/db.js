const { createClient } = require('@libsql/client');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bars (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    address    TEXT,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cada vez que un usuario prueba un bar deja un reporte con el precio
  -- de la cerveza y si le pusieron tapa. El bar muestra el último reporte.
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bar_id     INTEGER NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    price      REAL NOT NULL,
    has_tapa   INTEGER NOT NULL,
    tapa_type  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS reports_bar_idx ON reports(bar_id, id);

  -- Enlaces para restablecer la contraseña. Solo se guarda el hash del token.
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// Cambios sobre bases de datos creadas con versiones anteriores.
async function migrate(client) {
  const { rows } = await client.execute('PRAGMA table_info(users)');
  if (!rows.some((col) => col.name === 'email')) {
    await client.execute('ALTER TABLE users ADD COLUMN email TEXT');
  }
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email)');
}

// `url` puede ser un fichero local (file:data/birrapp.db), ":memory:" o una
// base de datos remota de Turso (libsql://...), que necesita `authToken`.
async function openDatabase(url, authToken) {
  const client = createClient({ url, authToken });
  await client.executeMultiple(SCHEMA);
  await migrate(client);

  return {
    async get(sql, args = []) {
      const { rows } = await client.execute({ sql, args });
      return rows[0] ?? null;
    },
    async all(sql, args = []) {
      return (await client.execute({ sql, args })).rows;
    },
    async run(sql, args = []) {
      const { lastInsertRowid } = await client.execute({ sql, args });
      return { lastInsertRowid: Number(lastInsertRowid) };
    },
    // Ejecuta varias sentencias en una única transacción de escritura.
    async batch(statements) {
      const results = await client.batch(statements.map(([sql, args]) => ({ sql, args })), 'write');
      return results.map((r) => ({ lastInsertRowid: Number(r.lastInsertRowid) }));
    },
  };
}

module.exports = { openDatabase };
