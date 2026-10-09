'use strict';

const state = {
  token: localStorage.getItem('birrapp_token'),
  user: null,
  markers: new Map(),
  placing: false,
  draftMarker: null,
};

const $ = (sel, root = document) => root.querySelector(sel);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const euros = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
const date = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleDateString('es-ES');

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Algo ha fallado');
  return data;
}

// ---------- Mapa ----------

const map = L.map('map').setView([40.4168, -3.7038], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

map.locate({ setView: true, maxZoom: 15 });

function priceIcon(bar) {
  const cls = bar.has_tapa ? 'price-marker tapa' : 'price-marker';
  const tapa = bar.has_tapa ? ' 🍢' : '';
  return L.divIcon({
    className: 'marker-wrap',
    html: `<span class="${cls}">${euros(bar.price)}${tapa}</span>`,
    iconSize: [0, 0],
  });
}

function upsertMarker(bar) {
  const existing = state.markers.get(bar.id);
  if (existing) {
    existing.setIcon(priceIcon(bar));
    return existing;
  }
  const marker = L.marker([bar.lat, bar.lng], { icon: priceIcon(bar), title: bar.name })
    .addTo(map)
    .on('click', () => showBar(bar.id));
  state.markers.set(bar.id, marker);
  return marker;
}

async function loadBars() {
  const { bars } = await api('/bars');
  bars.forEach(upsertMarker);
}

// ---------- Panel ----------

const panel = $('#panel');
const panelBody = $('#panel-body');

function openPanel(content) {
  panelBody.replaceChildren(content);
  panel.hidden = false;
}

function closePanel() {
  panel.hidden = true;
  panelBody.replaceChildren();
  stopPlacing();
}

$('#panel-close').addEventListener('click', closePanel);

function fragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

// Campos de precio + tapa reutilizados al crear bar y al actualizar precio.
function reportFields() {
  const fields = $('#report-fields-template').content.cloneNode(true);
  const tapaType = $('[data-tapa-type]', fields);
  fields.querySelectorAll('input[name="has_tapa"]').forEach((radio) => {
    radio.addEventListener('change', () => { tapaType.hidden = radio.value !== 'yes'; });
  });
  return fields;
}

function readReport(form) {
  const data = new FormData(form);
  const hasTapa = data.get('has_tapa') === 'yes';
  return {
    price: Number(data.get('price')),
    has_tapa: hasTapa,
    tapa_type: hasTapa ? data.get('tapa_type') : '',
  };
}

async function submitting(form, fn) {
  const button = $('button[type="submit"], button:not([type])', form);
  const error = $('.error', form);
  error.textContent = '';
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- Usuarios ----------

function setUser(user, token) {
  state.user = user;
  if (token !== undefined) {
    state.token = token;
    if (token) localStorage.setItem('birrapp_token', token);
    else localStorage.removeItem('birrapp_token');
  }
  const logged = Boolean(user);
  $('#login-btn').hidden = logged;
  $('#logout-btn').hidden = !logged;
  $('#add-bar-btn').hidden = !logged;
  $('#user-name').hidden = !logged;
  $('#user-name').textContent = logged ? `🙋 ${user.username}` : '';
}

function showAuth(mode = 'login') {
  const node = $('#auth-template').content.cloneNode(true);
  const isLogin = mode === 'login';
  $('[data-title]', node).textContent = isLogin ? 'Entrar' : 'Crear usuario';
  $('[data-submit]', node).textContent = isLogin ? 'Entrar' : 'Crear cuenta';
  $('[data-switch-text]', node).textContent = isLogin ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?';
  $('[data-switch]', node).textContent = isLogin ? 'Crear usuario' : 'Entrar';
  $('input[name="password"]', node).autocomplete = isLogin ? 'current-password' : 'new-password';
  $('[data-switch]', node).addEventListener('click', (e) => {
    e.preventDefault();
    showAuth(isLogin ? 'register' : 'login');
  });
  const form = $('[data-form]', node);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      const { user, token } = await api(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body: data });
      setUser(user, token);
      closePanel();
    });
  });
  openPanel(node);
}

$('#login-btn').addEventListener('click', () => showAuth('login'));
$('#logout-btn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  setUser(null, null);
  closePanel();
});

// ---------- Añadir bar ----------

function startPlacing() {
  closePanel();
  state.placing = true;
  $('#placing-hint').hidden = false;
  map.getContainer().style.cursor = 'crosshair';
}

function stopPlacing() {
  state.placing = false;
  $('#placing-hint').hidden = true;
  map.getContainer().style.cursor = '';
  if (state.draftMarker) {
    state.draftMarker.remove();
    state.draftMarker = null;
  }
}

function placeDraft(latlng) {
  if (state.draftMarker) {
    state.draftMarker.setLatLng(latlng);
  } else {
    state.draftMarker = L.marker(latlng, { draggable: true }).addTo(map);
  }
  $('#placing-hint').hidden = true;
  state.placing = false;
  map.getContainer().style.cursor = '';
  if (panel.hidden) showAddBarForm();
}

map.on('click', (e) => { if (state.placing) placeDraft(e.latlng); });

$('#add-bar-btn').addEventListener('click', startPlacing);
$('#cancel-place-btn').addEventListener('click', stopPlacing);
$('#locate-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Tu navegador no permite obtener la ubicación');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const latlng = L.latLng(coords.latitude, coords.longitude);
      map.setView(latlng, 17);
      placeDraft(latlng);
    },
    () => alert('No se ha podido obtener tu ubicación'),
  );
});

function showAddBarForm() {
  const node = fragment(`
    <h2>Nuevo bar</h2>
    <p class="muted">Puedes arrastrar el marcador para ajustar la ubicación.</p>
    <form class="form">
      <label>Nombre del bar <input name="name" required maxlength="100"></label>
      <label>Dirección (opcional) <input name="address" maxlength="200"></label>
      <div data-report></div>
      <p class="error"></p>
      <button class="btn primary">Guardar bar</button>
    </form>
  `);
  $('[data-report]', node).replaceWith(reportFields());
  const form = $('form', node);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { lat, lng } = state.draftMarker.getLatLng();
      const data = new FormData(form);
      const { bar } = await api('/bars', {
        method: 'POST',
        body: { name: data.get('name'), address: data.get('address'), lat, lng, ...readReport(form) },
      });
      stopPlacing();
      upsertMarker(bar);
      showBar(bar.id);
    });
  });
  openPanel(node);
  $('input[name="name"]', panelBody).focus();
}

// ---------- Detalle de bar ----------

async function showBar(id) {
  stopPlacing();
  const { bar, reports } = await api(`/bars/${id}`);
  upsertMarker(bar);

  const tapa = bar.has_tapa
    ? `<span class="badge yes">🍢 Tapa: ${escapeHtml(bar.tapa_type || 'sí')}</span>`
    : '<span class="badge">Sin tapa</span>';

  const history = reports.map((r) => `
    <li>
      <strong>${euros(r.price)}</strong> · ${r.has_tapa ? `tapa: ${escapeHtml(r.tapa_type || 'sí')}` : 'sin tapa'}
      <br><span class="muted">${escapeHtml(r.username)} · ${date(r.created_at)}</span>
    </li>`).join('');

  const node = fragment(`
    <h2>${escapeHtml(bar.name)}</h2>
    ${bar.address ? `<p class="muted">${escapeHtml(bar.address)}</p>` : ''}
    <div class="price-big">${euros(bar.price)}</div>
    <p class="muted">
      Último precio el ${date(bar.price_updated_at)} ·
      media ${euros(bar.avg_price)} (${bar.report_count} ${bar.report_count === 1 ? 'opinión' : 'opiniones'})
    </p>
    ${tapa}
    <div class="section" data-update></div>
    <div class="section">
      <h3>Historial</h3>
      <ul class="history">${history}</ul>
      <p class="muted">Añadido por ${escapeHtml(bar.created_by)}</p>
    </div>
  `);

  const update = $('[data-update]', node);
  if (state.user) {
    update.append(fragment(`
      <h3>¿Has estado? Actualiza el precio</h3>
      <form class="form">
        <div data-report></div>
        <p class="error"></p>
        <button class="btn primary">Actualizar</button>
      </form>
    `));
    $('[data-report]', update).replaceWith(reportFields());
    const form = $('form', update);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(form, async () => {
        await api(`/bars/${id}/reports`, { method: 'POST', body: readReport(form) });
        await showBar(id);
      });
    });
  } else {
    update.append(fragment('<p class="muted"><a href="#" data-login>Entra</a> para actualizar el precio.</p>'));
    $('[data-login]', update).addEventListener('click', (e) => { e.preventDefault(); showAuth('login'); });
  }

  openPanel(node);
}

// ---------- Arranque ----------

(async function init() {
  if (state.token) {
    try {
      const { user } = await api('/auth/me');
      setUser(user);
    } catch {
      setUser(null, null);
    }
  }
  await loadBars();
})();
