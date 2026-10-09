import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail, deleteUser,
  EmailAuthProvider, reauthenticateWithCredential, verifyBeforeUpdateEmail,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, onSnapshot,
  query, where, orderBy, limit, writeBatch, runTransaction, serverTimestamp,
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

// Firebase manda un correo a la dirección nueva y la cambia cuando se confirma.
export async function changeEmail({ email, password }) {
  const user = auth.currentUser;
  await friendly(reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password)));
  await friendly(verifyBeforeUpdateEmail(user, String(email).trim()));
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
  return snap.docs.map(read).sort((a, b) => b.createdAt - a.createdAt);
}

function cleanReport({ price, hasTapa, tapaType }) {
  price = Math.round(Number(price) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0 || price > 100) {
    throw userError('El precio debe ser un número entre 0 y 100');
  }
  const tapa = hasTapa ? String(tapaType ?? '').trim().slice(0, 100) : '';
  return { price, hasTapa: Boolean(hasTapa), tapaType: tapa || null };
}

// Crea el bar y su primer precio a la vez. Cada bar guarda un resumen (último
// precio, nº de opiniones y suma de precios) para pintar el mapa con una sola lectura.
export async function addBar(user, { name, address, lat, lng, ...report }) {
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
  await friendly(batch.commit());
  return barRef.id;
}

// Añade un precio nuevo y actualiza el resumen del bar en la misma transacción.
export async function addReport(user, barId, report) {
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
  }));
}

export { db, auth };
