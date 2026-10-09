const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;
const sentMail = [];

before(async () => {
  server = createApp(await openDatabase(':memory:'), { sendMail: async (m) => sentMail.push(m), appUrl: 'https://birrapp.test' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const register = (username, email = `${username}@example.com`) =>
  call('/auth/register', { method: 'POST', body: { username, email, password: 'secreto123' } });

test('registro y login con correo', async () => {
  const reg = await register('pepe', 'Pepe@Example.com');
  assert.equal(reg.status, 201);
  assert.deepEqual(reg.body.user, { id: reg.body.user.id, username: 'pepe', email: 'pepe@example.com' });

  assert.equal((await register('pepe2', 'pepe@example.com')).status, 409);
  assert.equal((await register('pepe', 'otro@example.com')).status, 409);
  assert.equal((await register('sincorreo', 'no-es-un-correo')).status, 400);

  const bad = await call('/auth/login', { method: 'POST', body: { email: 'pepe@example.com', password: 'mal' } });
  assert.equal(bad.status, 401);

  const login = await call('/auth/login', { method: 'POST', body: { email: 'PEPE@example.com ', password: 'secreto123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.username, 'pepe');

  const me = await call('/auth/me', { token: login.body.token });
  assert.equal(me.body.user.email, 'pepe@example.com');

  assert.equal((await call('/auth/logout', { method: 'POST', token: login.body.token })).status, 204);
  assert.equal((await call('/auth/me', { token: login.body.token })).status, 401);
});

test('cambiar el correo de la cuenta', async () => {
  const { token } = (await register('marta')).body;
  await register('otra');
  const taken = await call('/auth/me', { method: 'PATCH', token, body: { email: 'otra@example.com' } });
  assert.equal(taken.status, 409);
  const changed = await call('/auth/me', { method: 'PATCH', token, body: { email: 'marta.nueva@example.com' } });
  assert.equal(changed.body.user.email, 'marta.nueva@example.com');
  const login = await call('/auth/login', { method: 'POST', body: { email: 'marta.nueva@example.com', password: 'secreto123' } });
  assert.equal(login.status, 200);
});

test('recuperar la contraseña por correo', async () => {
  const { token: oldSession } = (await register('olvidona')).body;

  const unknown = await call('/auth/forgot', { method: 'POST', body: { email: 'nadie@example.com' } });
  assert.equal(unknown.status, 200);
  assert.equal(sentMail.length, 0);

  const forgot = await call('/auth/forgot', { method: 'POST', body: { email: 'olvidona@example.com' } });
  assert.equal(forgot.status, 200);
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'olvidona@example.com');
  const link = sentMail[0].text.match(/https:\/\/birrapp\.test\/\?reset=(\w+)/);
  assert.ok(link, 'el correo incluye el enlace');

  // Pedirlo otra vez enseguida no manda otro correo.
  await call('/auth/forgot', { method: 'POST', body: { email: 'olvidona@example.com' } });
  assert.equal(sentMail.length, 1);

  const wrong = await call('/auth/reset', { method: 'POST', body: { token: 'inventado', password: 'nueva123' } });
  assert.equal(wrong.status, 400);

  const reset = await call('/auth/reset', { method: 'POST', body: { token: link[1], password: 'nueva123' } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.user.username, 'olvidona');

  // La sesión antigua se cierra, el enlace no sirve dos veces y vale la nueva contraseña.
  assert.equal((await call('/auth/me', { token: oldSession })).status, 401);
  const again = await call('/auth/reset', { method: 'POST', body: { token: link[1], password: 'otra1234' } });
  assert.equal(again.status, 400);
  const login = await call('/auth/login', { method: 'POST', body: { email: 'olvidona@example.com', password: 'nueva123' } });
  assert.equal(login.status, 200);
});

test('añadir bar y actualizar precio', async () => {
  const ana = (await register('ana')).body.token;
  const luis = (await register('luis')).body.token;

  const anon = await call('/bars', { method: 'POST', body: { name: 'X', lat: 1, lng: 1, price: 2, has_tapa: false } });
  assert.equal(anon.status, 401);

  const invalid = await call('/bars', {
    method: 'POST', token: ana, body: { name: 'X', lat: 200, lng: 1, price: 2, has_tapa: false },
  });
  assert.equal(invalid.status, 400);

  const created = await call('/bars', {
    method: 'POST',
    token: ana,
    body: { name: 'Bar Manolo', address: 'C/ Mayor 1', lat: 40.41, lng: -3.70, price: 2.5, has_tapa: true, tapa_type: 'Bravas' },
  });
  assert.equal(created.status, 201);
  const bar = created.body.bar;
  assert.equal(bar.price, 2.5);
  assert.equal(bar.has_tapa, true);
  assert.equal(bar.tapa_type, 'Bravas');
  assert.equal(bar.created_by, 'ana');

  const updated = await call(`/bars/${bar.id}/reports`, {
    method: 'POST', token: luis, body: { price: 3, has_tapa: false, tapa_type: 'ignorada' },
  });
  assert.equal(updated.status, 201);
  assert.equal(updated.body.bar.price, 3);
  assert.equal(updated.body.bar.has_tapa, false);
  assert.equal(updated.body.bar.tapa_type, null);
  assert.equal(updated.body.bar.avg_price, 2.75);
  assert.equal(updated.body.bar.report_count, 2);

  const detail = await call(`/bars/${bar.id}`);
  assert.deepEqual(detail.body.reports.map((r) => r.username), ['luis', 'ana']);

  const mine = await call('/auth/me/bars', { token: ana });
  assert.deepEqual(mine.body.bars.map((b) => b.name), ['Bar Manolo']);
  assert.equal((await call('/auth/me/bars', { token: luis })).body.bars.length, 0);
  assert.equal((await call('/auth/me/bars')).status, 401);

  const exported = await call('/export');
  assert.deepEqual(exported.body.bars.map((b) => [b.name, b.created_by]), [['Bar Manolo', 'ana']]);
  assert.deepEqual(exported.body.reports.map((r) => [r.username, r.price, r.has_tapa]), [['ana', 2.5, true], ['luis', 3, false]]);

  const list = await call('/bars');
  assert.equal(list.body.bars.length, 1);
  assert.equal(list.body.bars[0].price, 3);

  assert.equal((await call('/bars/999')).status, 404);
  assert.equal((await call('/bars/999/reports', { method: 'POST', token: luis, body: { price: 1, has_tapa: false } })).status, 404);
});
