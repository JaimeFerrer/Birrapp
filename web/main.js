import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import './styles.css';
import {
  configured, watchUser, register, login, logout, sendPasswordReset, changeEmail,
  watchBars, getBar, getMyBars, addBar, addReport,
} from './firebase.js';

// Con Vite las imágenes del marcador por defecto de Leaflet hay que indicarlas a mano.
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

const state = {
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
const date = (ts) => (ts ? ts.toDate().toLocaleDateString('es-ES') : '');

// ---------- Mapa ----------

const map = L.map('map').setView([40.4168, -3.7038], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

map.locate({ setView: true, maxZoom: 15 });

function priceIcon(bar) {
  const cls = bar.hasTapa ? 'price-marker tapa' : 'price-marker';
  const tapa = bar.hasTapa ? ' 🍢' : '';
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
    hasTapa,
    tapaType: hasTapa ? data.get('tapa_type') : '',
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

function setUser(user) {
  state.user = user;
  $('#account-btn').textContent = user ? 'Mi cuenta' : 'Entrar';
  updateFab();
}

// Formulario de cuenta: entrar, crear cuenta u olvidé la contraseña.
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
    send: login,
  },
  register: {
    title: 'Crear cuenta',
    fields: `
      <label>Correo electrónico <input name="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label>Nombre que verán los demás
        <input name="username" autocomplete="nickname" required minlength="3" maxlength="30" pattern="[A-Za-z0-9_.\\-]+"
          title="Letras, números, punto, guion o guion bajo">
      </label>
      <label>Contraseña <input name="password" type="password" autocomplete="new-password" required minlength="6"></label>`,
    submit: 'Crear cuenta',
    links: '<p class="muted">¿Ya tienes cuenta? <a href="#" class="link" data-mode="login">Entrar</a></p>',
    send: register,
  },
  forgot: {
    title: 'Recuperar contraseña',
    intro: 'Te enviaremos un correo con un enlace para elegir una contraseña nueva.',
    fields: '<label>Correo electrónico <input name="email" type="email" autocomplete="email" inputmode="email" required></label>',
    submit: 'Enviar enlace',
    links: '<p class="muted"><a href="#" class="link" data-mode="login">Volver a entrar</a></p>',
    async send({ email }) {
      await sendPasswordReset(email);
      return null;
    },
    done: 'Si hay una cuenta con ese correo, te hemos enviado un enlace. Mira también en la carpeta de spam.',
  },
};

function showAuth(mode = 'login') {
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
      const user = await config.send(Object.fromEntries(new FormData(form)));
      if (user) {
        setUser(user);
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
      <div class="account-row" data-email-view>
        <span class="account-email">${escapeHtml(user.email)}</span>
        <button class="btn small" data-edit-email>Cambiar</button>
      </div>
      <form class="form" hidden>
        <label>Correo nuevo
          <input name="email" type="email" autocomplete="email" inputmode="email" required>
        </label>
        <label>Tu contraseña actual
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <p class="error"></p>
        <button class="btn primary block">Cambiar correo</button>
        <button type="button" class="btn block" data-cancel-email>Cancelar</button>
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
  $('[data-edit-email]', node).addEventListener('click', () => {
    emailView.hidden = true;
    form.hidden = false;
    $('input', form).focus();
  });
  $('[data-cancel-email]', node).addEventListener('click', () => {
    form.hidden = true;
    emailView.hidden = false;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const data = Object.fromEntries(new FormData(form));
      await changeEmail(data);
      form.replaceWith(fragment(`<p>Te hemos enviado un correo a <strong>${escapeHtml(data.email)}</strong>.
        El cambio se hará cuando pulses el enlace de ese correo.</p>`));
    });
  });

  $('[data-logout]', node).addEventListener('click', async () => {
    await logout();
    closePanel();
  });

  const barsBox = $('[data-bars]', node);
  const barsTitle = $('[data-bars-title]', node);
  openPanel(node);

  getMyBars(user.uid).then((bars) => {
    barsTitle.textContent = `Tus bares (${bars.length})`;
    if (!bars.length) {
      barsBox.innerHTML = '<p class="muted">Todavía no has añadido ningún bar. Pulsa «Añadir bar» para poner el primero.</p>';
      return;
    }
    barsBox.replaceChildren(fragment(`<ul class="my-bars">${bars.map((bar) => `
      <li>
        <button class="my-bar" data-bar="${escapeHtml(bar.id)}">
          <span class="my-bar-name">${escapeHtml(bar.name)}</span>
          <span class="my-bar-price">${euros(bar.price)}</span>
          <span class="muted my-bar-tapa">${bar.hasTapa ? `Tapa: ${escapeHtml(bar.tapaType || 'sí')}` : 'Sin tapa'}</span>
        </button>
      </li>`).join('')}</ul>`));
    barsBox.querySelectorAll('[data-bar]').forEach((btn) => btn.addEventListener('click', () => {
      const bar = bars.find((b) => b.id === btn.dataset.bar);
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
  const hint = $('#placing-hint span');
  if (!navigator.geolocation) {
    hint.textContent = 'Tu navegador no permite obtener la ubicación. Toca el mapa donde está el bar.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const latlng = L.latLng(coords.latitude, coords.longitude);
      map.setView(latlng, 17);
      placeDraft(latlng);
    },
    () => { hint.textContent = 'No se ha podido obtener tu ubicación. Toca el mapa donde está el bar.'; },
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
      const id = await addBar(state.user, {
        name: data.get('name'), address: data.get('address'), lat, lng, ...readReport(form),
      });
      stopPlacing();
      showBar(id);
    });
  });
  openPanel(node);
  $('input[name="name"]', panelBody).focus();
}

// ---------- Detalle de bar ----------

async function showBar(id) {
  stopPlacing();
  let result;
  try {
    result = await getBar(id);
  } catch (err) {
    openPanel(fragment(`<p class="error">${escapeHtml(err.message)}</p>`));
    return;
  }
  if (!result) return;
  const { bar, reports } = result;
  upsertMarker(bar);

  const tapa = bar.hasTapa
    ? `<span class="badge yes">🍢 Tapa: ${escapeHtml(bar.tapaType || 'sí')}</span>`
    : '<span class="badge">Sin tapa</span>';

  const history = reports.map((r) => `
    <li>
      <strong>${euros(r.price)}</strong> · ${r.hasTapa ? `tapa: ${escapeHtml(r.tapaType || 'sí')}` : 'sin tapa'}
      <br><span class="muted">${escapeHtml(r.username)} · ${date(r.createdAt)}</span>
    </li>`).join('');

  const node = fragment(`
    <h2>${escapeHtml(bar.name)}</h2>
    ${bar.address ? `<p class="muted">${escapeHtml(bar.address)}</p>` : ''}
    <div class="price-big">${euros(bar.price)}</div>
    <p class="muted">
      Último precio el ${date(bar.priceUpdatedAt)} ·
      media ${euros(bar.priceSum / bar.reportCount)} (${bar.reportCount} ${bar.reportCount === 1 ? 'opinión' : 'opiniones'})
    </p>
    ${tapa}
    <div class="section" data-update></div>
    <div class="section">
      <h3>Historial</h3>
      <ul class="history">${history}</ul>
      <p class="muted">Añadido por ${escapeHtml(bar.createdByName)}</p>
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
        await addReport(state.user, id, readReport(form));
        await showBar(id);
      });
    });
  } else {
    update.append(fragment('<p class="muted"><a href="#" class="link" data-login>Entra</a> para actualizar el precio.</p>'));
    $('[data-login]', update).addEventListener('click', (e) => { e.preventDefault(); showAuth('login'); });
  }

  openPanel(node);
}

// ---------- Arranque ----------

// Permite instalar Birrapp como app en el móvil y en el ordenador.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

if (!configured) {
  openPanel(fragment(`<h2>Falta configurar Firebase</h2>
    <p class="muted">Rellena <code>web/firebase-config.js</code> con los datos de tu proyecto de Firebase.</p>`));
} else {
  watchUser(setUser);
  // Los bares se actualizan solos cuando alguien añade uno o cambia un precio.
  watchBars((bars) => bars.forEach(upsertMarker), (err) => console.error(err));
}
