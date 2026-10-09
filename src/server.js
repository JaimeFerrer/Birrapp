const path = require('node:path');
const fs = require('node:fs');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

async function main() {
  // En producción se usa Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN);
  // en local, un fichero SQLite en data/.
  let url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    if (process.env.RENDER) {
      console.warn('⚠️  Falta TURSO_DATABASE_URL: los datos se perderán al reiniciar el servidor.');
    }
    const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'birrapp.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    url = `file:${file}`;
  }
  const db = await openDatabase(url, process.env.TURSO_AUTH_TOKEN);

  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => {
    console.log(`🍺 Birrapp escuchando en http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
