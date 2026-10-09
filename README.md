# 🍺 Birrapp

Mapa colaborativo de bares: cada usuario puede añadir bares en el mapa con el
precio de la cerveza y si ponen tapa (y de qué tipo). Cualquier usuario que
pruebe el bar puede actualizar el precio y la tapa.

## Arrancar

Requiere Node.js 22.13 o superior (usa el SQLite integrado en Node).

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Variables de entorno opcionales: `PORT` (por defecto `3000`) y `DB_FILE`
(por defecto `data/birrapp.db`).

## Cómo funciona

- **Usuarios**: registro e inicio de sesión con usuario y contraseña
  (contraseñas con `scrypt`, sesión por token).
- **Mapa**: Leaflet + OpenStreetMap. Cada bar aparece con su precio actual;
  en verde si ponen tapa.
- **Añadir bar**: botón «+ Añadir bar», tocas el mapa (o usas tu ubicación),
  y rellenas nombre, dirección, precio y tapa.
- **Actualizar precio**: al abrir un bar, cualquier usuario registrado puede
  dejar un nuevo precio/tapa. El bar muestra el último precio, la media y el
  historial de quién lo actualizó.

## API

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | | `{ username, password }` → `{ token, user }` |
| POST | `/api/auth/login` | | `{ username, password }` → `{ token, user }` |
| POST | `/api/auth/logout` | ✔ | Cierra la sesión |
| GET | `/api/auth/me` | ✔ | Usuario actual |
| GET | `/api/bars` | | Lista de bares con último precio, media y tapa |
| GET | `/api/bars/:id` | | Detalle del bar e historial de precios |
| POST | `/api/bars` | ✔ | `{ name, address?, lat, lng, price, has_tapa, tapa_type? }` |
| POST | `/api/bars/:id/reports` | ✔ | `{ price, has_tapa, tapa_type? }` actualiza precio/tapa |

Autenticación: cabecera `Authorization: Bearer <token>`.
