const path = require('node:path');
const fs = require('node:fs');
const { openDatabase } = require('./db');
const { createApp } = require('./app');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'birrapp.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const port = Number(process.env.PORT) || 3000;
createApp(openDatabase(dbFile)).listen(port, () => {
  console.log(`🍺 Birrapp escuchando en http://localhost:${port}`);
});
