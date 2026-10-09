import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import './styles.css';
import {
  configured, watchUser, register, login, logout, sendPasswordReset, changeUsername, currentUsernames,
  watchBars, getBar, getMyBars, addBar, addReport, addPhotos, compressPhoto, getPhotos,
  deleteBar, deleteReport, deletePhoto,
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

// ---------- Tu ubicación ----------

// Punto azul que te sigue mientras la app está abierta, con un círculo que
// indica la precisión del GPS.
const me = { latlng: null, marker: null, circle: null, centered: false, asked: false };
// Capa propia por debajo de los marcadores de bares, para que el punto azul
// nunca tape un precio ni impida tocarlo.
map.createPane('me').style.zIndex = 550;
const meIcon = L.divIcon({ className: 'me-marker', html: '<span class="me-dot"></span>', iconSize: [22, 22], iconAnchor: [11, 11] });

const LocateControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const button = L.DomUtil.create('button', 'locate-control');
    button.type = 'button';
    button.title = 'Ir a mi ubicación';
    button.setAttribute('aria-label', 'Ir a mi ubicación');
    button.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;
    L.DomEvent.disableClickPropagation(button);
    L.DomEvent.on(button, 'click', () => {
      if (me.latlng) {
        map.setView(me.latlng, Math.max(map.getZoom(), 16));
      } else {
        me.asked = true;
        button.classList.add('waiting');
        startLocating();
      }
    });
    return button;
  },
});
const locateControl = new LocateControl().addTo(map);

function startLocating() {
  map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 10000 });
}

map.on('locationfound', (e) => {
  me.latlng = e.latlng;
  if (me.marker) {
    me.marker.setLatLng(e.latlng);
    me.circle.setLatLng(e.latlng).setRadius(e.accuracy);
  } else {
    me.circle = L.circle(e.latlng, {
      radius: e.accuracy, interactive: false, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, pane: 'me',
    }).addTo(map);
    me.marker = L.marker(e.latlng, { icon: meIcon, interactive: false, keyboard: false, pane: 'me' }).addTo(map);
  }
  locateControl.getContainer().classList.remove('waiting');
  if (!me.centered || me.asked) {
    map.setView(e.latlng, Math.max(map.getZoom(), me.asked ? 16 : 15));
    me.centered = true;
    me.asked = false;
  }
});

map.on('locationerror', () => {
  locateControl.getContainer().classList.remove('waiting');
  if (me.asked) {
    toast('No se ha podido obtener tu ubicación. Revisa que el navegador tenga permiso.');
    me.asked = false;
  }
});

startLocating();

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
// Si ponen tapa, es obligatorio valorarla con estrellas.
function reportFields() {
  const fields = $('#report-fields-template').content.cloneNode(true);
  const tapaDetails = $('[data-tapa-type]', fields);
  const stars = [...fields.querySelectorAll('input[name="tapa_rating"]')];
  fields.querySelectorAll('input[name="has_tapa"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      tapaDetails.hidden = radio.value !== 'yes';
      stars.forEach((star) => { star.required = !tapaDetails.hidden; });
    });
  });
  const paint = () => {
    const value = Number(stars.find((s) => s.checked)?.value ?? 0);
    stars.forEach((star) => star.parentElement.classList.toggle('on', Number(star.value) <= value));
  };
  stars.forEach((star) => star.addEventListener('change', paint));
  return fields;
}

function readReport(form) {
  const data = new FormData(form);
  const hasTapa = data.get('has_tapa') === 'yes';
  return {
    price: Number(data.get('price')),
    hasTapa,
    tapaType: hasTapa ? data.get('tapa_type') : '',
    tapaRating: hasTapa ? Number(data.get('tapa_rating')) : null,
  };
}

// «★★★★☆» para una nota de 1 a 5 (redondeada).
const starsText = (rating) => '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
const decimal = (n) => n.toFixed(1).replace('.', ',');

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

// Aviso breve abajo de la pantalla (errores al borrar, etc.).
function toast(message) {
  const el = fragment(`<div class="toast" role="status">${escapeHtml(message)}</div>`).firstElementChild;
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

// Botón de borrar en dos toques: el primero pide confirmación y el segundo
// borra. Si no se confirma en unos segundos, vuelve a su estado normal.
function deleteButton(label, confirmLabel, action) {
  const button = fragment(`<button type="button" class="btn small danger">${label}</button>`).firstElementChild;
  let timer = null;
  button.addEventListener('click', async () => {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = confirmLabel;
      timer = setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = label;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    button.textContent = 'Borrando…';
    try {
      await action();
    } catch (err) {
      toast(err.message);
      button.disabled = false;
      button.classList.remove('armed');
      button.textContent = label;
    }
  });
  return button;
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

    <div class="section">
      <h3>Nombre de usuario</h3>
      <div class="account-row" data-name-view>
        <span class="account-name">${escapeHtml(user.username)}</span>
        <button class="btn small" data-edit-name>Cambiar</button>
      </div>
      <form class="form" hidden>
        <label>
          <span class="sr-only">Nombre nuevo</span>
          <input name="username" autocomplete="nickname" required minlength="3" maxlength="30"
            pattern="[A-Za-z0-9_.\\-]+" title="Letras, números, punto, guion o guion bajo" value="${escapeHtml(user.username)}">
        </label>
        <p class="error"></p>
        <button class="btn primary block">Guardar nombre</button>
        <button type="button" class="btn block" data-cancel-name>Cancelar</button>
      </form>
    </div>

    <div class="section">
      <h3>Correo electrónico</h3>
      <p class="account-email">${escapeHtml(user.email)}</p>
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
  const nameView = $('[data-name-view]', node);
  $('[data-edit-name]', node).addEventListener('click', () => {
    nameView.hidden = true;
    form.hidden = false;
    $('input', form).select();
  });
  $('[data-cancel-name]', node).addEventListener('click', () => {
    form.hidden = true;
    nameView.hidden = false;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const username = new FormData(form).get('username');
      await changeUsername(state.user, username);
      setUser({ ...state.user, username: username.trim() });
      showAccount();
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
          <span class="muted my-bar-tapa">${bar.hasTapa ? `Tapa: ${escapeHtml(bar.tapaType || 'sí')}` : 'Sin tapa'}${bar.ratingCount ? ` · ★ ${decimal(bar.ratingSum / bar.ratingCount)}` : ''}</span>
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
  if (me.latlng) {
    map.setView(me.latlng, 17);
    placeDraft(me.latlng);
    return;
  }
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

const PHOTO_KINDS = { beer: 'Cerveza', tapa: 'Tapa' };

// Botones para elegir (o hacer) la foto de la cerveza y de la tapa. Cada foto se
// comprime en cuanto se elige; `getPhotos()` espera a que estén listas.
// Con `linkTapa`, el hueco de la tapa solo aparece si en el formulario se marca
// que ponen tapa.
function photoPickers(form, { linkTapa = true, legend = 'Fotos (opcional)' } = {}) {
  const node = fragment(`
    <fieldset class="photos">
      ${legend ? `<legend>${legend}</legend>` : ''}
      <div class="photo-pickers">
        ${Object.entries(PHOTO_KINDS).map(([kind, label]) => `
          <div class="photo-picker" data-kind="${kind}" ${linkTapa && kind === 'tapa' ? 'hidden' : ''}>
            <label class="photo-slot">
              <input type="file" accept="image/*" hidden>
              <span class="photo-placeholder">+ ${label}</span>
            </label>
            <button type="button" class="photo-remove" aria-label="Quitar foto de ${label.toLowerCase()}" hidden>×</button>
            <span class="photo-label muted">${label}</span>
          </div>`).join('')}
      </div>
    </fieldset>
  `);
  const pending = new Map();

  function clear(picker) {
    pending.delete(picker.dataset.kind);
    $('.photo-slot img', picker)?.remove();
    $('.photo-placeholder', picker).hidden = false;
    $('.photo-placeholder', picker).textContent = `+ ${PHOTO_KINDS[picker.dataset.kind]}`;
    $('.photo-remove', picker).hidden = true;
    $('input', picker).value = '';
  }

  node.querySelectorAll('.photo-picker').forEach((picker) => {
    const input = $('input', picker);
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      clear(picker);
      $('.photo-placeholder', picker).textContent = 'Preparando…';
      const job = compressPhoto(file);
      pending.set(picker.dataset.kind, job);
      job.then((data) => {
        if (pending.get(picker.dataset.kind) !== job) return;
        $('.photo-placeholder', picker).hidden = true;
        $('.photo-slot', picker).append(Object.assign(document.createElement('img'), { src: data, alt: '' }));
        $('.photo-remove', picker).hidden = false;
      }).catch((err) => {
        clear(picker);
        $('.error', form).textContent = err.message;
      });
    });
    $('.photo-remove', picker).addEventListener('click', () => clear(picker));
  });

  if (linkTapa) {
    const tapaPicker = $('[data-kind="tapa"]', node);
    form.querySelectorAll('input[name="has_tapa"]').forEach((radio) => radio.addEventListener('change', () => {
      tapaPicker.hidden = radio.value !== 'yes';
      if (tapaPicker.hidden) clear(tapaPicker);
    }));
  }

  return {
    node,
    async getPhotos() {
      const entries = [...pending.entries()];
      const data = await Promise.all(entries.map(([, job]) => job));
      return entries.map(([kind], i) => ({ kind, data: data[i] }));
    },
  };
}

function showAddBarForm() {
  const node = fragment(`
    <h2>Nuevo bar</h2>
    <p class="muted">Puedes arrastrar el marcador para ajustar la ubicación.</p>
    <form class="form">
      <label>Nombre del bar <input name="name" required maxlength="100"></label>
      <label>Dirección (opcional) <input name="address" maxlength="200"></label>
      <div data-report></div>
      <div data-photos></div>
      <p class="error"></p>
      <button class="btn primary">Guardar bar</button>
    </form>
  `);
  const form = $('form', node);
  $('[data-report]', node).replaceWith(reportFields());
  const pickers = photoPickers(form);
  $('[data-photos]', node).replaceWith(pickers.node);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { lat, lng } = state.draftMarker.getLatLng();
      const data = new FormData(form);
      const id = await addBar(state.user, {
        name: data.get('name'),
        address: data.get('address'),
        lat,
        lng,
        ...readReport(form),
        photos: await pickers.getPhotos(),
      });
      stopPlacing();
      showBar(id);
    });
  });
  openPanel(node);
  $('input[name="name"]', panelBody).focus();
}

// Foto a pantalla completa; se cierra tocando en cualquier sitio.
function showPhoto(src) {
  const viewer = fragment(`<div class="photo-viewer" role="dialog" aria-label="Foto"><img src="${src}" alt=""></div>`).firstElementChild;
  viewer.addEventListener('click', () => viewer.remove());
  document.body.append(viewer);
}

// Sección de fotos del bar: galería y, con sesión, botón para subir fotos sin
// tener que actualizar el precio.
async function loadBarPhotos(barId, box) {
  let photos;
  try {
    photos = await getPhotos(barId);
  } catch {
    return;
  }
  if (!photos.length && !state.user) return;
  const nameOf = await currentUsernames(photos.map((p) => p.userId));
  box.hidden = false;
  box.replaceChildren(fragment(`
    <div class="section-head">
      <h3>Fotos</h3>
      ${state.user ? '<button type="button" class="btn small" data-add-photos>Añadir fotos</button>' : ''}
    </div>
    ${photos.length ? `<div class="photo-gallery">${photos.map((p) => `
      <figure data-photo-id="${escapeHtml(p.id)}" data-own="${state.user?.uid === p.userId}">
        <button type="button" class="photo-thumb"><img src="${p.data}" alt="Foto de ${PHOTO_KINDS[p.kind]?.toLowerCase()}" loading="lazy"></button>
        <figcaption class="muted">${PHOTO_KINDS[p.kind] ?? ''} · ${escapeHtml(nameOf(p.userId, p.username))}</figcaption>
      </figure>`).join('')}</div>` : '<p class="muted">Todavía no hay fotos. ¡Sube la primera!</p>'}
    <form class="form" data-photo-form hidden>
      <div data-pickers></div>
      <p class="error"></p>
      <button class="btn primary block">Subir fotos</button>
      <button type="button" class="btn block" data-cancel-photos>Cancelar</button>
    </form>
  `));
  box.querySelectorAll('.photo-thumb img').forEach((img) => img.parentElement.addEventListener('click', () => showPhoto(img.src)));
  box.querySelectorAll('figure[data-own="true"]').forEach((figure) => {
    figure.append(deleteButton('Borrar', '¿Borrar?', async () => {
      await deletePhoto(barId, figure.dataset.photoId);
      await loadBarPhotos(barId, box);
    }));
  });

  const addButton = $('[data-add-photos]', box);
  if (!addButton) return;
  const form = $('[data-photo-form]', box);
  const pickers = photoPickers(form, { linkTapa: false, legend: '' });
  $('[data-pickers]', form).replaceWith(pickers.node);
  addButton.addEventListener('click', () => {
    form.hidden = false;
    addButton.hidden = true;
  });
  $('[data-cancel-photos]', form).addEventListener('click', () => loadBarPhotos(barId, box));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      await addPhotos(state.user, barId, await pickers.getPhotos());
      await loadBarPhotos(barId, box);
    });
  });
}

// ---------- Detalle de bar ----------

// Abre Google Maps (la app en el móvil) con la ruta andando hasta el bar.
const directionsUrl = (bar) => `https://www.google.com/maps/dir/?api=1&destination=${bar.lat.toFixed(6)},${bar.lng.toFixed(6)}&travelmode=walking`;

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
  const nameOf = await currentUsernames([bar.createdBy, ...reports.map((r) => r.userId)]);

  const tapa = bar.hasTapa
    ? `<span class="badge yes">🍢 Tapa: ${escapeHtml(bar.tapaType || 'sí')}</span>`
    : '<span class="badge">Sin tapa</span>';
  const rating = bar.ratingCount
    ? `<p class="rating"><span class="rating-stars" aria-hidden="true">${starsText(bar.ratingSum / bar.ratingCount)}</span>
        <strong>${decimal(bar.ratingSum / bar.ratingCount)}</strong>
        <span class="muted">tapa · ${bar.ratingCount} ${bar.ratingCount === 1 ? 'valoración' : 'valoraciones'}</span></p>`
    : '';

  const history = reports.map((r) => `
    <li data-report-id="${escapeHtml(r.id)}" data-own="${state.user?.uid === r.userId}">
      <div>
        <strong>${euros(r.price)}</strong> · ${r.hasTapa ? `tapa: ${escapeHtml(r.tapaType || 'sí')}` : 'sin tapa'}
        ${r.tapaRating ? `<span class="rating-stars" title="${r.tapaRating} de 5">${starsText(r.tapaRating)}</span>` : ''}
        <br><span class="muted">${escapeHtml(nameOf(r.userId, r.username))} · ${date(r.createdAt)}</span>
      </div>
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
    ${rating}
    <a class="btn block directions" href="${directionsUrl(bar)}" target="_blank" rel="noopener">Cómo llegar</a>
    <div class="section" data-photos hidden></div>
    <div class="section" data-update></div>
    <div class="section">
      <h3>Historial</h3>
      <ul class="history">${history}</ul>
      <p class="muted">Añadido por ${escapeHtml(nameOf(bar.createdBy, bar.createdByName))}</p>
    </div>
    <div class="section" data-owner hidden>
      <h3>Tu bar</h3>
      <p class="muted">Si lo borras, se borran también todos sus precios y fotos.</p>
    </div>
  `);

  // Cada uno puede borrar sus precios (menos el único que tenga el bar).
  if (bar.reportCount > 1) {
    node.querySelectorAll('.history li[data-own="true"]').forEach((li) => {
      li.append(deleteButton('Borrar', '¿Borrar?', async () => {
        await deleteReport(id, li.dataset.reportId);
        await showBar(id);
      }));
    });
  }

  // Quien creó el bar puede borrarlo entero.
  if (state.user?.uid === bar.createdBy) {
    const owner = $('[data-owner]', node);
    owner.hidden = false;
    owner.append(deleteButton('Borrar bar', 'Toca otra vez para borrar el bar', async () => {
      await deleteBar(id);
      closePanel();
      toast(`«${bar.name}» borrado`);
    }));
  }

  loadBarPhotos(id, $('[data-photos]', node));

  const update = $('[data-update]', node);
  if (state.user) {
    update.append(fragment(`
      <h3>¿Has estado? Actualiza el precio</h3>
      <form class="form">
        <div data-report></div>
        <div data-pickers></div>
        <p class="error"></p>
        <button class="btn primary">Actualizar</button>
      </form>
    `));
    const form = $('form', update);
    $('[data-report]', update).replaceWith(reportFields());
    const pickers = photoPickers(form);
    $('[data-pickers]', update).replaceWith(pickers.node);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(form, async () => {
        await addReport(state.user, id, { ...readReport(form), photos: await pickers.getPhotos() });
        await showBar(id);
      });
    });
  } else {
    update.append(fragment('<p class="muted"><a href="#" class="link" data-login>Entra</a> para actualizar el precio o subir fotos.</p>'));
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
  watchBars((bars) => {
    const ids = new Set(bars.map((bar) => bar.id));
    for (const [id, marker] of state.markers) {
      if (!ids.has(id)) {
        marker.remove();
        state.markers.delete(id);
      }
    }
    bars.forEach(upsertMarker);
  }, (err) => console.error(err));
}
