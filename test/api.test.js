const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  server = createApp(await openDatabase(':memory:')).listen(0);
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

const register = (username) =>
  call('/auth/register', { method: 'POST', body: { username, password: 'secreto123' } });

test('registro, login y sesión', async () => {
  const reg = await register('pepe');
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.username, 'pepe');

  assert.equal((await register('pepe')).status, 409);

  const bad = await call('/auth/login', { method: 'POST', body: { username: 'pepe', password: 'mal' } });
  assert.equal(bad.status, 401);

  const login = await call('/auth/login', { method: 'POST', body: { username: 'pepe', password: 'secreto123' } });
  assert.equal(login.status, 200);

  const me = await call('/auth/me', { token: login.body.token });
  assert.equal(me.body.user.username, 'pepe');

  assert.equal((await call('/auth/logout', { method: 'POST', token: login.body.token })).status, 204);
  assert.equal((await call('/auth/me', { token: login.body.token })).status, 401);
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

  const list = await call('/bars');
  assert.equal(list.body.bars.length, 1);
  assert.equal(list.body.bars[0].price, 3);

  assert.equal((await call('/bars/999')).status, 404);
  assert.equal((await call('/bars/999/reports', { method: 'POST', token: luis, body: { price: 1, has_tapa: false } })).status, 404);
});
