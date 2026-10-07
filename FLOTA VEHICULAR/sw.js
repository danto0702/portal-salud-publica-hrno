/**
 * Service worker de Flota HRNO.
 *
 * Es lo que convierte la página en una aplicación instalable: guarda el
 * armazón —pantalla, código, librerías e iconos— en el propio teléfono, de
 * modo que abra aunque el conductor esté en una vereda sin señal.
 *
 * Los DATOS nunca se cachean. Un itinerario viejo o una marca vieja serían
 * peores que no tener dato: el conductor creería que va a un sitio al que ya
 * no va. Las marcas tomadas sin cobertura las guarda la propia aplicación en
 * el teléfono y las envía sola al recuperar la señal.
 *
 * Estrategia: red primero, caché de respaldo. Así, con señal siempre se ve la
 * última versión publicada, y sin señal se ve la última que se alcanzó a ver.
 */
const CACHE = 'flota-v16';

const ARMAZON = [
  './', './index.html', './app.js', './manifest.json',
  './libs/chart.umd.min.js', './libs/xlsx.full.min.js',
  './libs/jszip.min.js', './libs/jspdf.umd.min.js',
  './iconos/icono-192.png', './iconos/icono-512.png',
  './iconos/apple-touch-icon.png', './iconos/favicon-32.png', './iconos/favicon-16.png',
  './iconos/pascalia.png', './iconos/marca.png',
];

// Aquí NO se llama a skipWaiting: una versión nueva se queda esperando y la
// aplicación ofrece el botón "Actualizar". Si entrara sola, recargaría la
// pantalla en cualquier momento — por ejemplo con el conductor a media marca de
// salida, perdiendo el kilometraje y la foto que acababa de adjuntar.
self.addEventListener('install', e => {
  // addAll aborta entero si un archivo falla; se guardan uno a uno para que la
  // instalación no se caiga por un icono que aún no se haya publicado.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(ARMAZON.map(u => c.add(u).catch(() => null)))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** La aplicación instalada no se recarga con F5: pide el relevo por mensaje. */
self.addEventListener('message', e => {
  if (e.data?.tipo === 'saltar-espera') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;          // la API siempre va a la red
  if (url.origin !== location.origin) return;            // fuentes y librerías, igual

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return r;
      })
      .catch(async () => {
        const guardada = await caches.match(e.request, { ignoreSearch: true });
        if (guardada) return guardada;
        // Solo una navegación se responde con la pantalla: devolver el HTML en
        // lugar de un .js que falta rompería la aplicación en silencio.
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
  );
});
