/**
 * FLOTA VEHICULAR HRNO — registro y resolución de rutas.
 *
 * Patrones estilo '/api/itinerario/:id'. El segmento ':nombre' se captura
 * en `params`. Sin dependencias externas: en un Worker cada kilobyte cuenta.
 */

const rutas = [];

/**
 * @param {string} metodo   GET | POST | PUT | DELETE
 * @param {string} patron   p. ej. '/api/vehiculos/:id'
 * @param {Function} manejador  recibe { db, env, sesion, cuerpo, params, url }
 * @param {string[]} [roles]    roles autorizados; sin roles = ruta pública
 */
export const ruta = (metodo, patron, manejador, roles) =>
  rutas.push({
    metodo,
    // El patrón se conserva tal cual: es la llave con la que se consulta si la
    // ruta necesita aprobación (lib.js, REQUIERE_APROBACION). Reconstruirlo
    // desde los segmentos funcionaría igual hoy y se desincronizaría mañana.
    patron,
    segmentos: patron.split('/').filter(Boolean),
    manejador,
    roles: roles || null,
  });

export function resolver(metodo, ruta_) {
  const partes = ruta_.split('/').filter(Boolean);
  for (const r of rutas) {
    if (r.metodo !== metodo || r.segmentos.length !== partes.length) continue;
    const params = {};
    let calza = true;
    for (let i = 0; i < r.segmentos.length; i++) {
      const s = r.segmentos[i];
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(partes[i]);
      else if (s !== partes[i]) { calza = false; break; }
    }
    if (calza) return { ...r, params };
  }
  return null;
}

export const totalRutas = () => rutas.length;

/** El registro entero, para que las pruebas puedan recorrerlo. Lo usa la
 *  comprobación de que ninguna ruta de escritura de coordinación se queda sin
 *  pasar por aprobación (D41). */
export const rutasRegistradas = () => rutas;
