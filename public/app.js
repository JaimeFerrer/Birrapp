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

function updateFab() {
  $('#add-bar-btn').hidden = !state.user || state.placing;
}

function setUser(user, token) {
  state.user = user;
  if (token !== undefined) {
    state.token = token;
    if (token) localStorage.setItem('birrapp_token', token);
    else localStorage.removeItem('birrapp_token');
  }
  $('#account-btn').textContent = user ? 'Mi cuenta' : 'Entrar';
  updateFab();
}

// Formulario de cuenta: entrar, crear cuenta, olvidé la contraseña o
// elegir una nueva (al abrir el enlace del correo).
const AUTH_MODES = {
  login: {
    title: 'Entrar',
    fields: `
      <label>Correo electrónico <input name="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label>Contraseña <input name="password" type="password" autocomplete="current-password" required></label>`,
    submit: 'Entrar',
    links: `
      <p><a href="#" class="link" data-mode="forgot">¿Has olvidado tu contraseña?</a></p>
      <p class="muted">¿No tienes cuenta? <a href="#" class="link" data-mode="register">Crear cuenta</a></p>`,
    async send(data) {
      return api('/auth/login', { method: 'POST', body: data });
    },
  },
  register: {
    title: 'Crear cuenta',
    fields: `
      <label>Correo electrónico <input name="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label>Nombre que verán los demás
        <input name="username" autocomplete="nickname" required minlength="3" maxlength="30" pattern="[\\w.\\-]+"
          title="Letras, números, punto, guion o guion bajo">
      </label>
      <label>Contraseña <input name="password" type="password" autocomplete="new-password" required minlength="6"></label>`,
    submit: 'Crear cuenta',
    links: '<p class="muted">¿Ya tienes cuenta? <a href="#" class="link" data-mode="login">Entrar</a></p>',
    async send(data) {
      return api('/auth/register', { method: 'POST', body: data });
    },
  },
  forgot: {
    title: 'Recuperar contraseña',
    intro: 'Te enviaremos un correo con un enlace para elegir una contraseña nueva.',
    fields: '<label>Correo electrónico <input name="email" type="email" autocomplete="email" inputmode="email" required></label>',
    submit: 'Enviar enlace',
    links: '<p class="muted"><a href="#" class="link" data-mode="login">Volver a entrar</a></p>',
    async send(data) {
      await api('/auth/forgot', { method: 'POST', body: data });
      return null;
    },
    done: 'Si hay una cuenta con ese correo, te hemos enviado un enlace. Mira también en la carpeta de spam.',
  },
  reset: {
    title: 'Nueva contraseña',
    fields: '<label>Nueva contraseña <input name="password" type="password" autocomplete="new-password" required minlength="6"></label>',
    submit: 'Guardar contraseña',
    links: '',
    async send(data, extra) {
      return api('/auth/reset', { method: 'POST', body: { ...data, token: extra.token } });
    },
  },
};

function showAuth(mode = 'login', extra = {}) {
  const config = AUTH_MODES[mode];
  const node = fragment(`
    <h2>${config.title}</h2>
    ${config.intro ? `<p class="muted">${config.intro}</p>` : ''}
    <form class="form">
      ${config.fields}
      <p class="error"></p>
      <button class="btn primary block">${config.submit}</button>
    </form>
    ${config.links}
  `);
  node.querySelectorAll('[data-mode]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    showAuth(a.dataset.mode);
  }));
  const form = $('form', node);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const result = await config.send(Object.fromEntries(new FormData(form)), extra);
      if (result) {
        setUser(result.user, result.token);
        closePanel();
      } else {
        form.replaceWith(fragment(`<p>${config.done}</p>`));
      }
    });
  });
  openPanel(node);
}

function showAccount() {
  const { user } = state;
  const node = fragment(`
    <h2>Mi cuenta</h2>
    <p class="account-name">${escapeHtml(user.username)}</p>

    <div class="section">
      <h3>Correo electrónico</h3>
      ${user.email ? `
        <div class="account-row" data-email-view>
          <span class="account-email">${escapeHtml(user.email)}</span>
          <button class="btn small" data-edit-email>Cambiar</button>
        </div>` : '<p class="error">Añade tu correo para poder recuperar la contraseña si la olvidas.</p>'}
      <form class="form" ${user.email ? 'hidden' : ''}>
        <label>
          <span class="sr-only">Correo electrónico</span>
          <input name="email" type="email" autocomplete="email" inputmode="email" required value="${escapeHtml(user.email || '')}">
        </label>
        <p class="error"></p>
        <button class="btn primary block">Guardar correo</button>
        ${user.email ? '<button type="button" class="btn block" data-cancel-email>Cancelar</button>' : ''}
      </form>
    </div>

    <div class="section">
      <h3 data-bars-title>Tus bares</h3>
      <div data-bars><p class="muted">Cargando…</p></div>
    </div>

    <div class="section">
      <button class="btn block" data-logout>Cerrar sesión</button>
    </div>
  `);

  const form = $('form', node);
  const emailView = $('[data-email-view]', node);
  $('[data-edit-email]', node)?.addEventListener('click', () => {
    emailView.hidden = true;
    form.hidden = false;
    $('input', form).focus();
  });
  $('[data-cancel-email]', node)?.addEventListener('click', () => {
    form.hidden = true;
    emailView.hidden = false;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { user: updated } = await api('/auth/me', { method: 'PATCH', body: Object.fromEntries(new FormData(form)) });
      setUser(updated);
      showAccount();
    });
  });

  $('[data-logout]', node).addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null, null);
    closePanel();
  });

  const barsBox = $('[data-bars]', node);
  const barsTitle = $('[data-bars-title]', node);
  openPanel(node);

  api('/auth/me/bars').then(({ bars }) => {
    barsTitle.textContent = `Tus bares (${bars.length})`;
    if (!bars.length) {
      barsBox.innerHTML = '<p class="muted">Todavía no has añadido ningún bar. Pulsa «Añadir bar» para poner el primero.</p>';
      return;
    }
    barsBox.replaceChildren(fragment(`<ul class="my-bars">${bars.map((bar) => `
      <li>
        <button class="my-bar" data-bar="${bar.id}">
          <span class="my-bar-name">${escapeHtml(bar.name)}</span>
          <span class="my-bar-price">${euros(bar.price)}</span>
          <span class="muted my-bar-tapa">${bar.has_tapa ? `Tapa: ${escapeHtml(bar.tapa_type || 'sí')}` : 'Sin tapa'}</span>
        </button>
      </li>`).join('')}</ul>`));
    barsBox.querySelectorAll('[data-bar]').forEach((btn) => btn.addEventListener('click', () => {
      const bar = bars.find((b) => b.id === Number(btn.dataset.bar));
      map.setView([bar.lat, bar.lng], 17);
      showBar(bar.id);
    }));
  }).catch((err) => {
    barsBox.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  });
}

$('#account-btn').addEventListener('click', () => (state.user ? showAccount() : showAuth('login')));

// ---------- Añadir bar ----------

function startPlacing() {
  closePanel();
  state.placing = true;
  updateFab();
  $('#placing-hint').hidden = false;
  map.getContainer().style.cursor = 'crosshair';
}

function stopPlacing() {
  state.placing = false;
  updateFab();
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
  updateFab();
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

// Permite instalar Birrapp como app en el móvil y en el ordenador.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(async function init() {
  // Enlace del correo para cambiar la contraseña: /?reset=<token>
  const resetToken = new URLSearchParams(location.search).get('reset');
  if (resetToken) {
    history.replaceState(null, '', location.pathname);
    showAuth('reset', { token: resetToken });
  }
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
