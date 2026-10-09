// Pruebas de las reglas de seguridad de Firestore contra el emulador.
// Se lanzan con `npm test` (arranca el emulador, ejecuta y lo para).
const { test, before, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, writeBatch, serverTimestamp, collection
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

// Lo que el bar copia de su último precio (la valoración de la tapa va a la media).
const latest = ({ price, hasTapa, tapaType }) => ({ price, hasTapa, tapaType });

function newBar(db, uid, username, overrides = {}, reportOverrides = {}) {
  const barRef = doc(collection(db, 'bars'));
  const reportRef = doc(collection(barRef, 'reports'));
  const r = { price: 2.5, hasTapa: true, tapaType: 'Bravas', tapaRating: 4 };
  const batch = writeBatch(db);
  batch.set(barRef, {
    name: 'Bar Manolo', address: null, lat: 40.4, lng: -3.7,
    createdBy: uid, createdByName: username, createdAt: serverTimestamp(),
    ...latest(r), priceUpdatedAt: serverTimestamp(), reportCount: 1, priceSum: r.price,
    ratingSum: 4, ratingCount: 1, lastReportId: reportRef.id,
    ...overrides,
  });
  batch.set(reportRef, { userId: uid, username, ...r, createdAt: serverTimestamp(), ...reportOverrides });
  return { barRef, commit: () => batch.commit() };
}

// `current`: { reportCount, priceSum, ratingSum, ratingCount } del bar antes del precio nuevo.
function newReport(db, uid, username, barRef, current, r = { price: 3, hasTapa: false, tapaType: null, tapaRating: null }, barOverrides = {}) {
  const reportRef = doc(collection(barRef, 'reports'));
  const batch = writeBatch(db);
  batch.set(reportRef, { userId: uid, username, ...r, createdAt: serverTimestamp() });
  batch.update(barRef, {
    ...latest(r), priceUpdatedAt: serverTimestamp(), reportCount: current.reportCount + 1,
    priceSum: current.priceSum + r.price,
    ratingSum: (current.ratingSum ?? 4) + (r.tapaRating ?? 0),
    ratingCount: (current.ratingCount ?? 1) + (r.tapaRating == null ? 0 : 1),
    lastReportId: reportRef.id, ...barOverrides,
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
  // Tapa sin valorar, valoración fuera de rango o media que no cuadra.
  await assertFails(newBar(ana, 'ana', 'ana', { ratingSum: 0, ratingCount: 0 }, { tapaRating: null }).commit());
  await assertFails(newBar(ana, 'ana', 'ana', { ratingSum: 6 }, { tapaRating: 6 }).commit());
  await assertFails(newBar(ana, 'ana', 'ana', { ratingSum: 5 }).commit());
  // Sin tapa no hay valoración.
  await assertFails(newBar(ana, 'ana', 'ana', { hasTapa: false, tapaType: null, ratingSum: 3 },
    { hasTapa: false, tapaType: null, tapaRating: 3 }).commit());
  await assertSucceeds(newBar(ana, 'ana', 'ana', { hasTapa: false, tapaType: null, ratingSum: 0, ratingCount: 0 },
    { hasTapa: false, tapaType: null, tapaRating: null }).commit());
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

test('fotos: solo JPEG, de tamaño razonable, a tu nombre y en bares que existen', async () => {
  const ana = as('ana');
  await registerProfile(ana, 'ana', 'ana');
  const { barRef, commit } = newBar(ana, 'ana', 'ana');
  await commit();
  const photo = (overrides = {}) => ({
    kind: 'beer', data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', userId: 'ana', username: 'ana',
    createdAt: serverTimestamp(), ...overrides,
  });
  const photos = collection(ana, 'bars', barRef.id, 'photos');

  await assertSucceeds(setDoc(doc(photos), photo()));
  await assertSucceeds(setDoc(doc(photos), photo({ kind: 'tapa' })));
  await assertFails(setDoc(doc(collection(anon(), 'bars', barRef.id, 'photos')), photo()));
  await assertFails(setDoc(doc(photos), photo({ kind: 'selfie' })));
  await assertFails(setDoc(doc(photos), photo({ data: 'data:text/html;base64,PHNjcmlwdD4=' })));
  await assertFails(setDoc(doc(photos), photo({ data: `data:image/jpeg;base64,${'A'.repeat(700000)}` })));
  await assertFails(setDoc(doc(photos), photo({ userId: 'luis' })));
  await assertFails(setDoc(doc(collection(ana, 'bars', 'no-existe', 'photos')), photo()));
  // Se pueden ver sin sesión, pero no cambiar, y sin sesión tampoco borrar.
  const first = doc(photos, 'una');
  await setDoc(first, photo());
  await assertSucceeds(getDoc(doc(anon(), 'bars', barRef.id, 'photos', 'una')));
  await assertFails(updateDoc(first, { kind: 'tapa' }));
  await assertFails(deleteDoc(doc(anon(), 'bars', barRef.id, 'photos', 'una')));
});


test('cambiar el nombre: reserva el nuevo, libera el antiguo y no pisa a nadie', async () => {
  const ana = as('ana');
  const luis = as('luis');
  await registerProfile(ana, 'ana', 'ana');
  await registerProfile(luis, 'luis', 'luis');
  const rename = (db, uid, from, to, { freeOld = true } = {}) => {
    const batch = writeBatch(db);
    if (from.toLowerCase() !== to.toLowerCase()) {
      batch.set(doc(db, 'usernames', to.toLowerCase()), { uid });
      if (freeOld) batch.delete(doc(db, 'usernames', from.toLowerCase()));
    }
    batch.update(doc(db, 'users', uid), { username: to });
    return batch.commit();
  };

  // Quedarse el nombre de otro, o cambiarlo sin liberar el antiguo.
  await assertFails(rename(ana, 'ana', 'ana', 'luis'));
  await assertFails(rename(ana, 'ana', 'ana', 'anita', { freeOld: false }));
  // Nombre no válido.
  await assertFails(rename(ana, 'ana', 'ana', 'a b'));
  // Bien hecho, y el nombre antiguo queda libre para otro.
  await assertSucceeds(rename(ana, 'ana', 'ana', 'anita'));
  await assertSucceeds(rename(luis, 'luis', 'luis', 'ana'));
  // Cambiar solo mayúsculas no necesita reservar otro nombre.
  await assertSucceeds(rename(ana, 'ana', 'anita', 'Anita'));
  // No se puede liberar el nombre de otro ni tocar su perfil.
  await assertFails(deleteDoc(doc(ana, 'usernames', 'ana')));
  await assertFails(updateDoc(doc(ana, 'users', 'luis'), { username: 'pepito' }));
  // Ni cambiar otros campos del perfil.
  await assertFails(updateDoc(doc(ana, 'users', 'ana'), { createdAt: serverTimestamp() }));
});

test('borrar: el bar solo su creador; precios y fotos, cada uno los suyos', async () => {
  const ana = as('ana');
  const luis = as('luis');
  await registerProfile(ana, 'ana', 'ana');
  await registerProfile(luis, 'luis', 'luis');
  const { barRef, commit } = newBar(ana, 'ana', 'ana');
  await commit();
  const anaReport = (await getDocs(collection(ana, 'bars', barRef.id, 'reports'))).docs[0];
  const luisBar = doc(luis, 'bars', barRef.id);
  await newReport(luis, 'luis', 'luis', luisBar, { reportCount: 1, priceSum: 2.5 });
  const luisReport = (await getDocs(collection(luis, 'bars', barRef.id, 'reports'))).docs.find((d) => d.data().userId === 'luis');
  const before = (await getDoc(luisBar)).data();

  // Borrar un precio y dejar el resumen como estaba antes de él.
  const removeReport = (db, reportId, barChanges) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'bars', barRef.id, 'reports', reportId));
    batch.update(doc(db, 'bars', barRef.id), { lastDeletedReportId: reportId, ...barChanges });
    return batch.commit();
  };
  const backToAna = {
    reportCount: 1, priceSum: 2.5, ratingSum: 4, ratingCount: 1, price: 2.5, hasTapa: true, tapaType: 'Bravas',
    priceUpdatedAt: anaReport.data().createdAt, lastReportId: anaReport.id,
  };
  // El precio de otro, sin tocar el resumen o con el resumen mal.
  await assertFails(removeReport(luis, anaReport.id, { reportCount: 1, priceSum: 3 }));
  await assertFails(deleteDoc(doc(luis, 'bars', barRef.id, 'reports', luisReport.id)));
  await assertFails(removeReport(luis, luisReport.id, { ...backToAna, priceSum: 99 }));
  await assertFails(removeReport(luis, luisReport.id, { ...backToAna, price: 1 }));
  // Bien hecho: el bar vuelve al precio de Ana.
  await assertSucceeds(removeReport(luis, luisReport.id, backToAna));
  const after = (await getDoc(luisBar)).data();
  if (after.reportCount !== 1 || after.price !== 2.5 || before.reportCount !== 2) throw new Error('resumen incorrecto');
  // El único precio del bar no se puede borrar.
  await assertFails(removeReport(ana, anaReport.id, { reportCount: 0, priceSum: 0 }));

  // Fotos: las tuyas sí, las de otros no.
  const photo = (uid) => ({
    kind: 'tapa', data: 'data:image/jpeg;base64,/9j/', userId: uid, username: uid, createdAt: serverTimestamp(),
  });
  await setDoc(doc(luis, 'bars', barRef.id, 'photos', 'de-luis'), photo('luis'));
  await setDoc(doc(ana, 'bars', barRef.id, 'photos', 'de-ana'), photo('ana'));
  await assertFails(deleteDoc(doc(luis, 'bars', barRef.id, 'photos', 'de-ana')));
  await assertSucceeds(deleteDoc(doc(luis, 'bars', barRef.id, 'photos', 'de-luis')));
  await setDoc(doc(luis, 'bars', barRef.id, 'photos', 'otra-de-luis'), photo('luis'));

  // El bar: Luis no puede borrarlo; Ana sí, con todo lo de dentro (también lo de Luis).
  await assertFails(deleteDoc(luisBar));
  const children = [
    ...(await getDocs(collection(ana, 'bars', barRef.id, 'reports'))).docs,
    ...(await getDocs(collection(ana, 'bars', barRef.id, 'photos'))).docs,
  ];
  const batch = writeBatch(ana);
  batch.delete(doc(ana, 'bars', barRef.id));
  children.forEach((d) => batch.delete(d.ref));
  await assertSucceeds(batch.commit());
});

test('valoraciones: la media de la tapa sube y baja con cada precio', async () => {
  const ana = as('ana');
  const luis = as('luis');
  await registerProfile(ana, 'ana', 'ana');
  await registerProfile(luis, 'luis', 'luis');
  const { barRef, commit } = newBar(ana, 'ana', 'ana');
  await commit();
  const luisBar = doc(luis, 'bars', barRef.id);
  const current = { reportCount: 1, priceSum: 2.5, ratingSum: 4, ratingCount: 1 };
  const tapa = (rating) => ({ price: 3, hasTapa: true, tapaType: 'Croqueta', tapaRating: rating });
  // Valoración que no cuadra con la media, o tapa sin valorar.
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, tapa(2), { ratingSum: 9 }));
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, tapa(2), { ratingCount: 1 }));
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, { ...tapa(2), tapaRating: null }, { ratingSum: 4, ratingCount: 1 }));
  await assertFails(newReport(luis, 'luis', 'luis', luisBar, current, { ...tapa(2), tapaRating: 2.5 }));
  // Bien: media (4 + 2) / 2.
  await assertSucceeds(newReport(luis, 'luis', 'luis', luisBar, current, tapa(2)));
  const bar = (await getDoc(luisBar)).data();
  if (bar.ratingSum !== 6 || bar.ratingCount !== 2) throw new Error('media incorrecta');
});

