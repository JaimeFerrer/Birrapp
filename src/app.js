const path = require('node:path');
const express = require('express');
const { hashPassword, verifyPassword, newToken } = require('./auth');

const BAR_SUMMARY_SQL = `
  SELECT b.id, b.name, b.address, b.lat, b.lng, b.created_at,
         u.username AS created_by,
         r.price AS price, r.has_tapa AS has_tapa, r.tapa_type AS tapa_type,
         r.created_at AS price_updated_at,
         (SELECT ROUND(AVG(price), 2) FROM reports WHERE bar_id = b.id) AS avg_price,
         (SELECT COUNT(*) FROM reports WHERE bar_id = b.id) AS report_count
  FROM bars b
  JOIN users u ON u.id = b.created_by
  LEFT JOIN reports r ON r.id = (SELECT MAX(id) FROM reports WHERE bar_id = b.id)
`;

function formatBar(row) {
  return { ...row, has_tapa: row.has_tapa === 1 };
}

// Valida precio y tapa; devuelve { error } o { price, hasTapa, tapaType }.
function parseReport(body) {
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0 || price > 100) {
    return { error: 'El precio debe ser un número entre 0 y 100' };
  }
  if (typeof body.has_tapa !== 'boolean') {
    return { error: 'Indica si ponen tapa (has_tapa: true/false)' };
  }
  const tapaType = body.has_tapa ? String(body.tapa_type ?? '').trim() : '';
  if (tapaType.length > 100) {
    return { error: 'El tipo de tapa es demasiado largo' };
  }
  return { price: Math.round(price * 100) / 100, hasTapa: body.has_tapa, tapaType: tapaType || null };
}

// Express 4 no captura errores de handlers async por sí solo.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));

  app.use(wrap(async (req, _res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    req.token = token;
    req.user = token
      ? await db.get(
        'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
        [token]
      )
      : null;
    next();
  }));

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Tienes que iniciar sesión' });
    next();
  }

  async function startSession(userId) {
    const token = newToken();
    await db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, userId]);
    return token;
  }

  async function barSummary(id) {
    const bar = await db.get(`${BAR_SUMMARY_SQL} WHERE b.id = ?`, [id]);
    return bar && formatBar(bar);
  }

  // --- Usuarios ---

  app.post('/api/auth/register', wrap(async (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!/^[\w.-]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'El usuario debe tener 3-30 caracteres (letras, números, . _ -)' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    if (await db.get('SELECT 1 FROM users WHERE username = ?', [username])) {
      return res.status(409).json({ error: 'Ese usuario ya existe' });
    }
    const { lastInsertRowid: id } = await db.run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, hashPassword(password)]
    );
    res.status(201).json({ token: await startSession(id), user: { id, username } });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    const user = await db.get('SELECT id, username, password_hash FROM users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    res.json({ token: await startSession(user.id), user: { id: user.id, username: user.username } });
  }));

  app.post('/api/auth/logout', requireAuth, wrap(async (req, res) => {
    await db.run('DELETE FROM sessions WHERE token = ?', [req.token]);
    res.status(204).end();
  }));

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // --- Bares ---

  app.get('/api/bars', wrap(async (_req, res) => {
    const rows = await db.all(`${BAR_SUMMARY_SQL} ORDER BY b.id`);
    res.json({ bars: rows.map(formatBar) });
  }));

  app.get('/api/bars/:id', wrap(async (req, res) => {
    const bar = await barSummary(Number(req.params.id));
    if (!bar) return res.status(404).json({ error: 'Bar no encontrado' });
    const reports = await db.all(
      `SELECT r.id, r.price, r.has_tapa, r.tapa_type, r.created_at, u.username
       FROM reports r JOIN users u ON u.id = r.user_id
       WHERE r.bar_id = ? ORDER BY r.id DESC LIMIT 50`,
      [bar.id]
    );
    res.json({ bar, reports: reports.map(formatBar) });
  }));

  app.post('/api/bars', requireAuth, wrap(async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const address = String(req.body.address ?? '').trim() || null;
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (!name || name.length > 100) {
      return res.status(400).json({ error: 'El nombre del bar es obligatorio (máx. 100 caracteres)' });
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Ubicación no válida' });
    }
    const report = parseReport(req.body);
    if (report.error) return res.status(400).json({ error: report.error });

    const [{ lastInsertRowid: barId }] = await db.batch([
      ['INSERT INTO bars (name, address, lat, lng, created_by) VALUES (?, ?, ?, ?, ?)',
        [name, address, lat, lng, req.user.id]],
      ['INSERT INTO reports (bar_id, user_id, price, has_tapa, tapa_type) VALUES (last_insert_rowid(), ?, ?, ?, ?)',
        [req.user.id, report.price, report.hasTapa ? 1 : 0, report.tapaType]],
    ]);
    res.status(201).json({ bar: await barSummary(barId) });
  }));

  // Un usuario que ha probado el bar actualiza el precio / la tapa.
  app.post('/api/bars/:id/reports', requireAuth, wrap(async (req, res) => {
    const barId = Number(req.params.id);
    if (!(await db.get('SELECT 1 FROM bars WHERE id = ?', [barId]))) {
      return res.status(404).json({ error: 'Bar no encontrado' });
    }
    const report = parseReport(req.body);
    if (report.error) return res.status(400).json({ error: report.error });
    await db.run(
      'INSERT INTO reports (bar_id, user_id, price, has_tapa, tapa_type) VALUES (?, ?, ?, ?, ?)',
      [barId, req.user.id, report.price, report.hasTapa ? 1 : 0, report.tapaType]
    );
    res.status(201).json({ bar: await barSummary(barId) });
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));

  return app;
}

module.exports = { createApp };
