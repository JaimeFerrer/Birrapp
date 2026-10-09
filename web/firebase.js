import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail, deleteUser,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, limit, writeBatch, runTransaction, serverTimestamp, deleteDoc,
} from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';

// En local (`npm run dev:emulators`) se usan los emuladores de Firebase.
const useEmulators = import.meta.env.VITE_EMULATORS === '1';

export const configured = useEmulators || Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

const app = configured
  ? initializeApp(useEmulators ? { apiKey: 'demo', projectId: 'demo-birrapp', authDomain: 'demo-birrapp.firebaseapp.com' } : firebaseConfig)
  : null;
const auth = app && getAuth(app);
const db = app && getFirestore(app);

if (auth) auth.languageCode = 'es'; // correos de Firebase (recuperar contraseña…) en español
if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const ERRORS = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos',
  'auth/wrong-password': 'Correo o contraseña incorrectos',
  'auth/user-not-found': 'Correo o contraseña incorrectos',
  'auth/invalid-email': 'Escribe un correo electrónico válido',
  'auth/missing-email': 'Escribe un correo electrónico válido',
  'auth/email-already-in-use': 'Ya hay una cuenta con ese correo',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres',
  'auth/missing-password': 'Escribe la contraseña',
  'auth/too-many-requests': 'Demasiados intentos. Espera un poco y vuelve a probar.',
  'auth/network-request-failed': 'No hay conexión. Comprueba tu internet y vuelve a probar.',
  'permission-denied': 'No se ha podido guardar. Revisa los datos y vuelve a probar.',
  unavailable: 'No hay conexión. Comprueba tu internet y vuelve a probar.',
};

// Convierte los errores de Firebase en mensajes para el usuario.
export function friendlyError(err) {
  return new Error(ERRORS[err?.code] || err?.userMessage || 'Algo ha fallado. Inténtalo de nuevo.');
}

async function friendly(promise) {
  try {
    return await promise;
  } catch (err) {
    throw friendlyError(err);
  }
}

const userError = (message) => Object.assign(new Error(message), { userMessage: message });

// Los datos de Firestore usan Timestamp; las escrituras pendientes, una estimación.
const read = (snap) => ({ id: snap.id, ...snap.data({ serverTimestamps: 'estimate' }) });

// ---------- Cuentas ----------

async function loadProfile(firebaseUser) {
  const snap = await getDoc(doc(db, 'users', firebaseUser.uid));
  return { uid: firebaseUser.uid, email: firebaseUser.email, username: snap.data()?.username ?? null };
}

// Llama a `callback` con el usuario ({ uid, email, username }) o null. El perfil
// se escucha en directo: al crear la cuenta, el nombre se guarda justo después
// de iniciar sesión y así llega en cuanto está.
export function watchUser(callback) {
  let stopProfile = null;
  return onAuthStateChanged(auth, (firebaseUser) => {
    stopProfile?.();
    stopProfile = null;
    if (!firebaseUser) {
      callback(null);
      return;
    }
    stopProfile = onSnapshot(doc(db, 'users', firebaseUser.uid), (snap) => {
      usernameCache.set(firebaseUser.uid, snap.data()?.username ?? null);
      callback({ uid: firebaseUser.uid, email: firebaseUser.email, username: snap.data()?.username ?? null });
    });
  });
}

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;

export async function register({ email, username, password }) {
  username = String(username).trim();
  if (!USERNAME_RE.test(username)) {
    throw userError('El nombre debe tener 3-30 caracteres (letras, números, . _ -)');
  }
  const nameRef = doc(db, 'usernames', username.toLowerCase());
  if ((await friendly(getDoc(nameRef))).exists()) {
    throw userError('Ese nombre ya está cogido, prueba con otro');
  }
  const { user } = await friendly(createUserWithEmailAndPassword(auth, String(email).trim(), password));
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', user.uid), { username, createdAt: serverTimestamp() });
    batch.set(nameRef, { uid: user.uid });
    await batch.commit();
  } catch (err) {
    // Si alguien ha cogido el nombre justo a la vez, no dejamos una cuenta a medias.
    await deleteUser(user).catch(() => {});
    throw err.code === 'permission-denied' ? userError('Ese nombre ya está cogido, prueba con otro') : friendlyError(err);
  }
  return { uid: user.uid, email: user.email, username };
}

export async function login({ email, password }) {
  const { user } = await friendly(signInWithEmailAndPassword(auth, String(email).trim(), password));
  return loadProfile(user);
}

export const logout = () => signOut(auth);

export const sendPasswordReset = (email) => friendly(sendPasswordResetEmail(auth, String(email).trim()));

// Cambia el nombre visible: reserva el nuevo y libera el antiguo a la vez.
export async function changeUsername(user, newName) {
  newName = String(newName).trim();
  if (!USERNAME_RE.test(newName)) {
    throw userError('El nombre debe tener 3-30 caracteres (letras, números, . _ -)');
  }
  if (newName === user.username) return;
  const oldKey = user.username.toLowerCase();
  const newKey = newName.toLowerCase();
  const batch = writeBatch(db);
  if (newKey !== oldKey) {
    const newRef = doc(db, 'usernames', newKey);
    if ((await friendly(getDoc(newRef))).exists()) {
      throw userError('Ese nombre ya está cogido, prueba con otro');
    }
    batch.set(newRef, { uid: user.uid });
    batch.delete(doc(db, 'usernames', oldKey));
  }
  batch.update(doc(db, 'users', user.uid), { username: newName });
  try {
    await batch.commit();
  } catch (err) {
    throw err.code === 'permission-denied' ? userError('Ese nombre ya está cogido, prueba con otro') : friendlyError(err);
  }
}

// Nombre actual de cada usuario (los bares, precios y fotos guardan el nombre
// que tenía al crearlos; así se muestra el de ahora si lo ha cambiado).
const usernameCache = new Map();
export async function currentUsernames(uids) {
  const missing = [...new Set(uids)].filter((uid) => uid && !usernameCache.has(uid));
  await Promise.all(missing.map(async (uid) => {
    const snap = await getDoc(doc(db, 'users', uid)).catch(() => null);
    usernameCache.set(uid, snap?.data()?.username ?? null);
  }));
  return (uid, fallback) => usernameCache.get(uid) || fallback;
}

// ---------- Bares ----------

// Escucha en directo todos los bares (con su último precio).
export function watchBars(callback, onError) {
  return onSnapshot(collection(db, 'bars'), (snap) => callback(snap.docs.map(read)), onError);
}

export async function getBar(id) {
  const [barSnap, reportsSnap] = await friendly(Promise.all([
    getDoc(doc(db, 'bars', id)),
    getDocs(query(collection(db, 'bars', id, 'reports'), orderBy('createdAt', 'desc'), limit(50))),
  ]));
  return barSnap.exists() ? { bar: read(barSnap), reports: reportsSnap.docs.map(read) } : null;
}

export async function getMyBars(uid) {
  const snap = await friendly(getDocs(query(collection(db, 'bars'), where('createdBy', '==', uid))));
  return snap.docs.map(read).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
}

function cleanReport({ price, hasTapa, tapaType }) {
  price = Math.round(Number(price) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0 || price > 100) {
    throw userError('El precio debe ser un número entre 0 y 100');
  }
  const tapa = hasTapa ? String(tapaType ?? '').trim().slice(0, 100) : '';
  return { price, hasTapa: Boolean(hasTapa), tapaType: tapa || null };
}

// ---------- Fotos ----------

// Las fotos se guardan comprimidas dentro de Firestore (Storage pide el plan de
// pago). Cada una va en su propio documento para no hacer pesada la lista de bares.
const PHOTO_MAX_SIDE = 1280;
const PHOTO_MAX_CHARS = 700_000; // un documento de Firestore admite hasta 1 MiB

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Reduce la foto del móvil (varios MB) a un JPEG de unos cientos de KB.
export async function compressPhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw userError('No se ha podido leer la foto. Prueba con otra en formato JPG o PNG.');
  }
  let side = PHOTO_MAX_SIDE;
  for (let quality = 0.8; ; quality -= 0.1) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', quality); });
    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length <= PHOTO_MAX_CHARS) return dataUrl;
    if (quality < 0.5) {
      side = Math.round(side * 0.75);
      quality = 0.8;
    }
  }
}

function photoDoc(user, photo) {
  return { kind: photo.kind, data: photo.data, userId: user.uid, username: user.username, createdAt: serverTimestamp() };
}

// Sube fotos a un bar sin tocar el precio.
export async function addPhotos(user, barId, photos) {
  if (!photos.length) throw userError('Elige al menos una foto');
  const batch = writeBatch(db);
  for (const photo of photos) batch.set(doc(collection(db, 'bars', barId, 'photos')), photoDoc(user, photo));
  await friendly(batch.commit());
}

export async function getPhotos(barId) {
  const snap = await friendly(getDocs(query(collection(db, 'bars', barId, 'photos'), orderBy('createdAt', 'desc'), limit(12))));
  // Las más nuevas primero y, de las subidas a la vez, la cerveza antes que la tapa.
  return snap.docs.map(read).sort((a, b) => (b.createdAt.toMillis() - a.createdAt.toMillis())
    || (a.kind === 'beer' ? -1 : 0) - (b.kind === 'beer' ? -1 : 0));
}

// Crea el bar y su primer precio a la vez. Cada bar guarda un resumen (último
// precio, nº de opiniones y suma de precios) para pintar el mapa con una sola lectura.
// `photos`: [{ kind: 'beer' | 'tapa', data: dataUrl de compressPhoto }].
export async function addBar(user, { name, address, lat, lng, photos = [], ...report }) {
  name = String(name).trim();
  if (!name) throw userError('El nombre del bar es obligatorio');
  const r = cleanReport(report);
  const barRef = doc(collection(db, 'bars'));
  const reportRef = doc(collection(barRef, 'reports'));
  const batch = writeBatch(db);
  batch.set(barRef, {
    name: name.slice(0, 100),
    address: String(address ?? '').trim().slice(0, 200) || null,
    lat, lng,
    createdBy: user.uid,
    createdByName: user.username,
    createdAt: serverTimestamp(),
    ...r,
    priceUpdatedAt: serverTimestamp(),
    reportCount: 1,
    priceSum: r.price,
    lastReportId: reportRef.id,
  });
  batch.set(reportRef, { userId: user.uid, username: user.username, ...r, createdAt: serverTimestamp() });
  for (const photo of photos) batch.set(doc(collection(barRef, 'photos')), photoDoc(user, photo));
  await friendly(batch.commit());
  return barRef.id;
}

// Añade un precio nuevo (y sus fotos, si hay) y actualiza el resumen del bar
// en la misma transacción.
export async function addReport(user, barId, { photos = [], ...report }) {
  const r = cleanReport(report);
  const barRef = doc(db, 'bars', barId);
  const reportRef = doc(collection(barRef, 'reports'));
  await friendly(runTransaction(db, async (tx) => {
    const bar = (await tx.get(barRef)).data();
    tx.set(reportRef, { userId: user.uid, username: user.username, ...r, createdAt: serverTimestamp() });
    tx.update(barRef, {
      ...r,
      priceUpdatedAt: serverTimestamp(),
      reportCount: bar.reportCount + 1,
      priceSum: bar.priceSum + r.price,
      lastReportId: reportRef.id,
    });
    for (const photo of photos) tx.set(doc(collection(barRef, 'photos')), photoDoc(user, photo));
  }));
}

// ---------- Borrar ----------

// Borra un bar propio con todos sus precios y fotos. Firestore no borra solas
// las subcolecciones, así que se borran a la vez (en tandas de 450 si hay muchas).
export async function deleteBar(barId) {
  const barRef = doc(db, 'bars', barId);
  const [reports, photos] = await friendly(Promise.all([
    getDocs(collection(barRef, 'reports')),
    getDocs(collection(barRef, 'photos')),
  ]));
  const children = [...reports.docs, ...photos.docs].map((d) => d.ref);
  let batch = writeBatch(db);
  batch.delete(barRef);
  let count = 1;
  for (const ref of children) {
    if (count === 450) {
      await friendly(batch.commit());
      batch = writeBatch(db);
      count = 0;
    }
    batch.delete(ref);
    count += 1;
  }
  await friendly(batch.commit());
}

// Borra un precio propio y recalcula el resumen del bar. Si era el último
// precio, el bar pasa a mostrar el anterior.
export async function deleteReport(barId, reportId) {
  const barRef = doc(db, 'bars', barId);
  const reportRef = doc(barRef, 'reports', reportId);
  const latestTwo = await friendly(getDocs(query(collection(barRef, 'reports'), orderBy('createdAt', 'desc'), limit(2))));
  const previous = latestTwo.docs.find((d) => d.id !== reportId);
  await friendly(runTransaction(db, async (tx) => {
    const bar = (await tx.get(barRef)).data();
    const report = (await tx.get(reportRef)).data();
    if (!bar || !report) throw userError('Ese precio ya no existe');
    if (bar.reportCount <= 1) throw userError('No se puede borrar el único precio del bar');
    const changes = {
      reportCount: bar.reportCount - 1,
      priceSum: bar.priceSum - report.price,
      lastDeletedReportId: reportId,
    };
    if (bar.lastReportId === reportId) {
      if (!previous) throw userError('No se puede borrar el único precio del bar');
      const p = previous.data();
      Object.assign(changes, {
        price: p.price,
        hasTapa: p.hasTapa,
        tapaType: p.tapaType,
        priceUpdatedAt: p.createdAt,
        lastReportId: previous.id,
      });
    }
    tx.delete(reportRef);
    tx.update(barRef, changes);
  }));
}

export const deletePhoto = (barId, photoId) => friendly(deleteDoc(doc(db, 'bars', barId, 'photos', photoId)));

export { db, auth };
