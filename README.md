# Birrapp

Mapa colaborativo de bares: cada usuario puede añadir bares en el mapa con el
precio de la cerveza y si ponen tapa (y de qué tipo). Cualquier usuario que
pruebe el bar puede actualizar el precio y la tapa.

## Cómo está hecha

- **Firebase** (plan gratuito *Spark*, sin tarjeta):
  - **Authentication**: cuentas con correo y contraseña, y los correos de
    recuperar la contraseña y de cambiar el correo.
  - **Firestore**: base de datos de usuarios, bares y precios. La seguridad
    está en [`firestore.rules`](firestore.rules).
  - **Hosting**: aloja la web. Siempre está encendido, así que la app abre al
    instante.
- **Vite** para empaquetar la web (`web/`) en `dist/`.
- **Leaflet + OpenStreetMap** para el mapa (sin API key).
- Instalable como app en el móvil y en el ordenador (`web/public/manifest.webmanifest`).

## Puesta en marcha

### 1. Crear el proyecto de Firebase

1. Entra en https://console.firebase.google.com y crea un proyecto (por
   ejemplo `birrapp`). Google Analytics no hace falta.
2. **Authentication** → *Comenzar* → *Sign-in method* → activa
   **Correo electrónico/contraseña**.
3. **Firestore Database** → *Crear base de datos* → ubicación en Europa (por
   ejemplo `europe-southwest1`, Madrid) → **modo de producción**.
4. ⚙️ *Configuración del proyecto* → *Tus apps* → icono web `</>` → registra
   la app (sin marcar Hosting) y copia los datos de `firebaseConfig` en
   [`web/firebase-config.js`](web/firebase-config.js).

### 2. Probar en local

```bash
npm install
npm run dev          # http://localhost:5173 con el proyecto de Firebase real
```

O sin tocar el proyecto real, con los emuladores de Firebase (necesita Java):

```bash
npm run emulators    # en una terminal
npm run dev:local    # en otra
```

### 3. Publicar

**Desde la web (sin terminal), con Vercel o Netlify:**

1. Reglas de seguridad: consola de Firebase → **Firestore Database** →
   pestaña **Reglas** → borra lo que haya, pega el contenido de
   [`firestore.rules`](firestore.rules) y pulsa **Publicar**. Repetir cada vez
   que cambie ese archivo.
2. Web: en https://vercel.com (o https://app.netlify.com) → *Add New… →
   Project* → importa este repositorio de GitHub. La configuración ya está en
   `vercel.json` / `netlify.toml`; no hay que tocar nada. Cada vez que se suben
   cambios a la rama, se vuelve a publicar sola.

**O desde la terminal, con Firebase Hosting:**

```bash
npx firebase login
npm run deploy              # compila y sube la web y las reglas de seguridad
```

El proyecto (`birrap-c2921`) ya está elegido en `.firebaserc`. La app queda en
https://birrap-c2921.web.app. Cada vez que cambie algo,
basta con volver a ejecutar `npm run deploy`.

## Tests

```bash
npm test     # reglas de seguridad de Firestore contra el emulador (necesita Java)
```

## Estructura

- `web/index.html`, `web/main.js`, `web/styles.css`: la app.
- `web/firebase.js`: conexión con Firebase y operaciones (cuentas, bares, precios).
- `web/firebase-config.js`: datos del proyecto de Firebase.
- `web/public/`: logo, iconos, manifest y service worker.
- `firestore.rules`, `firebase.json`: reglas de seguridad y configuración de Firebase.

### Modelo de datos (Firestore)

- `users/{uid}`: `{ username, createdAt }`. El correo solo lo guarda Authentication.
- `usernames/{nombre en minúsculas}`: `{ uid }`, para que no haya nombres repetidos.
- `bars/{id}`: datos del bar y resumen del último precio (`price`, `hasTapa`,
  `tapaType`, `reportCount`, `priceSum`, `lastReportId`…), para pintar el mapa
  con una sola lectura.
- `bars/{id}/reports/{id}`: cada precio que deja un usuario.

## Versión anterior (temporal)

La primera versión (servidor Node en Render con base de datos en Turso) sigue
en `src/`, `public/` y `render.yaml` hasta que se dé de baja Render. Sus tests
se lanzan con `npm run test:legacy`. Sus datos no se pasan a Firebase.
