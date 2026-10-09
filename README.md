# 🍺 Birrapp

Mapa colaborativo de bares: cada usuario puede añadir bares en el mapa con el
precio de la cerveza y si ponen tapa (y de qué tipo). Cualquier usuario que
pruebe el bar puede actualizar el precio y la tapa.

## Arrancar

Requiere Node.js 20 o superior.

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Variables de entorno opcionales: `PORT` (por defecto `3000`) y `DB_FILE`
(por defecto `data/birrapp.db`). Con `TURSO_DATABASE_URL` y
`TURSO_AUTH_TOKEN` usa una base de datos de [Turso](https://turso.tech) en
lugar del fichero local.

## Publicarla en internet (gratis)

La app se despliega en [Render](https://render.com) y guarda los datos en
[Turso](https://turso.tech), los dos con plan gratuito.

1. **Base de datos (Turso)**
   1. Crea una cuenta en https://app.turso.tech (puedes entrar con GitHub).
   2. Crea una base de datos (por ejemplo `birrapp`), en la región más
      cercana (p. ej. Europa).
   3. Copia su **URL** (empieza por `libsql://`) y genera un **token**
      (*Create Token* / *Generate Token*). Las tablas se crean solas al
      arrancar la app.
2. **Servidor (Render)**
   1. Crea una cuenta en https://render.com con tu GitHub.
   2. *New* → *Blueprint* y elige este repositorio (y la rama donde esté
      `render.yaml`). Render detecta la configuración.
   3. Te pedirá `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`: pega los valores
      del paso 1 y pulsa *Apply*.
   4. Cuando termine, la app estará en `https://birrapp-xxxx.onrender.com`.

### Correos para recuperar la contraseña (Brevo)

Para que la app pueda enviar el enlace de «¿Has olvidado tu contraseña?» se
usa [Brevo](https://www.brevo.com) (gratis hasta 300 correos al día):

1. Crea una cuenta en https://www.brevo.com.
2. En *Senders, Domains & Dedicated IPs* → *Senders*, añade y verifica el
   correo desde el que se enviarán los mensajes (te llega un código a ese
   correo).
3. En *SMTP & API* → *API Keys*, genera una clave.
4. En Render, servicio `birrapp` → *Environment*, añade:
   - `BREVO_API_KEY`: la clave del paso 3.
   - `MAIL_FROM`: el correo verificado en el paso 2.

Sin estas variables la app funciona igual, pero el correo no se envía (solo
se escribe en los logs del servidor).

En el plan gratuito de Render el servidor se duerme tras 15 minutos sin
visitas: la primera visita después tarda unos 50 segundos en cargar. Los
datos no se pierden porque están en Turso. Cada vez que subas cambios a la
rama, Render vuelve a desplegar automáticamente.

## Cómo funciona

- **Usuarios**: registro e inicio de sesión con correo y contraseña
  (contraseñas con `scrypt`, sesión por token). Al registrarse se elige
  también el nombre que verán los demás. Si se olvida la contraseña, llega un
  enlace por correo que caduca en 1 hora. Las cuentas creadas antes de pedir
  correo pueden entrar con su nombre de usuario y añadir el correo en
  «Mi cuenta».
- **Logo**: en `public/index.html`, sustituir el texto del enlace `.brand`
  por `<img src="logo.svg" alt="Birrapp" class="brand-logo">`.
- **Mapa**: Leaflet + OpenStreetMap. Cada bar aparece con su precio actual;
  en verde si ponen tapa.
- **Añadir bar**: botón «Añadir bar» de abajo, tocas el mapa (o usas tu ubicación),
  y rellenas nombre, dirección, precio y tapa.
- **Actualizar precio**: al abrir un bar, cualquier usuario registrado puede
  dejar un nuevo precio/tapa. El bar muestra el último precio, la media y el
  historial de quién lo actualizó.

## API

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | | `{ email, username, password }` → `{ token, user }` |
| POST | `/api/auth/login` | | `{ email, password }` → `{ token, user }` |
| POST | `/api/auth/forgot` | | `{ email }` envía el enlace para cambiar la contraseña |
| POST | `/api/auth/reset` | | `{ token, password }` → `{ token, user }` |
| POST | `/api/auth/logout` | ✔ | Cierra la sesión |
| GET | `/api/auth/me` | ✔ | Usuario actual |
| PATCH | `/api/auth/me` | ✔ | `{ email }` cambia el correo |
| GET | `/api/bars` | | Lista de bares con último precio, media y tapa |
| GET | `/api/bars/:id` | | Detalle del bar e historial de precios |
| POST | `/api/bars` | ✔ | `{ name, address?, lat, lng, price, has_tapa, tapa_type? }` |
| POST | `/api/bars/:id/reports` | ✔ | `{ price, has_tapa, tapa_type? }` actualiza precio/tapa |

Autenticación: cabecera `Authorization: Bearer <token>`.
