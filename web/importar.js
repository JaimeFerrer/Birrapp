import { doc, getDoc, writeBatch, Timestamp } from 'firebase/firestore';
import { db, watchUser, friendlyError } from './firebase.js';

const OLD_APP = 'https://birrapp.onrender.com';
const $ = (id) => document.getElementById(id);
const log = (line) => { $('log').textContent += `${line}\n`; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let user = null;
watchUser((u) => {
  user = u;
  $('who').textContent = u?.username
    ? `Sesión iniciada como ${u.username} (${u.email}).`
    : 'Inicia sesión en Birrapp con tu cuenta y vuelve a esta página.';
  $('go').disabled = !u?.username;
});

// El servidor antiguo se duerme: se reintenta mientras despierta (hasta ~2 min).
async function fetchExport() {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    try {
      const res = await fetch(`${OLD_APP}/api/export`);
      if (res.ok) return await res.json();
    } catch {
      // Mientras despierta, Render responde con su página de carga.
    }
    log(`Despertando el servidor antiguo… (intento ${attempt})`);
    await sleep(5000);
  }
  throw new Error('El servidor antiguo no responde. Vuelve a probar en unos minutos.');
}

const toTimestamp = (sqlDate) => Timestamp.fromDate(new Date(`${sqlDate.replace(' ', 'T')}Z`));

async function importAll() {
  const { bars, reports } = await fetchExport();
  log(`Encontrados ${bars.length} bares y ${reports.length} precios.`);
  // Los bares y precios del propio usuario pasan a su cuenta nueva; los de
  // otros quedan con su nombre antiguo.
  const ownerOf = (username) => (username.toLowerCase() === user.username.toLowerCase() ? user.uid : 'legacy');
  let imported = 0;
  let skipped = 0;

  for (const bar of bars) {
    const barId = `legacy-${bar.id}`;
    const barRef = doc(db, 'bars', barId);
    if ((await getDoc(barRef)).exists()) {
      skipped += 1;
      continue;
    }
    const barReports = reports.filter((r) => r.bar_id === bar.id);
    if (!barReports.length) continue;
    const last = barReports[barReports.length - 1];
    const batch = writeBatch(db);
    batch.set(barRef, {
      name: bar.name,
      address: bar.address || null,
      lat: bar.lat,
      lng: bar.lng,
      createdBy: ownerOf(bar.created_by),
      createdByName: bar.created_by,
      createdAt: toTimestamp(bar.created_at),
      price: last.price,
      hasTapa: last.has_tapa,
      tapaType: last.has_tapa ? last.tapa_type || null : null,
      priceUpdatedAt: toTimestamp(last.created_at),
      reportCount: barReports.length,
      priceSum: barReports.reduce((sum, r) => sum + r.price, 0),
      lastReportId: `legacy-${last.id}`,
      imported: true,
    });
    for (const r of barReports) {
      batch.set(doc(barRef, 'reports', `legacy-${r.id}`), {
        userId: ownerOf(r.username),
        username: r.username,
        price: r.price,
        hasTapa: r.has_tapa,
        tapaType: r.has_tapa ? r.tapa_type || null : null,
        createdAt: toTimestamp(r.created_at),
        imported: true,
      });
    }
    await batch.commit();
    imported += 1;
    log(`✓ ${bar.name} (${barReports.length} ${barReports.length === 1 ? "precio" : "precios"})`);
  }
  log(`\nListo: ${imported} bares importados${skipped ? `, ${skipped} ya estaban` : ''}.`);
}

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  $('log').textContent = '';
  try {
    await importAll();
  } catch (err) {
    log(`Error: ${err.code ? friendlyError(err).message : err.message}`);
    $('go').disabled = false;
  }
});
