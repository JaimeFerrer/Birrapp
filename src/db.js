const { DatabaseSync } = require('node:sqlite');

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
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
  `);
  return db;
}

module.exports = { openDatabase };
