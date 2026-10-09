// Service worker mínimo para poder instalar Birrapp como app. No guarda nada
// en caché: si no hay conexión, muestra un aviso en lugar de un error.
const OFFLINE_HTML = `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Birrapp</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#fbb703;color:#0b1f35;font-family:system-ui,sans-serif;text-align:center;padding:16px">
<div><h1>Sin conexión</h1><p>Birrapp necesita internet para cargar el mapa y los bares.</p>
<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:8px;border:none;background:#0b1f35;color:#fff">Reintentar</button></div>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  );
});
