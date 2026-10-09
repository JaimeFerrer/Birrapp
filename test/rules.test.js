// Pruebas de las reglas de seguridad de Firestore contra el emulador.
// Se lanzan con `npm test` (arranca el emulador, ejecuta y lo para).
const { test, before, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, collection
} = require('firebase/firestore');

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-birrapp',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });
});

after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const as = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com` }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

async function registerProfile(db, uid, username) {
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', uid), { username, createdAt: serverTimestamp() });
  batch.set(doc(db, 'usernames', username.toLowerCase()), { uid });
  return batch.commit();
}

function newBar(db, uid, username, overrides = {}, reportOverrides = {}) {
  const barRef = doc(collection(db, 'bars'));
  const reportRef = doc(collection(barRef, 'reports'));
  const r = { price: 2.5, hasTapa: true, tapaType: 'Bravas' };
  const batch = writeBatch(db);
  batch.set(barRef, {
    name: 'Bar Manolo', address: null, lat: 40.4, lng: -3.7,
    createdBy: uid, createdByName: username, createdAt: serverTimestamp(),
    ...r, priceUpdatedAt: serverTimestamp(), reportCount: 1, priceSum: r.price, lastReportId: reportRef.id,
    ...overrides,
  });
  batch.set(reportRef, { userId: uid, username, ...r, createdAt: serverTimestamp(), ...reportOverrides });
  return { barRef, commit: () => batch.commit() };
}

function newReport(db, uid, username, barRef, current, r = { price: 3, hasTapa: false, tapaType: null }, barOverrides = {}) {
  const reportRef = doc(collection(barRef, 'reports'));
  const batch = writeBatch(db);
  batch.set(reportRef, { userId: uid, username, ...r, createdAt: serverTimestamp() });
  batch.update(barRef, {
    ...r, priceUpdatedAt: serverTimestamp(), reportCount: current.reportCount + 1,
    priceSum: current.priceSum + r.price, lastReportId: reportRef.id, ...barOverrides,
  });
  return batch.commit();
}

test('registro: nombres únicos y perfil propio', async () => {
  const ana = as('ana');
  await assertSucceeds(registerProfile(ana, 'ana', 'Ana'));
  // Otro usuario no puede quedarse el mismo nombre (aunque cambie mayúsculas).
  await assertFails(registerProfile(as('otra'), 'otra', 'ANA'));
  // Nadie puede crear el perfil de otro ni cambiar su nombre después.
  await assertFails(setDoc(doc(as('pepe'), 'users', 'luis'), { username: 'luis', createdAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(ana, 'users', 'ana'), { username: 'AnaNueva' }));
  // Nombre con caracteres no permitidos.
  await assertFails(registerProfile(as('raro'), 'raro', 'con espacios'));
  // Los perfiles son públicos (solo tienen el nombre).
  await assertSucceeds(getDoc(doc(anon(), 'users', 'ana')));
});

test('bares: solo con sesión, a tu nombre y con el precio cuadrado', async () => {
  const ana = as('ana');
  await registerProfile(ana, 'ana', 'ana');

  await assertFails(newBar(anon(), 'ana', 'ana').commit());
  await assertSucceeds(newBar(ana, 'ana', 'ana').commit());
  // A nombre de otro usuario o con otro nombre visible.
  await assertFails(newBar(ana, 'luis', 'ana').commit());
  await assertFails(newBar(ana, 'ana', 'luis').commit());
  // El resumen del bar no coincide con su primer precio.
  await assertFails(newBar(ana, 'ana', 'ana', { price: 1 }).commit());
  await assertFails(newBar(ana, 'ana', 'ana', { reportCount: 5 }).commit());
  // Precio fuera de rango o tapa mal puesta.
  await assertFails(newBar(ana, 'ana', 'ana', { price: 0, priceSum: 0 }, { price: 0 }).commit());
  await assertFails(newBar(ana, 'ana', 'ana', { hasTapa: false }, { hasTapa: false }).commit());
  // Ubicación imposible o campos de más.
  await assertFails(newBar(ana, 'ana', 'ana', { lat: 200 }).commit());
  await assertFails(newBar(ana, 'ana', 'ana', { hacked: true }).commit());
  // Cualquiera puede ver los bares.
  const { barRef } = newBar(ana, 'ana', 'ana');
  await assertSucceeds(getDoc(doc(anon(), 'bars', 'cualquiera')));
  await assertFails(deleteDoc(barRef));
});

test('precios: se añaden a tu nombre y actualizan el resumen correctamente', async () => {
  const ana = as('ana');
  const luis = as('luis');
  await registerProfile(ana, 'ana', 'ana');
  await registerProfile(luis, 'luis', 'luis');
  const { barRef, commit } = newBar(ana, 'ana', 'ana');
  await commit();
  const current = { reportCount: 1, priceSum: 2.5 };
  const luisBar = doc(luis, 'bars', barRef.id);

  const nobody = anon();
  await assertFails(newReport(nobody, 'luis', 'luis', doc(nobody, 'bars', barRef.id), current));
  // Contador o suma que no cuadran, o fecha inventada.
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, undefined, { reportCount: 10 }));
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, undefined, { priceSum: 1 }));
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, undefined, { price: 9 }));
  // Cambiar el nombre o la ubicación del bar aprovechando un precio nuevo.
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, undefined, { name: 'Otro' }));
  // Precio a nombre de otro.
  await assertFails(newReport(luis, 'ana', 'ana', luisBar, current));
  // Bien hecho.
  await assertSucceeds(newReport(luis, 'luis', 'luis', luisBar, current));
  const bar = (await getDoc(luisBar)).data();
  if (bar.reportCount !== 2 || bar.priceSum !== 5.5 || bar.price !== 3) throw new Error('resumen incorrecto');
  // Un precio suelto sin actualizar el bar, o tocar el bar sin precio nuevo.
  await assertFails(setDoc(doc(luisBar, 'reports', 'suelto'), {
    userId: 'luis', username: 'luis', price: 1, hasTapa: false, tapaType: null, createdAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(luisBar, { price: 0.5 }));
});
