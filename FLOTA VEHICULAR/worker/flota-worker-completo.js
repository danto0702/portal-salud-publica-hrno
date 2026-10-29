/**
 * FLOTA VEHICULAR HRNO — Worker completo en un solo archivo
 *
 * ESE Hospital Regional Noroccidental · Coordinación de Salud Pública
 *
 * ARCHIVO GENERADO — no editar a mano.
 * Se produce con:  node construir_bundle.mjs
 * El código fuente está en src/ (router, lib, estadistica, rutas_admin, rutas_operacion,
 * rutas_fuera_servicio, rutas_solicitudes, index).
 *
 * Este archivo existe para poder pegarlo en el editor del panel web de
 * Cloudflare, sin necesidad de instalar nada ni usar la terminal.
 */


// ════════════════════════════════════════════════════════════════════════
// router.js
// ════════════════════════════════════════════════════════════════════════
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
const ruta = (metodo, patron, manejador, roles) =>
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

function resolver(metodo, ruta_) {
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

const totalRutas = () => rutas.length;

/** El registro entero, para que las pruebas puedan recorrerlo. Lo usa la
 *  comprobación de que ninguna ruta de escritura de coordinación se queda sin
 *  pasar por aprobación (D41). */
const rutasRegistradas = () => rutas;

// ════════════════════════════════════════════════════════════════════════
// lib.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — API (Cloudflare Worker + D1)
 *
 * ESE Hospital Regional Noroccidental · Coordinación de Salud Pública
 *
 * Tres roles: principal, coordinacion, conductor. Ver PROJECT.md §5.12.
 *
 * Reglas transversales que este archivo hace cumplir:
 *   1. La hora de toda marca la pone el servidor, nunca el dispositivo.
 *   2. Solo el rol principal crea usuarios y toca parámetros.
 *   3. El conductor no puede corregir una marca ya registrada.
 *   4. Todo cambio de itinerario deja rastro visible en itinerario_cambios.
 *   5. Un destino ya usado se desactiva, jamás se borra.
 */

// ───────────────────────────────────────────────────────────── utilidades ───

/**
 * Versión del contrato de la API. SUBIRLA cada vez que la aplicación empiece a
 * depender de algo que el Worker anterior no sabe hacer.
 *
 * El Worker se publica a mano pegándolo en el panel de Cloudflare, mientras que
 * la aplicación se actualiza sola desde GitHub Pages. Sin este número, un
 * Worker viejo acepta la petición, guarda lo que entiende e ignora el resto en
 * silencio — que fue justo lo que pasó con el conductor predeterminado.
 *
 * Historial:
 *   1  versión inicial
 *   2  conductor_id en vehículos (conductor predeterminado)
 *   3  banco de predeterminados, mover/duplicar, borrado definitivo y carga por lote
 *   4  banner institucional y tipos de documento vencido en vehículos y personas
 *   5  sello de cambios para sincronizar, vínculo obligatorio conductor↔persona
 *      y día operativo en hora de Colombia
 *   6  kilometraje y tripulación obligatorios, fotografías de salida y llegada
 */
const VERSION_API = 19;

/**
 * Juegos de roles que usan las rutas.
 *
 * Viven aquí y no en cada archivo de rutas porque el Worker se publica como UN
 * SOLO archivo concatenado (construir_bundle.mjs): dos módulos que declararan
 * `const TODOS` cada uno chocarían al unirse, y el fallo saldría solo al pegar
 * el bundle en Cloudflare, no al correr el código fuente.
 */
const TODOS = ['principal', 'coordinacion', 'conductor'];
const GESTION = ['principal', 'coordinacion'];

/** Causas válidas de un período fuera de servicio. Vive aquí por lo mismo que
 *  TODOS y GESTION, y porque la comprueban dos sitios: la ruta que lo registra
 *  y la revisión previa de una solicitud de coordinación (D41). */
const CAUSAS = ['averia', 'mantenimiento', 'accidente', 'documentos',
                'retenido', 'sin_conductor', 'otro'];

const ahora = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
/**
 * Fecha del día operativo, en hora de Colombia (UTC−5).
 *
 * El Worker corre en UTC: a las 7 de la noche en Ábrego ya es el día siguiente
 * en UTC. Un conductor que marcara salida a esa hora habría quedado registrado
 * en la fecha equivocada, sin cruzar con el itinerario de ese día y
 * descuadrando el contador de días.
 */
const HORAS_COLOMBIA = -5;
const hoyISO = () =>
  new Date(Date.now() + HORAS_COLOMBIA * 3600e3).toISOString().slice(0, 10);

function cors(origen, permitidos) {
  const lista = (permitidos || '').split(',').map(o => o.trim()).filter(Boolean);
  const ok = origen && lista.includes(origen);
  return {
    'Access-Control-Allow-Origin': ok ? origen : lista[0] || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

class ErrorApi extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

const malaPeticion = m => new ErrorApi(400, m);
const noAutorizado = m => new ErrorApi(401, m || 'Sesión no válida o expirada');
const prohibido = m => new ErrorApi(403, m || 'Su rol no permite esta acción');
const noEncontrado = m => new ErrorApi(404, m || 'No encontrado');

// ──────────────────────────────────────────────────────────────── claves ────

/**
 * PBKDF2-SHA256. Formato almacenado: pbkdf2$<iter>$<salt b64>$<hash b64>
 *
 * NO SUBIR DE 100000. El runtime de Workers lo rechaza con
 *   "Pbkdf2 failed: iteration counts above 100000 are not supported"
 * y el error solo aparece en producción: en Node no existe ese tope, así que
 * las pruebas pasan igual. Verificado contra el Worker el 11 sep 2026.
 *
 * El número queda escrito dentro del propio hash, de modo que verificarClave
 * sigue aceptando claves creadas con otro valor.
 */
const ITERACIONES = 100000;

async function hashClave(clave, saltBytes, iteraciones) {
  const iter = iteraciones || ITERACIONES;
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, material, 256);
  return `pbkdf2$${iter}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function verificarClave(clave, almacenado) {
  if (!almacenado || !almacenado.startsWith('pbkdf2$')) return false;
  const [, iter, salt] = almacenado.split('$');
  const calculado = await hashClave(clave, deB64(salt), Number(iter));
  // Comparación de tiempo constante
  if (calculado.length !== almacenado.length) return false;
  let dif = 0;
  for (let i = 0; i < calculado.length; i++) {
    dif |= calculado.charCodeAt(i) ^ almacenado.charCodeAt(i);
  }
  return dif === 0;
}

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const deB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// ─────────────────────────────────────────────────────────────── sesiones ───

async function sesionActual(db, request) {
  const cabecera = request.headers.get('Authorization') || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : null;
  if (!token) return null;

  const fila = await db.prepare(`
    SELECT s.id AS token, s.expira_en,
           u.id, u.usuario, u.rol, u.persona_id, u.municipio_id,
           u.activo, u.debe_cambiar_clave,
           p.nombres, p.apellidos
      FROM sesiones s
      JOIN usuarios u ON u.id = s.usuario_id
      LEFT JOIN personas p ON p.id = u.persona_id
     WHERE s.id = ?`).bind(token).first();

  if (!fila || !fila.activo) return null;
  if (fila.expira_en <= ahora()) {
    await db.prepare('DELETE FROM sesiones WHERE id = ?').bind(token).run();
    return null;
  }
  return fila;
}

function exigirRol(sesion, ...roles) {
  if (!sesion) throw noAutorizado();
  if (!roles.includes(sesion.rol)) throw prohibido();
  return sesion;
}

// ─────────────────────────────────────────────────────────────── auditoría ──

async function auditar(db, sesion, accion, entidad, entidadId, antes, despues) {
  await db.prepare(`
    INSERT INTO auditoria (ts, usuario_id, rol, accion, entidad, entidad_id,
                           valor_antes, valor_despues)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(ahora(), sesion ? sesion.id : null, sesion ? sesion.rol : null,
          accion, entidad, entidadId || null,
          antes ? JSON.stringify(antes) : null,
          despues ? JSON.stringify(despues) : null)
    .run();
}

// ─────────────────────────────────────────────── fuera de servicio ──────────

/**
 * Crea `fuera_servicio` si todavía no existe.
 *
 * La base de producción se creó antes de esta tabla, y quien despliega no tiene
 * terminal: pega el Worker en el editor web de Cloudflare y ya. Pedirle además
 * que ejecute un CREATE TABLE por su cuenta sería el paso donde se rompe todo.
 * Así el primer uso la crea sola, y en una instalación nueva ya viene en
 * schema.sql y esto no hace nada.
 *
 * Se intenta una sola vez por isolate: no es una consulta que valga la pena
 * repetir en cada petición.
 */
let esquemaListo = false;
async function asegurarEsquema(db) {
  if (esquemaListo) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS fuera_servicio (
      id             INTEGER PRIMARY KEY,
      vehiculo_id    INTEGER NOT NULL REFERENCES vehiculos(id),
      causa          TEXT NOT NULL,
      fecha_inicio   TEXT NOT NULL,
      fecha_fin      TEXT,
      descripcion    TEXT,
      taller         TEXT,
      km_evento      INTEGER,
      evento_id      INTEGER REFERENCES eventos(id),
      foto_mime      TEXT,
      foto_datos     TEXT,
      registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
      rol_registro   TEXT NOT NULL,
      creado_en      TEXT NOT NULL,
      cerrado_por    INTEGER REFERENCES usuarios(id),
      cerrado_en     TEXT,
      motivo_cierre  TEXT
    )`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_fs_veh ON fuera_servicio(vehiculo_id, fecha_inicio)').run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_fs_abierto ON fuera_servicio(fecha_fin, vehiculo_id)').run();

  // Historial visible de correcciones de un viaje (D38). Igual que
  // itinerario_cambios: la auditoría técnica no basta cuando lo que se corrige
  // es el soporte de un pago — tiene que verse en el propio viaje, al lado del
  // dato corregido, no en otra pantalla a la que nadie entra.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS trayecto_cambios (
      id            INTEGER PRIMARY KEY,
      trayecto_id   INTEGER NOT NULL REFERENCES trayectos(id) ON DELETE CASCADE,
      ts            TEXT NOT NULL,
      usuario_id    INTEGER NOT NULL,
      campo         TEXT NOT NULL,
      valor_antes   TEXT,
      valor_despues TEXT,
      motivo        TEXT
    )`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_traycam ON trayecto_cambios(trayecto_id, ts)').run();

  // Solicitudes de aprobación (D41). Lo que pide la coordinación queda aquí
  // GUARDADO PERO SIN APLICAR hasta que el administrador lo apruebe: por eso se
  // almacena la petición entera —método, ruta, parámetros y cuerpo— y no un
  // resumen. Al aprobar se vuelve a ejecutar la MISMA ruta con la MISMA sesión
  // de quien la pidió, de modo que las validaciones, el historial y la
  // auditoría salen idénticos a los de un cambio hecho directamente.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id             INTEGER PRIMARY KEY,
      ts             TEXT NOT NULL,
      solicitante_id INTEGER NOT NULL REFERENCES usuarios(id),
      metodo         TEXT NOT NULL,
      patron         TEXT NOT NULL,
      ruta           TEXT NOT NULL,
      params         TEXT,
      cuerpo         TEXT,
      resumen        TEXT NOT NULL,
      afecta_desde   TEXT,
      afecta_hasta   TEXT,
      cuantas        INTEGER NOT NULL DEFAULT 1,
      vence_el       TEXT,
      estado         TEXT NOT NULL DEFAULT 'pendiente',
      resuelto_en    TEXT,
      resuelto_por   INTEGER REFERENCES usuarios(id),
      motivo         TEXT,
      resultado      TEXT
    )`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_sol_estado ON solicitudes(estado, ts)').run();

  // Los días que toca cada solicitud, uno por fila. Existe para dos cosas que
  // no se pueden sacar del cuerpo guardado sin volver a interpretarlo: pintar
  // la celda «pendiente» en la matriz, y rechazar de entrada una segunda
  // solicitud sobre un día que ya tiene una esperando.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS solicitud_dias (
      solicitud_id INTEGER NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
      fecha        TEXT NOT NULL,
      vehiculo_id  INTEGER NOT NULL
    )`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_soldia ON solicitud_dias(fecha, vehiculo_id)').run();

  // Informes estadísticos firmados (D42). Se guarda el informe EMITIDO, con
  // sus cifras congeladas en JSON, no la receta para recalcularlo: un papel
  // que alguien firmó tiene que poder volver a imprimirse idéntico dentro de
  // dos años, aunque para entonces un viaje se haya anulado o corregido. Si se
  // recalculara, el PDF que está en la carpeta y el que sale de la aplicación
  // dirían cosas distintas, y el firmado sería el que no cuadra.
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS informes (
      id           INTEGER PRIMARY KEY,
      consecutivo  TEXT NOT NULL UNIQUE,
      ts           TEXT NOT NULL,
      emitido_por  INTEGER NOT NULL REFERENCES usuarios(id),
      titulo       TEXT NOT NULL,
      desde        TEXT NOT NULL,
      hasta        TEXT NOT NULL,
      filtros      TEXT,
      firmantes    TEXT NOT NULL,
      cifras       TEXT NOT NULL,
      con_anexo    INTEGER NOT NULL DEFAULT 0,
      observaciones TEXT
    )`).run();
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_informes_ts ON informes(ts)').run();

  // Columnas de anulación de viajes (D35). SQLite no tiene
  // ADD COLUMN IF NOT EXISTS: se intenta y se ignora el error de «ya existe»,
  // que es lo que pasa en todos los arranques menos el primero.
  for (const col of ['anulado_por INTEGER', 'anulado_en TEXT', 'motivo_anulacion TEXT']) {
    try { await db.prepare(`ALTER TABLE trayectos ADD COLUMN ${col}`).run(); }
    catch { /* ya estaba */ }
  }
  esquemaListo = true;
}

/**
 * El período de fuera de servicio que cubre ese día, si lo hay.
 *
 * fecha_fin NULL significa «sigue parado», así que cubre desde su inicio hasta
 * hoy y hasta que alguien lo cierre.
 */
async function fueraDeServicio(db, fecha, vehiculoId) {
  await asegurarEsquema(db);
  return db.prepare(`
    SELECT id, causa, fecha_inicio, fecha_fin FROM fuera_servicio
     WHERE vehiculo_id = ? AND fecha_inicio <= ?
       AND (fecha_fin IS NULL OR fecha_fin >= ?)
     LIMIT 1`).bind(vehiculoId, fecha, fecha).first();
}

// ────────────────────────────────────── recálculo de días de operación ──────

/**
 * Recalcula dias_operacion para un vehículo y fecha.
 *
 * Regla de pago (D11): un día DISPONIBLE en base se paga igual que uno con
 * desplazamiento. Por eso se guardan dos señales distintas, `ejecutado` y
 * `dia_pagable`: la primera dice quién se movió de verdad, la segunda qué se
 * liquida. Confundirlas haría invisible el vehículo subutilizado.
 *
 * Nunca pisa un día con ajuste_manual = 1: esa es una decisión humana firmada.
 */
async function recalcularDia(db, fecha, vehiculoId) {
  const manual = await db.prepare(
    'SELECT ajuste_manual FROM dias_operacion WHERE fecha = ? AND vehiculo_id = ?')
    .bind(fecha, vehiculoId).first();
  if (manual && manual.ajuste_manual) return;

  const itin = await db.prepare(`
    SELECT tipo_jornada, conductor_id FROM itinerarios
     WHERE fecha = ? AND vehiculo_id = ? AND estado != 'cancelado'`)
    .bind(fecha, vehiculoId).first();

  const t = await db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN estado = 'cerrado' THEN 1 ELSE 0 END) AS cerrados,
           SUM(CASE WHEN km_final IS NOT NULL AND km_inicial IS NOT NULL
                    THEN km_final - km_inicial ELSE 0 END) AS km,
           SUM(CASE WHEN ts_llegada IS NOT NULL AND ts_salida IS NOT NULL
                    THEN (julianday(ts_llegada) - julianday(ts_salida)) * 24
                    ELSE 0 END) AS horas,
           MAX(conductor_id) AS conductor_id
      FROM trayectos
     WHERE fecha_operacion = ? AND vehiculo_id = ? AND estado != 'anulado'`)
    .bind(fecha, vehiculoId).first();

  const programado = itin ? 1 : 0;
  const ejecutado = t && t.cerrados > 0 ? 1 : 0;
  const tipo = itin ? itin.tipo_jornada : null;

  let estadoDia = 'no_programado';
  if (tipo === 'disponible') estadoDia = 'disponible';
  else if (tipo === 'jornada' || tipo === 'vacunacion') estadoDia = 'jornada_especial';
  else if (programado) estadoDia = 'operativo';
  else if (ejecutado) estadoDia = 'operativo';

  const param = await db.prepare(
    "SELECT valor FROM parametros WHERE clave = 'dia_disponible_es_pagable'").first();
  const disponiblePaga = !param || param.valor === '1';

  let pagable = (ejecutado || (tipo === 'disponible' && disponiblePaga)) && programado ? 1 : 0;

  // ── Días fuera de servicio (D33) ──
  // Un vehículo parado no se paga, aunque el día estuviera programado. Pesa
  // sobre todo en los días DISPONIBLE, que se pagan sin que el conductor marque
  // nada: sin esto, un vehículo en el taller seguiría cobrando por estar «en
  // base».
  //
  // Excepción deliberada: si ese día hay viajes CERRADOS, el vehículo
  // demostrablemente operó. Entonces manda el hecho, no el registro, y el día
  // sigue pagable. Una contradicción así es un error de fechas, y al guardar el
  // período se avisa cuántos días la tienen — pero nunca se descuenta en
  // silencio un día que el vehículo trabajó.
  const fs = await fueraDeServicio(db, fecha, vehiculoId);
  if (fs && !ejecutado) {
    estadoDia = fs.causa === 'mantenimiento' ? 'mantenimiento' : 'fuera_servicio';
    pagable = 0;
  }

  await db.prepare(`
    INSERT INTO dias_operacion (fecha, vehiculo_id, conductor_id, estado_dia,
                                programado, ejecutado, num_trayectos,
                                horas_operacion, km_dia, dia_pagable, ajuste_manual)
    VALUES (?,?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT (fecha, vehiculo_id) DO UPDATE SET
      conductor_id    = excluded.conductor_id,
      estado_dia      = excluded.estado_dia,
      programado      = excluded.programado,
      ejecutado       = excluded.ejecutado,
      num_trayectos   = excluded.num_trayectos,
      horas_operacion = excluded.horas_operacion,
      km_dia          = excluded.km_dia,
      dia_pagable     = excluded.dia_pagable`)
    .bind(fecha, vehiculoId,
          (itin && itin.conductor_id) || (t && t.conductor_id) || null,
          estadoDia, programado, ejecutado,
          (t && t.n) || 0, (t && t.horas) || 0, (t && t.km) || 0, pagable)
    .run();
}

/** Registra el uso de un destino para alimentar el autocompletado (D12). */
async function marcarUsoDestino(db, destinoId) {
  if (!destinoId) return;
  await db.prepare(`
    UPDATE cat_destinos
       SET veces_usado = veces_usado + 1, ultimo_uso = ?
     WHERE id = ?`).bind(ahora(), destinoId).run();
}

// ─────────────────────────────────────────────────────────────── consecutivos ─

/**
 * El siguiente número de la serie del año: TR-2026-000253.
 *
 * Sale del MÁXIMO, no de COUNT(*). Contar solo funciona mientras no se borre
 * nada nunca, y eso dejó de ser cierto el día que el administrador pudo quitar
 * un viaje: al borrar uno, el conteo baja y el siguiente número choca con el
 * último que ya existe. Como la columna es UNIQUE, el choque no se queda en un
 * número repetido — rechaza la marca, y la rechaza SIEMPRE, para todos los
 * conductores, hasta que alguien lo arregle. Pasó en producción el 7 de
 * octubre de 2026: se borró el viaje de prueba TR-2026-000001 y a la mañana
 * siguiente ningún conductor podía registrar la salida.
 *
 * Con el máximo, un número borrado deja un hueco y la serie sigue hacia
 * adelante, que es lo que se espera de un consecutivo: no se reutiliza.
 *
 * El número empieza en el carácter siguiente a «PREFIJO-AAAA-», que son
 * prefijo + 6 caracteres; substr() cuenta desde 1.
 */
async function siguienteConsecutivo(db, prefijo, tabla) {
  const anio = hoyISO().slice(0, 4);
  const fila = await db.prepare(
    `SELECT MAX(CAST(substr(consecutivo, ${prefijo.length + 7}) AS INTEGER)) AS ultimo
       FROM ${tabla} WHERE consecutivo LIKE ?`)
    .bind(`${prefijo}-${anio}-%`).first();
  const n = String(((fila && fila.ultimo) || 0) + 1).padStart(6, '0');
  return `${prefijo}-${anio}-${n}`;
}

/**
 * Inserta reintentando si el consecutivo se le adelantó otro.
 *
 * Dos conductores marcando salida en el mismo segundo —a las seis de la mañana
 * salen todos a la vez— leen el mismo máximo y piden el mismo número. Uno gana
 * y el otro se estrella contra el UNIQUE. No hay transacciones que valgan aquí:
 * la salida se vuelve a intentar con el número siguiente, que es lo que haría
 * una persona.
 *
 * @param hacer  función que recibe el consecutivo y ejecuta el INSERT
 */
async function conConsecutivo(db, prefijo, tabla, hacer, intentos = 5) {
  for (let i = 0; ; i++) {
    const consecutivo = await siguienteConsecutivo(db, prefijo, tabla);
    try {
      return await hacer(consecutivo);
    } catch (e) {
      const choque = /UNIQUE constraint failed/i.test(String(e && e.message || e));
      if (!choque || i >= intentos - 1) throw e;
    }
  }
}

/**
 * Resuelve un destino por nombre al adjudicar un desplazamiento (D12).
 *
 * Tres casos, en este orden:
 *   1. Ya existe con ese municipio          -> se reutiliza.
 *   2. Existe sin municipio asignado         -> se ADOPTA y se le fija el municipio.
 *      Es el caso de los destinos de la semilla, que nacen con municipio NULL
 *      porque en el archivo de origen la columna municipio era la base del
 *      conductor, no la del destino.
 *   3. No existe, o existe en OTRO municipio -> se crea uno nuevo.
 *      Un mismo nombre en dos municipios distintos son dos lugares distintos.
 *
 * Devuelve el id del destino, ya reactivado si estaba desactivado.
 */
async function resolverDestino(db, nombre, municipioId, tipo, usuarioId) {
  if (!nombre) return null;
  const limpio = String(nombre).trim().toUpperCase();
  const mun = municipioId || null;

  const candidato = await db.prepare(`
    SELECT id, municipio_id FROM cat_destinos
     WHERE nombre = ? AND (municipio_id = ? OR municipio_id IS NULL)
     ORDER BY CASE WHEN municipio_id IS NULL THEN 1 ELSE 0 END
     LIMIT 1`).bind(limpio, mun).first();

  if (candidato) {
    await db.prepare(`
      UPDATE cat_destinos
         SET activo = 1, municipio_id = COALESCE(municipio_id, ?)
       WHERE id = ?`).bind(mun, candidato.id).run();
    return candidato.id;
  }

  const nuevo = await db.prepare(`
    INSERT INTO cat_destinos (municipio_id, nombre, tipo, activo, creado_por, creado_en)
    VALUES (?,?,?,1,?,?)`)
    .bind(mun, limpio, tipo || 'vereda', usuarioId || null, ahora()).run();
  return nuevo.meta.last_row_id;
}

// ──────────────────────────────── solicitudes de aprobación (D41) ───────────

/**
 * Lo que la coordinación NO puede aplicar por su cuenta.
 *
 * El 21 de octubre una cuenta de coordinación recién creada programó dos
 * semanas de operación en cuatro toques, siete minutos después de su primer
 * ingreso. Nadie lo autorizó y nadie se enteró hasta que la programación ya
 * estaba ahí. El itinerario es el soporte de lo que se paga: quien lo escribe
 * decide la plata.
 *
 * La lista se comprueba contra las rutas registradas en las pruebas, para que
 * una ruta nueva de coordinación no se cuele sin pasar por aquí ni por una
 * decisión explícita de dejarla fuera.
 */
const REQUIERE_APROBACION = [
  'POST /api/itinerario',
  'PUT /api/itinerario/:id',
  'DELETE /api/itinerario/:id',
  'POST /api/itinerario/mover',
  'POST /api/itinerario/lote',
  'POST /api/predeterminados',
  'PUT /api/predeterminados/:id',
  'PUT /api/eventos/:id',
  'POST /api/fuera-servicio',
  'PUT /api/fuera-servicio/:id',
  'POST /api/catalogos/destinos',
];

/**
 * Solo la coordinación pide permiso.
 *
 * El administrador aplica directo —si tuviera que aprobarse a sí mismo nadie
 * podría desatascar nada—, y el conductor tampoco pasa por aquí: lo único que
 * puede hacer de esta lista es reportar su propio vehículo averiado, y eso es
 * un hecho que ya ocurrió, no una decisión que se autorice.
 */
const necesitaAprobacion = (sesion, metodo, patron) =>
  !!sesion && sesion.rol === 'coordinacion'
  && REQUIERE_APROBACION.includes(`${metodo} ${patron}`);

const TEXTO_JORNADA = {
  ebs: 'Ruta EBS', jornada: 'Jornada', vacunacion: 'Vacunación',
  disponible: 'Disponible en base', traslado_ciudad: 'Fuera del área',
  administrativo: 'Administrativo',
};

const placaDe = async (db, id) => {
  if (!id) return 'vehículo sin identificar';
  const v = await db.prepare('SELECT placa FROM vehiculos WHERE id = ?').bind(id).first();
  return v ? v.placa : `vehículo #${id}`;
};

/**
 * Traduce la petición a una frase que se pueda aprobar sin abrir nada más, y
 * saca los días que toca.
 *
 * De paso hace la revisión BARATA de la petición —que no venga vacía, que lo
 * que dice tocar exista— y la rechaza en el momento. No es la validación
 * completa, que sigue viviendo en cada ruta y corre al aprobar: es lo justo
 * para que la bandeja del administrador no se llene de peticiones imposibles
 * que nadie puede aprobar y que fallarían una semana después, cuando ya nadie
 * se acuerde de qué se pedía.
 *
 * El administrador decide desde el teléfono y en un minuto. «PUT
 * /api/itinerario/482» no es una decisión que nadie pueda tomar; «Cambiar la
 * programación de OCV-123 del martes 4 de noviembre» sí.
 */
async function describirSolicitud(db, metodo, patron, params, cuerpo, url) {
  const clave = `${metodo} ${patron}`;
  const dias = [];
  let resumen = clave;
  let desde = null, hasta = null, cuantas = 1;

  if (clave === 'POST /api/itinerario') {
    if (!cuerpo.fecha || !cuerpo.vehiculo_id) {
      throw malaPeticion('Fecha y vehículo son obligatorios');
    }
    const placa = await placaDe(db, cuerpo.vehiculo_id);
    let jornada = cuerpo.tipo_jornada;
    if (!jornada && cuerpo.predeterminado_id) {
      const pre = await db.prepare('SELECT tipo_jornada FROM itinerario_predeterminados WHERE id = ?')
        .bind(cuerpo.predeterminado_id).first();
      jornada = pre && pre.tipo_jornada;
    }
    resumen = `Programar ${placa} el ${cuerpo.fecha}`
      + (jornada ? ` — ${TEXTO_JORNADA[jornada] || jornada}` : '');
    if (cuerpo.fecha && cuerpo.vehiculo_id) {
      dias.push({ fecha: cuerpo.fecha, vehiculo_id: Number(cuerpo.vehiculo_id) });
    }

  } else if (clave === 'PUT /api/itinerario/:id' || clave === 'DELETE /api/itinerario/:id') {
    const it = await db.prepare('SELECT * FROM itinerarios WHERE id = ?')
      .bind(params.id).first();
    if (!it) throw noEncontrado('Programación no encontrada');
    const placa = await placaDe(db, it.vehiculo_id);
    const definitivo = url && url.searchParams.get('definitivo') === '1';
    // Pedir algo que, al aprobarse, se ejecutaría con los permisos de quien lo
    // pidió —y fallaría— sería una solicitud que nadie puede aprobar nunca.
    // Se corta aquí y se contesta lo mismo que antes de D41: 403.
    if (definitivo) throw prohibido('Solo el administrador puede borrar definitivamente');
    resumen = metodo === 'PUT'
      ? `Cambiar la programación de ${placa} del ${it.fecha}`
      : `${definitivo ? 'Borrar' : 'Cancelar'} la programación de ${placa} del ${it.fecha}`;
    dias.push({ fecha: it.fecha, vehiculo_id: it.vehiculo_id });

  } else if (clave === 'POST /api/itinerario/mover') {
    if (!cuerpo.id || !cuerpo.fecha || !cuerpo.vehiculo_id) {
      throw malaPeticion('Se requieren id, fecha y vehiculo_id de destino');
    }
    const it = await db.prepare('SELECT * FROM itinerarios WHERE id = ?')
      .bind(cuerpo.id).first();
    if (!it) throw noEncontrado('Programación no encontrada');
    const placaO = await placaDe(db, it.vehiculo_id);
    const placaD = await placaDe(db, cuerpo.vehiculo_id);
    const mismo = placaO === placaD;
    resumen = `${cuerpo.duplicar ? 'Duplicar' : 'Mover'} la programación de ${placaO} `
      + `del ${it.fecha} ${mismo ? `al ${cuerpo.fecha}` : `a ${placaD} el ${cuerpo.fecha}`}`;
    dias.push({ fecha: it.fecha, vehiculo_id: it.vehiculo_id });
    if (cuerpo.fecha && cuerpo.vehiculo_id) {
      dias.push({ fecha: cuerpo.fecha, vehiculo_id: Number(cuerpo.vehiculo_id) });
    }

  } else if (clave === 'POST /api/itinerario/lote') {
    const ops = Array.isArray(cuerpo.operaciones) ? cuerpo.operaciones : [];
    if (!ops.length) throw malaPeticion('No hay operaciones que aplicar');
    if (ops.length > 600) throw malaPeticion('Demasiadas operaciones en un solo envío');
    const cuenta = { crear: 0, actualizar: 0, borrar: 0 };
    for (const op of ops) {
      cuenta[op.accion] = (cuenta[op.accion] || 0) + 1;
      let f = op.fecha, v = op.vehiculo_id;
      if (!f || !v) {                       // actualizar y borrar solo traen el id
        const it = await db.prepare('SELECT fecha, vehiculo_id FROM itinerarios WHERE id = ?')
          .bind(op.id).first();
        if (!it) continue;
        f = it.fecha; v = it.vehiculo_id;
      }
      dias.push({ fecha: f, vehiculo_id: Number(v) });
    }
    const partes = [];
    if (cuenta.crear) partes.push(`${cuenta.crear} nueva(s)`);
    if (cuenta.actualizar) partes.push(`${cuenta.actualizar} cambiada(s)`);
    if (cuenta.borrar) partes.push(`${cuenta.borrar} quitada(s)`);
    const placas = [...new Set(await Promise.all(
      [...new Set(dias.map(d => d.vehiculo_id))].slice(0, 4).map(v => placaDe(db, v))))];
    resumen = `${ops.length} cambio(s) de programación de un golpe`
      + (partes.length ? `: ${partes.join(', ')}` : '')
      + (placas.length ? ` — ${placas.join(', ')}` : '');
    cuantas = ops.length;

  } else if (patron === '/api/predeterminados' || patron === '/api/predeterminados/:id') {
    const nombre = cuerpo.nombre
      || (await db.prepare('SELECT nombre FROM itinerario_predeterminados WHERE id = ?')
            .bind(params.id).first() || {}).nombre
      || `#${params.id}`;
    resumen = `${metodo === 'POST' ? 'Crear' : 'Cambiar'} el predeterminado «${nombre}»`;

  } else if (clave === 'PUT /api/eventos/:id') {
    const e = await db.prepare(`
      SELECT e.*, v.placa FROM eventos e
      LEFT JOIN vehiculos v ON v.id = e.vehiculo_id WHERE e.id = ?`).bind(params.id).first();
    if (!e) throw noEncontrado('Novedad no encontrada');
    resumen = `Cambiar la novedad #${params.id} de ${e.placa || 'un vehículo'}`
      + (e.fecha ? ` del ${e.fecha}` : '');
    if (e.fecha && e.vehiculo_id) dias.push({ fecha: e.fecha, vehiculo_id: e.vehiculo_id });

  } else if (patron === '/api/fuera-servicio' || patron === '/api/fuera-servicio/:id') {
    const antes = metodo === 'PUT'
      ? await db.prepare('SELECT * FROM fuera_servicio WHERE id = ?').bind(params.id).first()
      : null;
    if (metodo === 'PUT' && !antes) throw noEncontrado('Período no encontrado');
    if (cuerpo.causa && !CAUSAS.includes(cuerpo.causa)) throw malaPeticion('Causa no válida');
    const vehiculoId = cuerpo.vehiculo_id || (antes && antes.vehiculo_id);
    const inicio = cuerpo.fecha_inicio || (antes && antes.fecha_inicio);
    const fin = cuerpo.fecha_fin !== undefined ? cuerpo.fecha_fin : (antes && antes.fecha_fin);
    const placa = await placaDe(db, vehiculoId);
    resumen = `${metodo === 'POST' ? 'Registrar' : 'Cambiar el período'} fuera de servicio `
      + `de ${placa}, desde el ${inicio}` + (fin ? ` hasta el ${fin}` : ' (sigue parado)');
    desde = inicio || null;
    hasta = fin || null;

  } else if (clave === 'POST /api/catalogos/destinos') {
    if (!cuerpo.nombre) throw malaPeticion('El nombre del destino es obligatorio');
    resumen = `Crear el destino «${cuerpo.nombre}»`;
  }

  // Los días los fija la operación; el rango solo se deduce de ellos cuando la
  // propia ruta no lo trajo (fuera de servicio sí lo trae, y es un intervalo).
  if (dias.length) {
    const fechas = dias.map(d => d.fecha).filter(Boolean).sort();
    desde = fechas[0] || null;
    hasta = fechas[fechas.length - 1] || null;
    if (cuantas === 1) cuantas = new Set(dias.map(d => `${d.fecha}|${d.vehiculo_id}`)).size;
  }
  return { resumen, dias, desde, hasta, cuantas };
}

/**
 * Guarda la petición sin aplicarla y la deja esperando al administrador.
 *
 * Devuelve lo que verá quien la pidió. El `pendiente: true` es la señal que la
 * aplicación usa para decir «se envió a aprobación» en vez de «guardado»: sin
 * él la coordinación creería que su cambio quedó hecho.
 */
async function registrarSolicitud(db, sesion, { metodo, patron, ruta, params, cuerpo, url }) {
  await asegurarEsquema(db);
  const d = await describirSolicitud(db, metodo, patron, params || {}, cuerpo || {}, url);

  // Un día con solicitud pendiente no admite otra. Sin esto, el pincel o un
  // segundo toque dejan al administrador dos peticiones contradictorias sobre
  // la misma celda y la segunda falla al aplicarse, cuando ya no hay nadie
  // mirando.
  if (d.dias.length) {
    const choques = [];
    for (const x of d.dias) {
      const y = await db.prepare(`
        SELECT s.id FROM solicitud_dias sd JOIN solicitudes s ON s.id = sd.solicitud_id
         WHERE sd.fecha = ? AND sd.vehiculo_id = ? AND s.estado = 'pendiente'
         LIMIT 1`).bind(x.fecha, x.vehiculo_id).first();
      if (y) choques.push(`${x.fecha} (${await placaDe(db, x.vehiculo_id)})`);
    }
    if (choques.length) {
      throw malaPeticion(
        'Ya hay una solicitud esperando aprobación para ' +
        choques.slice(0, 3).join(', ') +
        (choques.length > 3 ? ` y ${choques.length - 3} día(s) más` : '') +
        '. Espere la respuesta del administrador o pídale que la resuelva.');
    }
  }

  // Una solicitud para una fecha que ya pasó no se puede aplicar, pero la que
  // se pide HOY vive al menos hoy: si naciera vencida, cancelar la
  // programación de ayer sería imposible de pedir.
  const hoy = hoyISO();
  const vence = d.hasta && d.hasta > hoy ? d.hasta : hoy;

  const r = await db.prepare(`
    INSERT INTO solicitudes (ts, solicitante_id, metodo, patron, ruta, params, cuerpo,
                             resumen, afecta_desde, afecta_hasta, cuantas, vence_el, estado)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pendiente')`)
    .bind(ahora(), sesion.id, metodo, patron, ruta,
          JSON.stringify(params || {}), JSON.stringify(cuerpo || {}),
          d.resumen, d.desde, d.hasta, d.cuantas, vence).run();
  const id = r.meta.last_row_id;

  for (const x of d.dias) {
    if (!x.fecha || !x.vehiculo_id) continue;
    await db.prepare(
      'INSERT INTO solicitud_dias (solicitud_id, fecha, vehiculo_id) VALUES (?,?,?)')
      .bind(id, x.fecha, x.vehiculo_id).run();
  }

  await auditar(db, sesion, 'solicitar', 'solicitudes', id, null,
                { resumen: d.resumen, ruta, cuantas: d.cuantas });
  return {
    pendiente: true, solicitud: id, resumen: d.resumen,
    cuantas: d.cuantas, vence_el: vence,
  };
}

/**
 * Vence sola la solicitud cuyo día ya pasó.
 *
 * No hay tarea programada en el Worker, así que se hace al leer la bandeja:
 * es la única pantalla donde el estado importa, y el coste es un UPDATE que
 * casi siempre no toca nada. Lo vencido NO se borra — queda el rastro de que
 * se pidió y no se contestó, que es justo lo que hay que poder demostrar.
 */
async function vencerSolicitudes(db) {
  await asegurarEsquema(db);
  await db.prepare(`
    UPDATE solicitudes SET estado = 'vencida', resuelto_en = ?
     WHERE estado = 'pendiente' AND vence_el IS NOT NULL AND vence_el < ?`)
    .bind(ahora(), hoyISO()).run();
}

// ════════════════════════════════════════════════════════════════════════
// estadistica.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — las cifras de la operación, en un solo sitio
 *
 * Aquí viven los agregados que leen el Dashboard y el informe estadístico
 * firmado (D42). Están juntos a propósito: un informe que alguien firma y un
 * tablero que alguien mira NO pueden dar números distintos del mismo período.
 * Si cada uno tuviera su propia consulta, el día que se corrija una se
 * corregiría solo en un sitio, y la diferencia aparecería en una auditoría —
 * encima de un papel con una firma.
 *
 * El mismo principio que ya gobierna `dias_operacion`: una sola fuente para
 * cada cifra.
 */

/**
 * Añade los filtros de enfoque (D37) a una consulta.
 * @param cols  cómo se llaman las columnas de conductor y vehículo en ESA
 *              consulta; se omite la que la tabla no tenga.
 */
const enfoque = (conductorId, vehiculoId) => (cols) => {
  const partes = [], args = [];
  if (conductorId && cols.conductor) { partes.push(`AND ${cols.conductor} = ?`); args.push(conductorId); }
  if (vehiculoId && cols.vehiculo) { partes.push(`AND ${cols.vehiculo} = ?`); args.push(vehiculoId); }
  return { sql: partes.join(' '), args };
};

/**
 * Operación por vehículo.
 *
 * El filtro de conductor entra en el JOIN, no en el WHERE: así los vehículos
 * que esa persona no condujo salen en cero en vez de desaparecer de la lista.
 */
async function porVehiculo(db, desde, hasta, filtro, vehiculoId) {
  const f = filtro({ conductor: 'd.conductor_id' });
  const r = await db.prepare(`
    SELECT v.id, v.placa, v.tipo, v.propiedad, v.contratista, v.valor_dia,
           COUNT(d.id)                                    AS dias_registrados,
           SUM(d.programado)                              AS dias_programados,
           SUM(d.ejecutado)                               AS dias_con_desplazamiento,
           SUM(d.dia_pagable)                             AS dias_pagables,
           SUM(d.num_trayectos)                           AS trayectos,
           ROUND(SUM(d.horas_operacion), 1)               AS horas,
           SUM(d.km_dia)                                  AS km,
           ROUND(SUM(d.dia_pagable) * IFNULL(v.valor_dia, 0), 0) AS valor_estimado
      FROM vehiculos v
      LEFT JOIN dias_operacion d
             ON d.vehiculo_id = v.id AND d.fecha BETWEEN ? AND ? ${f.sql}
     WHERE v.activo = 1 ${vehiculoId ? 'AND v.id = ?' : ''}
     GROUP BY v.id
     ORDER BY dias_con_desplazamiento DESC, dias_pagables DESC`)
    .bind(desde, hasta, ...f.args, ...(vehiculoId ? [vehiculoId] : [])).all();
  return r.results;
}

/**
 * Operación por conductor, con la calidad de su registro al lado.
 *
 * Lo básico sale de dias_operacion, igual que para los vehículos, para que las
 * dos tablas cuenten lo mismo. La calidad NO mide a la persona como
 * trabajador: mide cómo está usando la aplicación, y sirve para saber a quién
 * reforzarle la capacitación.
 *
 * «Sin GPS» cuenta la salida sin ubicación y, solo en los viajes cerrados,
 * también la llegada: en uno abierto la llegada falta porque todavía no ha
 * ocurrido, no porque el GPS fallara.
 */
async function porConductor(db, desde, hasta, filtro, conductorId) {
  const f = filtro({ vehiculo: 'd.vehiculo_id' });
  const base = await db.prepare(`
    SELECT p.id, p.nombres || ' ' || IFNULL(p.apellidos,'') AS conductor,
           p.nombres, p.apellidos,
           SUM(d.programado)                AS dias_programados,
           SUM(d.ejecutado)                 AS dias_con_desplazamiento,
           SUM(d.dia_pagable)               AS dias_pagables,
           SUM(d.num_trayectos)             AS trayectos,
           ROUND(SUM(d.horas_operacion), 1) AS horas,
           SUM(d.km_dia)                    AS km
      FROM personas p
      LEFT JOIN dias_operacion d
             ON d.conductor_id = p.id AND d.fecha BETWEEN ? AND ? ${f.sql}
     WHERE p.es_conductor = 1 AND p.activo = 1 ${conductorId ? 'AND p.id = ?' : ''}
     GROUP BY p.id
     ORDER BY dias_con_desplazamiento DESC, dias_pagables DESC`)
    .bind(desde, hasta, ...f.args, ...(conductorId ? [conductorId] : [])).all();

  const fCal = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const calidad = await db.prepare(`
    SELECT t.conductor_id AS id,
           SUM(CASE WHEN t.lat_salida IS NULL THEN 1 ELSE 0 END)
         + SUM(CASE WHEN t.estado = 'cerrado' AND t.lat_llegada IS NULL THEN 1 ELSE 0 END) AS sin_gps,
           SUM(CASE WHEN t.origen_salida = 'offline_sincronizado' THEN 1 ELSE 0 END) AS sin_senal,
           SUM(CASE WHEN t.estado = 'en_curso' THEN 1 ELSE 0 END) AS abiertos
      FROM trayectos t
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado' ${fCal.sql}
     GROUP BY t.conductor_id`).bind(desde, hasta, ...fCal.args).all();

  // Novedades POR QUIEN LAS REPORTA. Muchas novedades no es mala señal: suele
  // ser quien mejor reporta. Se muestra como actividad, no como problema.
  const fNov = filtro({ conductor: 'persona_id', vehiculo: 'vehiculo_id' });
  const novedades = await db.prepare(`
    SELECT persona_id AS id, COUNT(*) AS n FROM eventos
     WHERE date(ts_evento) BETWEEN ? AND ? AND persona_id IS NOT NULL ${fNov.sql}
     GROUP BY persona_id`).bind(desde, hasta, ...fNov.args).all();

  // Checklist por quien lo diligenció. Se llega al conductor a través del
  // trayecto: uno sin trayecto asociado no se puede atribuir y no entra aquí.
  const fChk = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const chk = await db.prepare(`
    SELECT t.conductor_id AS id, COUNT(c.id) AS total, SUM(c.completo) AS completos
      FROM checklists c JOIN trayectos t ON t.id = c.trayecto_id
     WHERE date(c.ts) BETWEEN ? AND ? ${fChk.sql}
     GROUP BY t.conductor_id`).bind(desde, hasta, ...fChk.args).all();

  // Se juntan en memoria y no con tres LEFT JOIN: son tres agregados por
  // caminos distintos y mezclarlos en una sola consulta multiplica las filas.
  const porId = (filas) => new Map(filas.map(x => [x.id, x]));
  const mCal = porId(calidad.results), mNov = porId(novedades.results),
        mChk = porId(chk.results);
  return base.results.map(c => ({
    ...c,
    sin_gps: mCal.get(c.id)?.sin_gps || 0,
    sin_senal: mCal.get(c.id)?.sin_senal || 0,
    abiertos: mCal.get(c.id)?.abiertos || 0,
    novedades: mNov.get(c.id)?.n || 0,
    checklists: mChk.get(c.id)?.total || 0,
    checklists_completos: mChk.get(c.id)?.completos || 0,
  }));
}

/** Los totales del período: lo que encabeza el tablero y el informe. */
async function totalesOperacion(db, desde, hasta, filtro) {
  const f = filtro({ conductor: 'conductor_id', vehiculo: 'vehiculo_id' });
  return await db.prepare(`
    SELECT SUM(programado) AS programados, SUM(ejecutado) AS ejecutados,
           SUM(dia_pagable) AS pagables, SUM(num_trayectos) AS trayectos,
           ROUND(SUM(horas_operacion), 1) AS horas, SUM(km_dia) AS km
      FROM dias_operacion WHERE fecha BETWEEN ? AND ? ${f.sql}`)
    .bind(desde, hasta, ...f.args).first() || {};
}

/**
 * Calidad del registro de TODA la flota, en una fila.
 *
 * Es lo que respalda que las cifras de arriba son confiables: un período con
 * la mitad de los viajes sin GPS y sin fotografía no sostiene una liquidación,
 * y el informe tiene que decirlo en vez de callarlo.
 *
 * La fotografía solo se exige donde puede existir: la de llegada se cuenta
 * como faltante únicamente en los viajes ya cerrados.
 */
async function calidadRegistro(db, desde, hasta, filtro) {
  const f = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const t = await db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN t.estado = 'cerrado' THEN 1 ELSE 0 END) AS cerrados,
           SUM(CASE WHEN t.estado = 'en_curso' THEN 1 ELSE 0 END) AS abiertos,
           SUM(CASE WHEN t.lat_salida IS NULL THEN 1 ELSE 0 END) AS salidas_sin_gps,
           SUM(CASE WHEN t.estado = 'cerrado' AND t.lat_llegada IS NULL THEN 1 ELSE 0 END)
             AS llegadas_sin_gps,
           SUM(CASE WHEN t.origen_salida = 'offline_sincronizado' THEN 1 ELSE 0 END)
             AS tomados_sin_senal,
           SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM trayecto_fotos ft
                 WHERE ft.trayecto_id = t.id AND ft.momento = 'salida') THEN 1 ELSE 0 END)
             AS salidas_sin_foto,
           SUM(CASE WHEN t.estado = 'cerrado' AND NOT EXISTS (SELECT 1 FROM trayecto_fotos ft
                 WHERE ft.trayecto_id = t.id AND ft.momento = 'llegada') THEN 1 ELSE 0 END)
             AS llegadas_sin_foto
      FROM trayectos t
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado' ${f.sql}`)
    .bind(desde, hasta, ...f.args).first();

  // Los anulados se cuentan aparte, a propósito: no entran en ninguna cifra de
  // operación, y aun así el informe debe decir cuántos hubo. Un período con
  // muchas anulaciones es una señal, y callarla sería esconderla.
  const anulados = await db.prepare(`
    SELECT COUNT(*) AS n FROM trayectos t
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado = 'anulado' ${f.sql}`)
    .bind(desde, hasta, ...f.args).first();

  const fChk = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const chk = await db.prepare(`
    SELECT COUNT(c.id) AS total, SUM(c.completo) AS completos
      FROM checklists c JOIN trayectos t ON t.id = c.trayecto_id
     WHERE date(c.ts) BETWEEN ? AND ? ${fChk.sql}`).bind(desde, hasta, ...fChk.args).first();

  return {
    ...(t || {}),
    anulados: (anulados && anulados.n) || 0,
    checklists: (chk && chk.total) || 0,
    checklists_completos: (chk && chk.completos) || 0,
  };
}

/** Viajes por municipio de llegada: a dónde fue de verdad la operación. */
async function porMunicipio(db, desde, hasta, filtro) {
  const f = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const r = await db.prepare(`
    SELECT IFNULL(m.nombre, 'Sin registrar') AS municipio, COUNT(*) AS trayectos
      FROM trayectos t
      LEFT JOIN cat_municipios m ON m.id = t.municipio_llegada_id
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado' ${f.sql}
     GROUP BY m.nombre ORDER BY trayectos DESC`).bind(desde, hasta, ...f.args).all();
  return r.results;
}

// ════════════════════════════════════════════════════════════════════════
// rutas_admin.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — rutas de administración
 * Autenticación, catálogos, vehículos, personas y usuarios.
 */

// ── Autenticación ───────────────────────────────────────────────────────────

ruta('POST', '/api/auth/login', async ({ db, cuerpo, env }) => {
  const { usuario, clave } = cuerpo;
  if (!usuario || !clave) throw malaPeticion('Usuario y clave son obligatorios');

  const u = await db.prepare(`
    SELECT u.*, p.nombres, p.apellidos
      FROM usuarios u LEFT JOIN personas p ON p.id = u.persona_id
     WHERE u.usuario = ? AND u.activo = 1`).bind(usuario.trim()).first();

  // Se verifica siempre contra un hash, exista o no el usuario, para no revelar
  // por diferencia de tiempo si el nombre de usuario existe.
  const hashReferencia = 'pbkdf2$120000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const valida = await verificarClave(clave, u ? u.clave_hash : hashReferencia);
  if (!u || !valida) throw noAutorizado('Usuario o clave incorrectos');

  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const horas = Number(env.HORAS_SESION || 12);
  const expira = new Date(Date.now() + horas * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

  await db.prepare(`
    INSERT INTO sesiones (id, usuario_id, creada_en, expira_en, user_agent)
    VALUES (?,?,?,?,?)`)
    .bind(token, u.id, ahora(), expira, '').run();
  await db.prepare('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?')
    .bind(ahora(), u.id).run();
  await auditar(db, { id: u.id, rol: u.rol }, 'ingresar', 'usuarios', u.id);

  return {
    token, expira_en: expira,
    usuario: {
      id: u.id, usuario: u.usuario, rol: u.rol, persona_id: u.persona_id,
      municipio_id: u.municipio_id, debe_cambiar_clave: !!u.debe_cambiar_clave,
      nombre: [u.nombres, u.apellidos].filter(Boolean).join(' ') || u.usuario,
    },
  };
});

ruta('POST', '/api/auth/logout', async ({ db, sesion }) => {
  await db.prepare('DELETE FROM sesiones WHERE id = ?').bind(sesion.token).run();
  return { ok: true };
}, ['principal', 'coordinacion', 'conductor']);

ruta('GET', '/api/auth/yo', async ({ sesion }) => ({
  id: sesion.id, usuario: sesion.usuario, rol: sesion.rol,
  persona_id: sesion.persona_id, municipio_id: sesion.municipio_id,
  debe_cambiar_clave: !!sesion.debe_cambiar_clave,
  nombre: [sesion.nombres, sesion.apellidos].filter(Boolean).join(' ') || sesion.usuario,
}), ['principal', 'coordinacion', 'conductor']);

ruta('POST', '/api/auth/cambiar-clave', async ({ db, sesion, cuerpo }) => {
  const { clave_actual, clave_nueva } = cuerpo;
  if (!clave_nueva || clave_nueva.length < 8) {
    throw malaPeticion('La clave nueva debe tener al menos 8 caracteres');
  }
  const u = await db.prepare('SELECT clave_hash FROM usuarios WHERE id = ?')
    .bind(sesion.id).first();
  if (!await verificarClave(clave_actual || '', u.clave_hash)) {
    throw noAutorizado('La clave actual no es correcta');
  }
  await db.prepare(
    'UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 0 WHERE id = ?')
    .bind(await hashClave(clave_nueva), sesion.id).run();
  await auditar(db, sesion, 'editar', 'usuarios', sesion.id, null, { clave: 'cambiada' });
  return { ok: true };
}, ['principal', 'coordinacion', 'conductor']);

// ── Catálogos ───────────────────────────────────────────────────────────────

ruta('GET', '/api/catalogos', async ({ db }) => {
  const [municipios, destinos, ips] = await Promise.all([
    db.prepare(`SELECT m.*, p.nombre AS municipio_padre
                  FROM cat_municipios m
                  LEFT JOIN cat_municipios p ON p.id = m.municipio_padre_id
                 WHERE m.activo = 1 ORDER BY m.nombre`).all(),
    db.prepare(`SELECT d.*, m.nombre AS municipio
                  FROM cat_destinos d
                  LEFT JOIN cat_municipios m ON m.id = d.municipio_id
                 WHERE d.activo = 1
                 ORDER BY d.veces_usado DESC, d.nombre`).all(),
    db.prepare('SELECT * FROM cat_ips WHERE activo = 1 ORDER BY nombre').all(),
  ]);
  return { municipios: municipios.results, destinos: destinos.results, ips: ips.results };
}, ['principal', 'coordinacion', 'conductor']);

ruta('POST', '/api/catalogos/municipios', async ({ db, sesion, cuerpo }) => {
  const { nombre, codigo_dane, municipio_padre_id, es_base } = cuerpo;
  if (!nombre) throw malaPeticion('El nombre es obligatorio');
  const r = await db.prepare(`
    INSERT INTO cat_municipios (nombre, codigo_dane, municipio_padre_id, es_base,
                                activo, creado_en)
    VALUES (?,?,?,?,1,?)`)
    .bind(nombre.trim().toUpperCase(), codigo_dane || null,
          municipio_padre_id || null, es_base ? 1 : 0, ahora()).run();
  await auditar(db, sesion, 'crear', 'cat_municipios', r.meta.last_row_id, null, cuerpo);
  return { id: r.meta.last_row_id };
}, ['principal']);

ruta('PUT', '/api/catalogos/municipios/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM cat_municipios WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Municipio no encontrado');
  await db.prepare(`
    UPDATE cat_municipios
       SET nombre = ?, codigo_dane = ?, municipio_padre_id = ?, es_base = ?,
           activo = ?, actualizado_por = ?, actualizado_en = ?
     WHERE id = ?`)
    .bind(cuerpo.nombre != null ? cuerpo.nombre.trim().toUpperCase() : antes.nombre,
          cuerpo.codigo_dane !== undefined ? cuerpo.codigo_dane : antes.codigo_dane,
          cuerpo.municipio_padre_id !== undefined ? cuerpo.municipio_padre_id : antes.municipio_padre_id,
          cuerpo.es_base !== undefined ? (cuerpo.es_base ? 1 : 0) : antes.es_base,
          cuerpo.activo !== undefined ? (cuerpo.activo ? 1 : 0) : antes.activo,
          sesion.id, ahora(), params.id).run();
  await auditar(db, sesion, 'editar', 'cat_municipios', params.id, antes, cuerpo);
  return { ok: true };
}, ['principal']);

// Coordinación también crea destinos: se crean AL ADJUDICAR el desplazamiento (D12).
ruta('POST', '/api/catalogos/destinos', async ({ db, sesion, cuerpo }) => {
  const { nombre, municipio_id, tipo } = cuerpo;
  if (!nombre) throw malaPeticion('El nombre del destino es obligatorio');
  const id = await resolverDestino(db, nombre, municipio_id, tipo, sesion.id);
  await auditar(db, sesion, 'crear', 'cat_destinos', id, null, cuerpo);
  return { id };
}, ['principal', 'coordinacion']);

/**
 * Un destino ya usado NUNCA se borra: se desactiva. Si se eliminara, los
 * itinerarios y trayectos históricos quedarían apuntando al vacío y las
 * liquidaciones ya cerradas dejarían de cuadrar.
 */
ruta('DELETE', '/api/catalogos/destinos/:id', async ({ db, sesion, params }) => {
  await db.prepare('UPDATE cat_destinos SET activo = 0 WHERE id = ?').bind(params.id).run();
  await auditar(db, sesion, 'editar', 'cat_destinos', params.id, null, { activo: 0 });
  return { ok: true, nota: 'Destino desactivado, no eliminado' };
}, ['principal']);

/**
 * Fija el conductor predeterminado de un vehículo.
 *
 * No se reescribe la asignación anterior: se le pone fecha de cierre y se abre
 * una nueva. Así queda la historia de quién manejó qué y desde cuándo, que es
 * lo que permite explicar un trayecto de hace tres meses.
 *
 * Pasar personaId nulo deja el vehículo sin conductor asignado.
 */
async function asignarConductor(db, vehiculoId, personaId, sesion) {
  const actual = await db.prepare(`
    SELECT id, persona_id FROM asignaciones
     WHERE vehiculo_id = ? AND rol = 'conductor' AND hasta IS NULL
     ORDER BY desde DESC, id DESC LIMIT 1`).bind(vehiculoId).first();

  if (actual && Number(actual.persona_id) === Number(personaId)) return;   // sin cambio

  const hoy = hoyISO();
  if (actual) {
    await db.prepare('UPDATE asignaciones SET hasta = ? WHERE id = ?')
      .bind(hoy, actual.id).run();
  }
  if (personaId) {
    await db.prepare(`
      INSERT INTO asignaciones (vehiculo_id, persona_id, rol, desde, creado_por, creado_en)
      VALUES (?,?, 'conductor', ?,?,?)`)
      .bind(vehiculoId, personaId, hoy, sesion.id, ahora()).run();
  }
  await auditar(db, sesion, 'editar', 'asignaciones', vehiculoId,
                { conductor_anterior: actual ? actual.persona_id : null },
                { conductor_nuevo: personaId || null });
}

// ── Vehículos ───────────────────────────────────────────────────────────────

ruta('GET', '/api/vehiculos', async ({ db, url }) => {
  const todos = url.searchParams.get('todos') === '1';
  const r = await db.prepare(`
    SELECT v.*, m.nombre AS municipio_base,
           (SELECT COUNT(*) FROM documentos_vehiculo dv
             WHERE dv.vehiculo_id = v.id AND dv.vencimiento < date('now')) AS docs_vencidos,
           (SELECT group_concat(dv.tipo, ', ') FROM documentos_vehiculo dv
             WHERE dv.vehiculo_id = v.id AND dv.vencimiento < date('now')) AS docs_vencidos_tipos,
           (SELECT p.nombres || ' ' || IFNULL(p.apellidos,'')
              FROM asignaciones a JOIN personas p ON p.id = a.persona_id
             WHERE a.vehiculo_id = v.id AND a.rol = 'conductor'
               AND (a.hasta IS NULL OR a.hasta >= date('now'))
             ORDER BY a.desde DESC, a.id DESC LIMIT 1) AS conductor_actual,
           (SELECT a.persona_id FROM asignaciones a
             WHERE a.vehiculo_id = v.id AND a.rol = 'conductor' AND a.hasta IS NULL
             ORDER BY a.desde DESC, a.id DESC LIMIT 1) AS conductor_id
      FROM vehiculos v
      LEFT JOIN cat_municipios m ON m.id = v.municipio_base_id
     ${todos ? '' : 'WHERE v.activo = 1'}
     ORDER BY v.placa`).all();
  return r.results;
}, ['principal', 'coordinacion', 'conductor']);

ruta('POST', '/api/vehiculos', async ({ db, sesion, cuerpo }) => {
  if (!cuerpo.placa) throw malaPeticion('La placa es obligatoria');
  const r = await db.prepare(`
    INSERT INTO vehiculos (placa, numero_interno, tipo, subtipo, marca, linea,
                           modelo_anio, color, capacidad, municipio_base_id,
                           propiedad, contratista, valor_dia, estado, km_actual,
                           qr_token, activo, creado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .bind(cuerpo.placa.trim().toUpperCase(), cuerpo.numero_interno || null,
          cuerpo.tipo || 'camioneta', cuerpo.subtipo || null, cuerpo.marca || null,
          cuerpo.linea || null, cuerpo.modelo_anio || null, cuerpo.color || null,
          cuerpo.capacidad || null, cuerpo.municipio_base_id || null,
          cuerpo.propiedad || 'propio', cuerpo.contratista || null,
          cuerpo.valor_dia || null, cuerpo.estado || 'activo',
          cuerpo.km_actual || null, crypto.randomUUID(), ahora()).run();
  if (cuerpo.conductor_id) {
    await asignarConductor(db, r.meta.last_row_id, cuerpo.conductor_id, sesion);
  }
  await auditar(db, sesion, 'crear', 'vehiculos', r.meta.last_row_id, null, cuerpo);
  return { id: r.meta.last_row_id };
}, ['principal']);

ruta('PUT', '/api/vehiculos/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM vehiculos WHERE id = ?').bind(params.id).first();
  if (!antes) throw noEncontrado('Vehículo no encontrado');
  const campos = ['numero_interno', 'tipo', 'subtipo', 'marca', 'linea', 'modelo_anio',
    'color', 'capacidad', 'municipio_base_id', 'propiedad', 'contratista',
    'valor_dia', 'estado', 'km_actual', 'activo'];
  const set = [], valores = [];
  for (const c of campos) {
    if (cuerpo[c] !== undefined) { set.push(`${c} = ?`); valores.push(cuerpo[c]); }
  }
  if (set.length) {
    valores.push(params.id);
    await db.prepare(`UPDATE vehiculos SET ${set.join(', ')} WHERE id = ?`).bind(...valores).run();
  }
  if (cuerpo.conductor_id !== undefined) {
    await asignarConductor(db, Number(params.id), cuerpo.conductor_id, sesion);
  }
  await auditar(db, sesion, 'editar', 'vehiculos', params.id, antes, cuerpo);
  return { ok: true };
}, ['principal']);

// ── Personas ────────────────────────────────────────────────────────────────

ruta('GET', '/api/personas', async ({ db, url }) => {
  const soloConductores = url.searchParams.get('conductores') === '1';
  const r = await db.prepare(`
    SELECT p.*, m.nombre AS municipio,
           (SELECT COUNT(*) FROM documentos_persona dp
             WHERE dp.persona_id = p.id AND dp.vencimiento < date('now')) AS docs_vencidos,
           (SELECT group_concat(dp.tipo, ', ') FROM documentos_persona dp
             WHERE dp.persona_id = p.id AND dp.vencimiento < date('now')) AS docs_vencidos_tipos
      FROM personas p
      LEFT JOIN cat_municipios m ON m.id = p.municipio_id
     WHERE p.activo = 1 ${soloConductores ? 'AND p.es_conductor = 1' : ''}
     ORDER BY p.nombres, p.apellidos`).all();
  return r.results;
}, ['principal', 'coordinacion']);

ruta('POST', '/api/personas', async ({ db, sesion, cuerpo }) => {
  if (!cuerpo.nombres) throw malaPeticion('El nombre es obligatorio');
  const r = await db.prepare(`
    INSERT INTO personas (tipo_doc, numero_doc, nombres, apellidos, telefono, correo,
                          cargo, vinculacion, municipio_id, territorio,
                          es_conductor, es_tripulante, activo, creado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .bind(cuerpo.tipo_doc || 'CC', cuerpo.numero_doc || null,
          cuerpo.nombres.trim(), cuerpo.apellidos || null, cuerpo.telefono || null,
          cuerpo.correo || null, cuerpo.cargo || 'CONDUCTOR',
          cuerpo.vinculacion || null, cuerpo.municipio_id || null,
          cuerpo.territorio || null,
          cuerpo.es_conductor ? 1 : 0, cuerpo.es_tripulante ? 1 : 0, ahora()).run();
  await auditar(db, sesion, 'crear', 'personas', r.meta.last_row_id, null,
                { nombres: cuerpo.nombres });   // no se audita el documento
  return { id: r.meta.last_row_id };
}, ['principal']);

ruta('PUT', '/api/personas/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM personas WHERE id = ?').bind(params.id).first();
  if (!antes) throw noEncontrado('Persona no encontrada');
  const campos = ['tipo_doc', 'numero_doc', 'nombres', 'apellidos', 'telefono', 'correo',
    'cargo', 'vinculacion', 'municipio_id', 'territorio', 'es_conductor',
    'es_tripulante', 'activo'];
  const set = [], valores = [];
  for (const c of campos) {
    if (cuerpo[c] !== undefined) { set.push(`${c} = ?`); valores.push(cuerpo[c]); }
  }
  if (!set.length) return { ok: true, sin_cambios: true };
  valores.push(params.id);
  await db.prepare(`UPDATE personas SET ${set.join(', ')} WHERE id = ?`).bind(...valores).run();
  await auditar(db, sesion, 'editar', 'personas', params.id, { id: antes.id }, { campos: set });
  return { ok: true };
}, ['principal']);

// ── Usuarios (solo el rol principal) ────────────────────────────────────────

ruta('GET', '/api/usuarios', async ({ db }) => {
  const r = await db.prepare(`
    SELECT u.id, u.usuario, u.correo, u.rol, u.activo, u.debe_cambiar_clave,
           u.ultimo_acceso, u.creado_en, u.persona_id,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS nombre,
           CASE WHEN u.rol = 'conductor' AND u.persona_id IS NULL THEN 1 ELSE 0 END
             AS sin_persona,
           m.nombre AS municipio
      FROM usuarios u
      LEFT JOIN personas p ON p.id = u.persona_id
      LEFT JOIN cat_municipios m ON m.id = u.municipio_id
     ORDER BY u.rol, u.usuario`).all();
  return r.results;
}, ['principal']);

ruta('POST', '/api/usuarios', async ({ db, sesion, cuerpo }) => {
  const { usuario, clave, rol, persona_id, correo, municipio_id } = cuerpo;
  if (!usuario || !clave) throw malaPeticion('Usuario y clave temporal son obligatorios');
  if (!['principal', 'coordinacion', 'conductor'].includes(rol)) {
    throw malaPeticion('Rol no válido: principal, coordinacion o conductor');
  }
  if (clave.length < 8) throw malaPeticion('La clave temporal debe tener al menos 8 caracteres');

  // Sin este vínculo la cuenta del conductor entra pero no ve nada: el
  // itinerario se busca por persona, no por usuario. Antes se permitía crearla
  // y el fallo aparecía después, en terreno y sin mensaje.
  if (rol === 'conductor' && !persona_id) {
    throw malaPeticion(
      'Una cuenta de conductor debe quedar vinculada a una persona: ' +
      'es lo que la conecta con su itinerario. Regístrela primero en Personas.');
  }

  const r = await db.prepare(`
    INSERT INTO usuarios (persona_id, usuario, correo, clave_hash, rol, municipio_id,
                          activo, debe_cambiar_clave, creado_por, creado_en)
    VALUES (?,?,?,?,?,?,1,1,?,?)`)
    .bind(persona_id || null, usuario.trim().toLowerCase(), correo || null,
          await hashClave(clave), rol, municipio_id || null, sesion.id, ahora()).run();
  await auditar(db, sesion, 'crear', 'usuarios', r.meta.last_row_id, null,
                { usuario, rol });   // la clave nunca se audita
  return { id: r.meta.last_row_id };
}, ['principal']);

ruta('PUT', '/api/usuarios/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM usuarios WHERE id = ?').bind(params.id).first();
  if (!antes) throw noEncontrado('Usuario no encontrado');

  // No se permite que el último usuario principal activo se desactive o cambie de rol:
  // dejaría el sistema sin nadie capaz de crear usuarios.
  const quitaPrincipal = (cuerpo.activo === 0 || cuerpo.activo === false) ||
                         (cuerpo.rol && cuerpo.rol !== 'principal');
  if (antes.rol === 'principal' && quitaPrincipal) {
    const otros = await db.prepare(
      "SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'principal' AND activo = 1 AND id != ?")
      .bind(params.id).first();
    if (!otros.n) throw malaPeticion('Debe existir al menos un usuario principal activo');
  }

  const rolFinal = cuerpo.rol || antes.rol;
  const personaFinal = cuerpo.persona_id !== undefined ? cuerpo.persona_id : antes.persona_id;
  if (rolFinal === 'conductor' && !personaFinal) {
    throw malaPeticion(
      'Una cuenta de conductor debe quedar vinculada a una persona: ' +
      'es lo que la conecta con su itinerario.');
  }

  const set = [], valores = [];
  for (const c of ['usuario', 'correo', 'rol', 'persona_id', 'municipio_id', 'activo']) {
    if (cuerpo[c] !== undefined) { set.push(`${c} = ?`); valores.push(cuerpo[c]); }
  }
  if (cuerpo.clave) {
    if (cuerpo.clave.length < 8) throw malaPeticion('La clave debe tener al menos 8 caracteres');
    set.push('clave_hash = ?', 'debe_cambiar_clave = 1');
    valores.push(await hashClave(cuerpo.clave));
    // Al restablecer la clave se cierran las sesiones abiertas de ese usuario.
    await db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').bind(params.id).run();
  }
  if (!set.length) return { ok: true, sin_cambios: true };
  valores.push(params.id);
  await db.prepare(`UPDATE usuarios SET ${set.join(', ')} WHERE id = ?`).bind(...valores).run();
  await auditar(db, sesion, 'editar', 'usuarios', params.id,
                { usuario: antes.usuario, rol: antes.rol, activo: antes.activo },
                { campos: set.filter(s => !s.startsWith('clave')) });
  return { ok: true };
}, ['principal']);

// ── Banner institucional ────────────────────────────────────────────────────

/**
 * Público a propósito: el banner se muestra en la pantalla de ingreso, antes de
 * que exista una sesión. Es una imagen institucional, no un dato reservado.
 */
ruta('GET', '/api/banner', async ({ db }) => {
  const b = await db.prepare(
    "SELECT mime, datos, ancho, alto, bytes, actualizado_en FROM config_imagenes WHERE clave = 'banner'")
    .first();
  return b || { vacio: true };
});

ruta('PUT', '/api/banner', async ({ db, sesion, cuerpo }) => {
  const { mime, datos } = cuerpo;
  if (!mime || !datos) throw malaPeticion('Falta la imagen');
  if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
    throw malaPeticion('El banner debe ser PNG, JPG o WEBP');
  }
  // El navegador ya la redimensiona y comprime; este tope es la última defensa
  // para que una imagen enorme no haga fallar la escritura en la base.
  const bytes = Math.floor(datos.length * 3 / 4);
  if (bytes > 1_500_000) {
    throw malaPeticion('La imagen pesa demasiado, incluso comprimida (máximo 1,5 MB)');
  }

  await db.prepare(`
    INSERT INTO config_imagenes (clave, mime, datos, ancho, alto, bytes,
                                 actualizado_por, actualizado_en)
    VALUES ('banner', ?,?,?,?,?,?,?)
    ON CONFLICT (clave) DO UPDATE SET
      mime = excluded.mime, datos = excluded.datos, ancho = excluded.ancho,
      alto = excluded.alto, bytes = excluded.bytes,
      actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en`)
    .bind(mime, datos, cuerpo.ancho || null, cuerpo.alto || null, bytes,
          sesion.id, ahora()).run();
  await auditar(db, sesion, 'editar', 'config_imagenes', null, null,
                { clave: 'banner', bytes, ancho: cuerpo.ancho, alto: cuerpo.alto });
  return { ok: true, bytes };
}, ['principal']);

ruta('DELETE', '/api/banner', async ({ db, sesion }) => {
  await db.prepare("DELETE FROM config_imagenes WHERE clave = 'banner'").run();
  await auditar(db, sesion, 'eliminar', 'config_imagenes', null, { clave: 'banner' }, null);
  return { ok: true };
}, ['principal']);

// ════════════════════════════════════════════════════════════════════════
// rutas_operacion.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — rutas de operación
 * Itinerario, trayectos con GPS, checklist, eventos, días y dashboard.
 */

/**
 * Sello del estado de los datos, para que las pantallas abiertas sepan si algo
 * cambió sin volver a descargarlo todo.
 *
 * Se apoya en la auditoría, que registra toda modificación, y se completa con
 * los conteos de itinerarios y trayectos para captar también los borrados.
 * Es una consulta de cuatro agregados: barata de repetir cada minuto.
 */
ruta('GET', '/api/sello', async ({ db }) => {
  const r = await db.prepare(`
    SELECT (SELECT IFNULL(MAX(ts), '') FROM auditoria)      AS ts,
           (SELECT COUNT(*) FROM auditoria)                 AS n,
           (SELECT COUNT(*) FROM itinerarios)               AS i,
           (SELECT COUNT(*) FROM trayectos)                 AS t`).first();
  return { sello: `${r.ts}|${r.n}|${r.i}|${r.t}`, ts: ahora() };
}, TODOS);

// ═══════════════════════════════════════════════════════ ITINERARIO ═════════

/**
 * Cuenta los viajes ya registrados para un día y vehículo.
 *
 * Se consulta antes de borrar o mover una programación: si el conductor ya
 * marcó, tocar el día descuadraría el contador de días y la liquidación sin
 * que nadie se entere. Se prefiere bloquear y explicar.
 */
async function viajesDelDia(db, fecha, vehiculoId) {
  const r = await db.prepare(`
    SELECT COUNT(*) AS n FROM trayectos
     WHERE fecha_operacion = ? AND vehiculo_id = ? AND estado != 'anulado'`)
    .bind(fecha, vehiculoId).first();
  return r ? r.n : 0;
}

/** Aplica un predeterminado sobre los campos de una programación. */
async function aplicarPredeterminado(db, id) {
  if (!id) return null;
  const p = await db.prepare(
    'SELECT * FROM itinerario_predeterminados WHERE id = ? AND activo = 1').bind(id).first();
  if (!p) throw malaPeticion('El predeterminado no existe o está desactivado');
  await db.prepare(`
    UPDATE itinerario_predeterminados
       SET veces_usado = veces_usado + 1, ultimo_uso = ? WHERE id = ?`)
    .bind(ahora(), id).run();
  return p;
}

/**
 * Totales de días programados por vehículo, de TODA la operación.
 *
 * El contador que se ve al lado de cada placa contaba los días del período
 * visible, así que cambiaba al mover la ventana: con dos semanas a la vista un
 * vehículo "tenía" 10 días y con una semana, 5. Para lo que sirve el contador
 * —comparar qué vehículos están trabajando más que otros— eso no vale: la
 * cuenta tiene que ser la general.
 *
 * Por defecto va sin límites de fecha. Se aceptan `desde` y `hasta` por si
 * algún día se quiere acotar a un año o a un contrato.
 */
ruta('GET', '/api/itinerario/resumen', async ({ db, url }) => {
  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');
  const donde = ["i.estado != 'cancelado'"];
  const args = [];
  if (desde) { donde.push('i.fecha >= ?'); args.push(desde); }
  if (hasta) { donde.push('i.fecha <= ?'); args.push(hasta); }

  const r = await db.prepare(`
    SELECT i.vehiculo_id,
           COUNT(*) AS dias,
           SUM(CASE WHEN i.tipo_jornada != 'disponible' THEN 1 ELSE 0 END) AS con_salida,
           MIN(i.fecha) AS primera, MAX(i.fecha) AS ultima
      FROM itinerarios i
     WHERE ${donde.join(' AND ')}
     GROUP BY i.vehiculo_id`).bind(...args).all();
  return { desde, hasta, vehiculos: r.results };
}, GESTION);

ruta('GET', '/api/itinerario', async ({ db, url, sesion }) => {
  const desde = url.searchParams.get('desde') || hoyISO();
  const hasta = url.searchParams.get('hasta') || desde;

  // El conductor solo ve su propia programación.
  const filtroConductor = sesion.rol === 'conductor'
    ? 'AND i.conductor_id = (SELECT persona_id FROM usuarios WHERE id = ?)' : '';
  const args = [desde, hasta];
  if (filtroConductor) args.push(sesion.id);

  const r = await db.prepare(`
    SELECT i.*,
           v.placa, v.tipo AS tipo_vehiculo, v.propiedad,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS conductor,
           m.nombre AS municipio,
           IFNULL(d.nombre, i.destino_texto) AS destino,
           (SELECT COUNT(*) FROM itinerario_cambios c WHERE c.itinerario_id = i.id) AS num_cambios,
           (SELECT COUNT(*) FROM trayectos t
             WHERE t.fecha_operacion = i.fecha AND t.vehiculo_id = i.vehiculo_id
               AND t.estado = 'cerrado') AS trayectos_cerrados
      FROM itinerarios i
      LEFT JOIN vehiculos v      ON v.id = i.vehiculo_id
      LEFT JOIN personas p       ON p.id = i.conductor_id
      LEFT JOIN cat_municipios m ON m.id = i.municipio_id
      LEFT JOIN cat_destinos d   ON d.id = i.destino_id
     WHERE i.fecha BETWEEN ? AND ? ${filtroConductor}
     ORDER BY i.fecha, v.placa`).bind(...args).all();
  return r.results;
}, TODOS);

/**
 * Adjudicar un desplazamiento (D12).
 * El municipio y el destino se registran aquí, no en un catálogo previo.
 * El municipio base del conductor NO restringe: puede ir a cualquier parte (D13).
 */
ruta('POST', '/api/itinerario', async ({ db, sesion, cuerpo }) => {
  const pre = await aplicarPredeterminado(db, cuerpo.predeterminado_id);
  if (pre) {
    cuerpo = {
      ...cuerpo,
      tipo_jornada: cuerpo.tipo_jornada || pre.tipo_jornada,
      municipio_id: cuerpo.municipio_id ?? pre.municipio_id,
      destino_id: cuerpo.destino_id ?? pre.destino_id,
      observaciones: cuerpo.observaciones ?? pre.observaciones,
    };
  }
  const { fecha, vehiculo_id, conductor_id, municipio_id, tipo_jornada } = cuerpo;
  if (!fecha || !vehiculo_id) throw malaPeticion('Fecha y vehículo son obligatorios');

  // Destino escrito a mano: se adopta o se crea sobre la marcha (D12).
  const destinoId = cuerpo.destino_id ||
    await resolverDestino(db, cuerpo.destino_nombre, municipio_id,
                          cuerpo.destino_tipo, sesion.id);

  const choque = await db.prepare(
    "SELECT id FROM itinerarios WHERE fecha = ? AND vehiculo_id = ? AND estado != 'cancelado'")
    .bind(fecha, vehiculo_id).first();
  if (choque) throw malaPeticion('Ese vehículo ya tiene programación ese día');

  if (conductor_id) {
    const ocupado = await db.prepare(`
      SELECT v.placa FROM itinerarios i JOIN vehiculos v ON v.id = i.vehiculo_id
       WHERE i.fecha = ? AND i.conductor_id = ? AND i.estado != 'cancelado'`)
      .bind(fecha, conductor_id).first();
    if (ocupado) throw malaPeticion(`Ese conductor ya está asignado a ${ocupado.placa} ese día`);
  }

  const r = await db.prepare(`
    INSERT INTO itinerarios (fecha, vehiculo_id, conductor_id, municipio_id,
                             destino_id, destino_texto, tipo_jornada, observaciones,
                             estado, creado_por, creado_en)
    VALUES (?,?,?,?,?,?,?,?,'programado',?,?)`)
    .bind(fecha, vehiculo_id, conductor_id || null, municipio_id || null,
          destinoId, cuerpo.destino_texto || null, tipo_jornada || 'ebs',
          cuerpo.observaciones || null, sesion.id, ahora()).run();

  await marcarUsoDestino(db, destinoId);
  await recalcularDia(db, fecha, vehiculo_id);
  await auditar(db, sesion, 'crear', 'itinerarios', r.meta.last_row_id, null, cuerpo);
  return { id: r.meta.last_row_id, destino_id: destinoId };
}, GESTION);

/**
 * Modificar el itinerario. Cada campo que cambia escribe en itinerario_cambios,
 * que es el historial que coordinación ve en la propia celda: quién, cuándo,
 * qué decía antes y por qué.
 */
ruta('PUT', '/api/itinerario/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM itinerarios WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Programación no encontrada');

  let destinoId = cuerpo.destino_id !== undefined ? cuerpo.destino_id : antes.destino_id;
  if (cuerpo.destino_nombre) {
    const mun = cuerpo.municipio_id !== undefined ? cuerpo.municipio_id : antes.municipio_id;
    destinoId = await resolverDestino(db, cuerpo.destino_nombre, mun,
                                      cuerpo.destino_tipo, sesion.id);
  }

  const nuevos = {
    conductor_id: cuerpo.conductor_id !== undefined ? cuerpo.conductor_id : antes.conductor_id,
    municipio_id: cuerpo.municipio_id !== undefined ? cuerpo.municipio_id : antes.municipio_id,
    destino_id: destinoId,
    tipo_jornada: cuerpo.tipo_jornada || antes.tipo_jornada,
    observaciones: cuerpo.observaciones !== undefined ? cuerpo.observaciones : antes.observaciones,
    estado: cuerpo.estado || antes.estado,
  };

  await db.prepare(`
    UPDATE itinerarios
       SET conductor_id = ?, municipio_id = ?, destino_id = ?, tipo_jornada = ?,
           observaciones = ?, estado = ?
     WHERE id = ?`)
    .bind(nuevos.conductor_id, nuevos.municipio_id, nuevos.destino_id,
          nuevos.tipo_jornada, nuevos.observaciones, nuevos.estado, params.id).run();

  // Historial visible, campo por campo
  const ts = ahora();
  for (const [campo, valor] of Object.entries(nuevos)) {
    if (String(antes[campo] ?? '') === String(valor ?? '')) continue;
    await db.prepare(`
      INSERT INTO itinerario_cambios (itinerario_id, ts, usuario_id, campo,
                                      valor_antes, valor_despues, motivo)
      VALUES (?,?,?,?,?,?,?)`)
      .bind(params.id, ts, sesion.id, campo,
            antes[campo] != null ? String(antes[campo]) : null,
            valor != null ? String(valor) : null,
            cuerpo.motivo || null).run();
  }

  await marcarUsoDestino(db, destinoId !== antes.destino_id ? destinoId : null);
  await recalcularDia(db, antes.fecha, antes.vehiculo_id);
  await auditar(db, sesion, 'editar', 'itinerarios', params.id, antes, nuevos);
  return { ok: true, destino_id: destinoId };
}, GESTION);

ruta('GET', '/api/itinerario/:id/cambios', async ({ db, params }) => {
  const r = await db.prepare(`
    SELECT c.*, u.usuario,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS nombre_usuario
      FROM itinerario_cambios c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      LEFT JOIN personas p ON p.id = u.persona_id
     WHERE c.itinerario_id = ?
     ORDER BY c.ts DESC`).bind(params.id).all();
  return r.results;
}, TODOS);

/**
 * Cancelar o borrar una programación.
 *
 * Cancelar la deja registrada con estado 'cancelado' y conserva su historial:
 * es lo que hace coordinación. Borrar la elimina de veras y solo puede hacerlo
 * el administrador, pasando ?definitivo=1.
 *
 * En ambos casos, si el conductor ya registró viajes ese día la operación se
 * bloquea: sin la programación, el contador de días y la liquidación quedarían
 * descuadrados en silencio.
 */
ruta('DELETE', '/api/itinerario/:id', async ({ db, sesion, params, cuerpo, url }) => {
  const antes = await db.prepare('SELECT * FROM itinerarios WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Programación no encontrada');

  const viajes = await viajesDelDia(db, antes.fecha, antes.vehiculo_id);
  if (viajes) {
    throw malaPeticion(
      `Ese día ya tiene ${viajes} viaje(s) registrado(s) por el conductor. ` +
      'Anule primero los viajes desde la pantalla de Trayectos.');
  }

  const definitivo = url.searchParams.get('definitivo') === '1';
  if (definitivo) {
    if (sesion.rol !== 'principal') {
      throw prohibido('Solo el administrador puede borrar definitivamente');
    }
    // El historial de cambios y los trayectos cuelgan del itinerario; al no
    // haber viajes, lo único que se pierde es su propio rastro de ediciones.
    await db.prepare('DELETE FROM itinerario_cambios WHERE itinerario_id = ?')
      .bind(params.id).run();
    await db.prepare('DELETE FROM itinerarios WHERE id = ?').bind(params.id).run();
    await recalcularDia(db, antes.fecha, antes.vehiculo_id);
    await auditar(db, sesion, 'eliminar', 'itinerarios', params.id, antes, null);
    return { ok: true, borrado: true };
  }

  await db.prepare("UPDATE itinerarios SET estado = 'cancelado' WHERE id = ?")
    .bind(params.id).run();
  await db.prepare(`
    INSERT INTO itinerario_cambios (itinerario_id, ts, usuario_id, campo,
                                    valor_antes, valor_despues, motivo)
    VALUES (?,?,?,'estado',?, 'cancelado', ?)`)
    .bind(params.id, ahora(), sesion.id, antes.estado,
          (cuerpo && cuerpo.motivo) || null).run();
  await recalcularDia(db, antes.fecha, antes.vehiculo_id);
  await auditar(db, sesion, 'anular', 'itinerarios', params.id, antes, null);
  return { ok: true, borrado: false };
}, GESTION);

/**
 * Mover o duplicar una programación arrastrándola en la matriz.
 *
 * Al soltar sobre una celda ocupada las dos se INTERCAMBIAN. Como la tabla
 * tiene UNIQUE(fecha, vehiculo_id), el intercambio pasa por un valor temporal:
 * no existe un estado intermedio válido en el que ambas ocupen la misma celda.
 *
 * No se permite mover ni duplicar sobre un día que ya tenga viajes: la marca
 * del conductor quedaría apuntando a una programación que ya no describe
 * lo que hizo.
 */
ruta('POST', '/api/itinerario/mover', async ({ db, sesion, cuerpo }) => {
  const { id, fecha, vehiculo_id, duplicar } = cuerpo;
  if (!id || !fecha || !vehiculo_id) {
    throw malaPeticion('Se requieren id, fecha y vehiculo_id de destino');
  }

  const origen = await db.prepare('SELECT * FROM itinerarios WHERE id = ?').bind(id).first();
  if (!origen) throw noEncontrado('Programación no encontrada');
  if (origen.fecha === fecha && Number(origen.vehiculo_id) === Number(vehiculo_id) && !duplicar) {
    return { ok: true, sin_cambios: true };
  }

  const destino = await db.prepare(
    "SELECT * FROM itinerarios WHERE fecha = ? AND vehiculo_id = ? AND estado != 'cancelado'")
    .bind(fecha, vehiculo_id).first();

  const viajesDestino = await viajesDelDia(db, fecha, vehiculo_id);
  if (viajesDestino) {
    throw malaPeticion('El día de destino ya tiene viajes registrados; no se puede ocupar.');
  }

  // ── Duplicar ──
  if (duplicar) {
    if (destino) throw malaPeticion('Ese día ya tiene programación. Muévala o bórrela primero.');
    const r = await db.prepare(`
      INSERT INTO itinerarios (fecha, vehiculo_id, conductor_id, municipio_id, destino_id,
                               destino_texto, tipo_jornada, observaciones, estado,
                               creado_por, creado_en)
      VALUES (?,?,?,?,?,?,?,?, 'programado', ?,?)`)
      .bind(fecha, vehiculo_id, origen.conductor_id, origen.municipio_id, origen.destino_id,
            origen.destino_texto, origen.tipo_jornada, origen.observaciones,
            sesion.id, ahora()).run();
    await recalcularDia(db, fecha, vehiculo_id);
    await auditar(db, sesion, 'crear', 'itinerarios', r.meta.last_row_id, null,
                  { duplicado_de: id, fecha, vehiculo_id });
    return { ok: true, id: r.meta.last_row_id, duplicado: true };
  }

  // ── Mover ──
  const viajesOrigen = await viajesDelDia(db, origen.fecha, origen.vehiculo_id);
  if (viajesOrigen) {
    throw malaPeticion(
      `El día de origen ya tiene ${viajesOrigen} viaje(s) registrado(s); no se puede mover.`);
  }

  const fechaOrigen = origen.fecha, vehiculoOrigen = origen.vehiculo_id;

  if (destino) {
    // Intercambio en tres pasos: el temporal evita chocar con UNIQUE.
    const TEMP = '1900-01-01';
    await db.prepare('UPDATE itinerarios SET fecha = ? WHERE id = ?').bind(TEMP, origen.id).run();
    await db.prepare('UPDATE itinerarios SET fecha = ?, vehiculo_id = ? WHERE id = ?')
      .bind(fechaOrigen, vehiculoOrigen, destino.id).run();
    await db.prepare('UPDATE itinerarios SET fecha = ?, vehiculo_id = ? WHERE id = ?')
      .bind(fecha, vehiculo_id, origen.id).run();
    await registrarMovimiento(db, sesion, destino.id, destino.fecha, destino.vehiculo_id,
                              fechaOrigen, vehiculoOrigen, cuerpo.motivo);
  } else {
    await db.prepare('UPDATE itinerarios SET fecha = ?, vehiculo_id = ? WHERE id = ?')
      .bind(fecha, vehiculo_id, origen.id).run();
  }

  await registrarMovimiento(db, sesion, origen.id, fechaOrigen, vehiculoOrigen,
                            fecha, vehiculo_id, cuerpo.motivo);

  for (const [f, v] of [[fechaOrigen, vehiculoOrigen], [fecha, vehiculo_id]]) {
    await recalcularDia(db, f, v);
  }
  await auditar(db, sesion, 'editar', 'itinerarios', origen.id,
                { fecha: fechaOrigen, vehiculo_id: vehiculoOrigen },
                { fecha, vehiculo_id, intercambio: !!destino });
  return { ok: true, intercambio: !!destino };
}, GESTION);

/** Deja el movimiento en el historial visible de la celda. */
async function registrarMovimiento(db, sesion, itinerarioId, fAntes, vAntes, fDespues, vDespues, motivo) {
  const ts = ahora();
  if (fAntes !== fDespues) {
    await db.prepare(`
      INSERT INTO itinerario_cambios (itinerario_id, ts, usuario_id, campo,
                                      valor_antes, valor_despues, motivo)
      VALUES (?,?,?, 'fecha', ?,?,?)`)
      .bind(itinerarioId, ts, sesion.id, fAntes, fDespues, motivo || 'Movida en el itinerario').run();
  }
  if (Number(vAntes) !== Number(vDespues)) {
    await db.prepare(`
      INSERT INTO itinerario_cambios (itinerario_id, ts, usuario_id, campo,
                                      valor_antes, valor_despues, motivo)
      VALUES (?,?,?, 'vehiculo_id', ?,?,?)`)
      .bind(itinerarioId, ts, sesion.id, String(vAntes), String(vDespues),
            motivo || 'Movida en el itinerario').run();
  }
}

/**
 * Aplica en bloque los cambios de la plantilla de Excel, ya revisados por el
 * usuario en la vista previa. Cada operación se intenta por separado y se
 * informa cuáles fallaron: un archivo con una fila mala no debe tumbar el resto.
 */
ruta('POST', '/api/itinerario/lote', async ({ db, sesion, cuerpo }) => {
  const ops = Array.isArray(cuerpo.operaciones) ? cuerpo.operaciones : [];
  if (!ops.length) throw malaPeticion('No hay operaciones que aplicar');
  if (ops.length > 600) throw malaPeticion('Demasiadas operaciones en un solo envío');

  const resultados = { creadas: 0, actualizadas: 0, borradas: 0, errores: [] };
  const dias = new Set();

  for (const op of ops) {
    try {
      const destinoId = op.destino_nombre
        ? await resolverDestino(db, op.destino_nombre, op.municipio_id, null, sesion.id)
        : (op.destino_id ?? null);

      if (op.accion === 'crear') {
        if (await viajesDelDia(db, op.fecha, op.vehiculo_id)) {
          throw new Error('el día ya tiene viajes registrados');
        }
        await db.prepare(`
          INSERT INTO itinerarios (fecha, vehiculo_id, conductor_id, municipio_id, destino_id,
                                   tipo_jornada, observaciones, estado, creado_por, creado_en)
          VALUES (?,?,?,?,?,?,?, 'programado', ?,?)`)
          .bind(op.fecha, op.vehiculo_id, op.conductor_id ?? null, op.municipio_id ?? null,
                destinoId, op.tipo_jornada || 'ebs', op.observaciones ?? null,
                sesion.id, ahora()).run();
        await marcarUsoDestino(db, destinoId);
        resultados.creadas++;

      } else if (op.accion === 'actualizar') {
        const antes = await db.prepare('SELECT * FROM itinerarios WHERE id = ?')
          .bind(op.id).first();
        if (!antes) throw new Error('la programación ya no existe');
        if (await viajesDelDia(db, antes.fecha, antes.vehiculo_id)) {
          throw new Error('el día ya tiene viajes registrados');
        }
        await db.prepare(`
          UPDATE itinerarios SET municipio_id = ?, destino_id = ?, tipo_jornada = ?,
                                 observaciones = ?, conductor_id = ?
           WHERE id = ?`)
          .bind(op.municipio_id ?? antes.municipio_id, destinoId ?? antes.destino_id,
                op.tipo_jornada || antes.tipo_jornada,
                op.observaciones !== undefined ? op.observaciones : antes.observaciones,
                op.conductor_id ?? antes.conductor_id, op.id).run();
        // La operación de actualizar solo trae el id; el día a recalcular sale
        // del registro, no del archivo.
        op.fecha = antes.fecha; op.vehiculo_id = antes.vehiculo_id;
        for (const [campo, val] of [['municipio_id', op.municipio_id],
                                    ['destino_id', destinoId],
                                    ['tipo_jornada', op.tipo_jornada]]) {
          if (val == null || String(antes[campo] ?? '') === String(val)) continue;
          await db.prepare(`
            INSERT INTO itinerario_cambios (itinerario_id, ts, usuario_id, campo,
                                            valor_antes, valor_despues, motivo)
            VALUES (?,?,?,?,?,?, ?)`)
            .bind(op.id, ahora(), sesion.id, campo,
                  antes[campo] != null ? String(antes[campo]) : null, String(val),
                  cuerpo.motivo || 'Carga desde plantilla de Excel').run();
        }
        await marcarUsoDestino(db, destinoId);
        resultados.actualizadas++;

      } else if (op.accion === 'borrar') {
        const antes = await db.prepare('SELECT * FROM itinerarios WHERE id = ?')
          .bind(op.id).first();
        if (!antes) throw new Error('la programación ya no existe');
        if (await viajesDelDia(db, antes.fecha, antes.vehiculo_id)) {
          throw new Error('el día ya tiene viajes registrados');
        }
        await db.prepare('DELETE FROM itinerario_cambios WHERE itinerario_id = ?')
          .bind(op.id).run();
        await db.prepare('DELETE FROM itinerarios WHERE id = ?').bind(op.id).run();
        op.fecha = antes.fecha; op.vehiculo_id = antes.vehiculo_id;
        resultados.borradas++;
      }
      dias.add(`${op.fecha}|${op.vehiculo_id}`);
    } catch (e) {
      resultados.errores.push({ fecha: op.fecha, vehiculo_id: op.vehiculo_id,
                                motivo: e.message });
    }
  }

  for (const clave of dias) {
    const [f, v] = clave.split('|');
    if (!f || f === 'undefined' || !Number(v)) continue;   // operación que falló
    await recalcularDia(db, f, Number(v));
  }
  await auditar(db, sesion, 'crear', 'itinerarios', null, null,
                { origen: cuerpo.origen || 'plantilla de Excel', ...resultados,
                  errores: resultados.errores.length });
  return resultados;
}, GESTION);

/**
 * Lo que se programó hace poco, para poder revisarlo y deshacerlo (D39).
 *
 * El itinerario se puede crear en bloque desde la plantilla de Excel y con el
 * pincel, y no había vuelta atrás: deshacer una carga de dos semanas era
 * borrar cien celdas a mano. Esta consulta responde «qué se creó, cuándo y
 * quién», que es lo primero que se pregunta cuando aparece programación que
 * nadie esperaba.
 *
 * Se devuelve también si el día YA tiene viajes registrados: esas no se
 * pueden quitar, y además significan que el vehículo sí salió.
 */
ruta('GET', '/api/itinerario/recientes', async ({ db, url }) => {
  const horas = Math.min(Math.max(Number(url.searchParams.get('horas')) || 48, 1), 24 * 30);
  const desde = new Date(Date.now() - horas * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const r = await db.prepare(`
    SELECT i.id, i.fecha, i.vehiculo_id, i.tipo_jornada, i.estado,
           i.creado_en, i.creado_por,
           v.placa, IFNULL(d.nombre, i.destino_texto) AS destino,
           u.usuario AS creado_por_usuario,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS creado_por_nombre,
           (SELECT COUNT(*) FROM trayectos t
             WHERE t.fecha_operacion = i.fecha AND t.vehiculo_id = i.vehiculo_id
               AND t.estado != 'anulado') AS viajes
      FROM itinerarios i
      JOIN vehiculos v ON v.id = i.vehiculo_id
      LEFT JOIN cat_destinos d ON d.id = i.destino_id
      LEFT JOIN usuarios u ON u.id = i.creado_por
      LEFT JOIN personas p ON p.id = u.persona_id
     WHERE i.creado_en >= ?
     ORDER BY i.creado_en DESC, i.fecha, v.placa
     LIMIT 2000`).bind(desde).all();
  return { desde, horas, itinerarios: r.results };
}, GESTION);

/**
 * Quitar en bloque las programaciones que se señalen. Solo el administrador.
 *
 * Se piden los IDENTIFICADORES, no un rango ni una hora: agrupar por el
 * momento de creación haría que dos operaciones distintas y seguidas se
 * borraran juntas. Aquí se borra exactamente lo que el usuario vio y marcó.
 *
 * Un día con viajes registrados NO se toca, aunque venga en la lista: el
 * vehículo salió, y quitar la programación descuadraría el día pagable.
 */
ruta('POST', '/api/itinerario/borrar-lote', async ({ db, sesion, cuerpo }) => {
  const ids = Array.isArray(cuerpo.ids) ? cuerpo.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw malaPeticion('No se señaló ninguna programación');
  if (ids.length > 600) throw malaPeticion('Demasiadas en un solo envío (máximo 600)');
  const motivo = String(cuerpo.motivo || '').trim();
  if (motivo.length < 5) throw malaPeticion('Escriba por qué se quitan: queda registrado');

  const borradas = [], omitidas = [];
  const dias = new Set();
  for (const id of ids) {
    const it = await db.prepare('SELECT * FROM itinerarios WHERE id = ?').bind(id).first();
    if (!it) { omitidas.push({ id, motivo: 'ya no existe' }); continue; }
    if (await viajesDelDia(db, it.fecha, it.vehiculo_id)) {
      omitidas.push({ id, fecha: it.fecha, motivo: 'ese día ya tiene viajes registrados' });
      continue;
    }
    await db.prepare('DELETE FROM itinerario_cambios WHERE itinerario_id = ?').bind(id).run();
    await db.prepare('DELETE FROM itinerarios WHERE id = ?').bind(id).run();
    borradas.push(id);
    dias.add(`${it.fecha}|${it.vehiculo_id}`);
  }
  for (const clave of dias) {
    const [f, v] = clave.split('|');
    await recalcularDia(db, f, Number(v));
  }
  await auditar(db, sesion, 'eliminar', 'itinerarios', null,
                { ids }, { motivo, borradas: borradas.length, omitidas: omitidas.length });
  return { borradas: borradas.length, omitidas };
}, ['principal']);

// ══════════════════════════════════ BANCO DE PREDETERMINADOS ════════════════

ruta('GET', '/api/predeterminados', async ({ db }) => {
  const r = await db.prepare(`
    SELECT p.*, m.nombre AS municipio, d.nombre AS destino
      FROM itinerario_predeterminados p
      LEFT JOIN cat_municipios m ON m.id = p.municipio_id
      LEFT JOIN cat_destinos d   ON d.id = p.destino_id
     WHERE p.activo = 1
     ORDER BY p.veces_usado DESC, p.nombre`).all();
  return r.results;
}, TODOS);

ruta('POST', '/api/predeterminados', async ({ db, sesion, cuerpo }) => {
  if (!cuerpo.nombre) throw malaPeticion('El nombre es obligatorio');
  const destinoId = cuerpo.destino_nombre
    ? await resolverDestino(db, cuerpo.destino_nombre, cuerpo.municipio_id, null, sesion.id)
    : (cuerpo.destino_id ?? null);
  const r = await db.prepare(`
    INSERT INTO itinerario_predeterminados (nombre, tipo_jornada, municipio_id, destino_id,
                                            observaciones, activo, creado_por, creado_en)
    VALUES (?,?,?,?,?,1,?,?)`)
    .bind(cuerpo.nombre.trim(), cuerpo.tipo_jornada || 'ebs', cuerpo.municipio_id ?? null,
          destinoId, cuerpo.observaciones ?? null, sesion.id, ahora()).run();
  await auditar(db, sesion, 'crear', 'itinerario_predeterminados', r.meta.last_row_id, null, cuerpo);
  return { id: r.meta.last_row_id, destino_id: destinoId };
}, GESTION);

ruta('PUT', '/api/predeterminados/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM itinerario_predeterminados WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Predeterminado no encontrado');
  const destinoId = cuerpo.destino_nombre
    ? await resolverDestino(db, cuerpo.destino_nombre, cuerpo.municipio_id, null, sesion.id)
    : (cuerpo.destino_id !== undefined ? cuerpo.destino_id : antes.destino_id);
  await db.prepare(`
    UPDATE itinerario_predeterminados
       SET nombre = ?, tipo_jornada = ?, municipio_id = ?, destino_id = ?, observaciones = ?
     WHERE id = ?`)
    .bind(cuerpo.nombre?.trim() || antes.nombre, cuerpo.tipo_jornada || antes.tipo_jornada,
          cuerpo.municipio_id !== undefined ? cuerpo.municipio_id : antes.municipio_id,
          destinoId,
          cuerpo.observaciones !== undefined ? cuerpo.observaciones : antes.observaciones,
          params.id).run();
  await auditar(db, sesion, 'editar', 'itinerario_predeterminados', params.id, antes, cuerpo);
  return { ok: true };
}, GESTION);

/** Se desactiva, no se borra: los itinerarios pasados lo pudieron haber usado. */
ruta('DELETE', '/api/predeterminados/:id', async ({ db, sesion, params }) => {
  await db.prepare('UPDATE itinerario_predeterminados SET activo = 0 WHERE id = ?')
    .bind(params.id).run();
  await auditar(db, sesion, 'editar', 'itinerario_predeterminados', params.id, null, { activo: 0 });
  return { ok: true };
}, ['principal']);

// ═════════════════════════════════════════════════════════ TRAYECTOS ════════

/** ¿Están exigidas las fotografías? Configurable desde Ajustes. */
async function exigeFoto(db) {
  const p = await db.prepare(
    "SELECT valor FROM parametros WHERE clave = 'foto_obligatoria'").first();
  return !p || p.valor === '1';
}

/**
 * Guarda la fotografía de un momento del trayecto.
 *
 * El navegador la reduce a 1280 px y la comprime antes de enviarla; este tope
 * es la última defensa para que la base no crezca sin control.
 */
async function guardarFoto(db, trayectoId, momento, foto, sesion, geo) {
  if (!foto || !foto.datos) return;
  if (!/^image\/(jpeg|png|webp)$/.test(foto.mime || '')) {
    throw malaPeticion('La fotografía debe ser JPG, PNG o WEBP');
  }
  const bytes = Math.floor(foto.datos.length * 3 / 4);
  if (bytes > 600_000) throw malaPeticion('La fotografía pesa demasiado (máximo 600 KB)');

  await db.prepare(`
    INSERT INTO trayecto_fotos (trayecto_id, momento, mime, datos, bytes, lat, lon, ts, subido_por)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT (trayecto_id, momento) DO UPDATE SET
      mime = excluded.mime, datos = excluded.datos, bytes = excluded.bytes,
      lat = excluded.lat, lon = excluded.lon, ts = excluded.ts,
      subido_por = excluded.subido_por`)
    .bind(trayectoId, momento, foto.mime, foto.datos, bytes,
          geo?.lat ?? null, geo?.lon ?? null, ahora(), sesion.id).run();
}

/** Lo que el conductor ve al abrir la aplicación: su programación de hoy. */
/**
 * El itinerario del propio conductor: lo que le toca en los próximos días.
 *
 * No se reutiliza /api/itinerario porque esa es la matriz de Coordinación —trae
 * TODOS los vehículos y sirve para editar—. Aquí el filtro por conductor va en
 * el servidor, no en la pantalla: así un conductor no puede ver la programación
 * de sus compañeros ni cambiando la dirección a mano.
 */
ruta('GET', '/api/mi-itinerario', async ({ db, sesion, url }) => {
  const desde = url.searchParams.get('desde') || hoyISO();
  const dias = Math.min(Math.max(Number(url.searchParams.get('dias')) || 15, 1), 60);
  const hasta = new Date(Date.parse(desde + 'T12:00:00') + (dias - 1) * 864e5)
    .toISOString().slice(0, 10);
  const personaId = sesion.persona_id;

  if (!personaId) return { desde, hasta, sin_persona: true, dias: [] };

  const r = await db.prepare(`
    SELECT i.fecha, i.tipo_jornada, i.estado, i.observaciones,
           v.placa, m.nombre AS municipio,
           IFNULL(d.nombre, i.destino_texto) AS destino,
           (SELECT COUNT(*) FROM trayectos t
             WHERE t.conductor_id = i.conductor_id AND t.fecha_operacion = i.fecha
               AND t.estado != 'anulado') AS viajes
      FROM itinerarios i
      JOIN vehiculos v ON v.id = i.vehiculo_id
      LEFT JOIN cat_municipios m ON m.id = i.municipio_id
      LEFT JOIN cat_destinos d ON d.id = i.destino_id
     WHERE i.conductor_id = ? AND i.fecha BETWEEN ? AND ? AND i.estado != 'cancelado'
     ORDER BY i.fecha`).bind(personaId, desde, hasta).all();

  return { desde, hasta, dias: r.results };
}, TODOS);

ruta('GET', '/api/mi-dia', async ({ db, sesion, url }) => {
  const fecha = url.searchParams.get('fecha') || hoyISO();
  const personaId = sesion.persona_id;

  // Una cuenta sin persona vinculada no puede tener itinerario: se busca por
  // persona, no por usuario. Se dice explícitamente en vez de devolver un día
  // vacío, que se confunde con "hoy no le programaron nada".
  if (!personaId) {
    return { fecha, sin_persona: true, itinerario: null,
             trayecto_abierto: null, trayectos: [] };
  }

  const itinerario = personaId ? await db.prepare(`
    SELECT i.*, v.placa, v.id AS vehiculo_id, m.nombre AS municipio,
           IFNULL(d.nombre, i.destino_texto) AS destino
      FROM itinerarios i
      JOIN vehiculos v ON v.id = i.vehiculo_id
      LEFT JOIN cat_municipios m ON m.id = i.municipio_id
      LEFT JOIN cat_destinos d ON d.id = i.destino_id
     WHERE i.fecha = ? AND i.conductor_id = ? AND i.estado != 'cancelado'`)
    .bind(fecha, personaId).first() : null;

  const abierto = personaId ? await db.prepare(`
    SELECT t.*, v.placa FROM trayectos t
      JOIN vehiculos v ON v.id = t.vehiculo_id
     WHERE t.conductor_id = ? AND t.estado = 'en_curso'
     ORDER BY t.ts_salida DESC LIMIT 1`).bind(personaId).first() : null;

  const delDia = personaId ? await db.prepare(`
    SELECT t.*, v.placa FROM trayectos t
      JOIN vehiculos v ON v.id = t.vehiculo_id
     WHERE t.conductor_id = ? AND t.fecha_operacion = ? AND t.estado != 'anulado'
     ORDER BY t.ts_salida`).bind(personaId, fecha).all() : { results: [] };

  // Si su vehículo está registrado fuera de servicio, el conductor tiene que
  // verlo en su propia pantalla: es lo que le explica por qué no debe salir, y
  // le evita reportar dos veces la misma varada. Se busca por el vehículo del
  // día; sin itinerario no hay nada que mirar.
  const vehId = (itinerario && itinerario.vehiculo_id) || (abierto && abierto.vehiculo_id);
  const fs = vehId ? await fueraDeServicio(db, fecha, vehId) : null;

  return { fecha, itinerario, trayecto_abierto: abierto, trayectos: delDia.results,
           fuera_servicio: fs || null, vehiculo_id: vehId || null };
}, TODOS);

/**
 * Marca de SALIDA. La hora la pone el servidor (`ahora()`), nunca el celular:
 * si valiera la del dispositivo bastaría con cambiar la hora del teléfono para
 * alterar un soporte de pago. `ts_salida_disp` guarda la del teléfono solo como
 * referencia forense, y `precision_*` permite señalar una lectura dudosa en
 * lugar de darla por buena en silencio.
 */
ruta('POST', '/api/trayectos/salida', async ({ db, sesion, cuerpo }) => {
  const conductorId = cuerpo.conductor_id || sesion.persona_id;
  if (!conductorId) throw malaPeticion('El usuario no está vinculado a una persona');
  if (sesion.rol === 'conductor' && cuerpo.conductor_id &&
      Number(cuerpo.conductor_id) !== Number(sesion.persona_id)) {
    throw prohibido('No puede registrar marcas a nombre de otro conductor');
  }

  // Estos datos dejaron de ser opcionales: sin kilometraje no hay rendimiento
  // ni costo por kilómetro, y sin la tripulación el soporte no dice quién iba.
  if (cuerpo.km_inicial == null || cuerpo.km_inicial === '') {
    throw malaPeticion('El kilometraje inicial es obligatorio');
  }
  if (!cuerpo.num_tripulantes) {
    throw malaPeticion('Indique cuántas personas van a bordo');
  }
  if (!cuerpo.tripulantes || !String(cuerpo.tripulantes).trim()) {
    throw malaPeticion('Indique los nombres de los tripulantes');
  }
  if (await exigeFoto(db) && !cuerpo.foto?.datos && cuerpo.origen !== 'offline_sincronizado') {
    throw malaPeticion('Debe adjuntar la fotografía de salida');
  }

  const abierto = await db.prepare(
    "SELECT id FROM trayectos WHERE conductor_id = ? AND estado = 'en_curso'")
    .bind(conductorId).first();
  if (abierto) {
    throw malaPeticion('Ya tiene un trayecto en curso; regístrele la llegada primero');
  }

  const fecha = cuerpo.fecha_operacion || hoyISO();
  let vehiculoId = cuerpo.vehiculo_id;
  let itinerarioId = null;
  const itin = await db.prepare(`
    SELECT id, vehiculo_id, tipo_jornada FROM itinerarios
     WHERE fecha = ? AND conductor_id = ? AND estado != 'cancelado'`)
    .bind(fecha, conductorId).first();
  if (itin) { itinerarioId = itin.id; vehiculoId = vehiculoId || itin.vehiculo_id; }
  if (!vehiculoId) throw malaPeticion('No hay vehículo asignado; indíquelo explícitamente');

  const ts = ahora();

  // A las seis de la mañana salen todos a la vez: si dos marcas caen en el
  // mismo instante piden el mismo consecutivo y una choca contra el UNIQUE.
  // conConsecutivo vuelve a intentarlo con el siguiente número.
  const { r, consecutivo } = await conConsecutivo(db, 'TR', 'trayectos',
    async (consecutivo) => ({ consecutivo, r: await db.prepare(`
      INSERT INTO trayectos (consecutivo, itinerario_id, vehiculo_id, conductor_id,
                             fecha_operacion, municipio_salida_id, lugar_salida,
                             ts_salida, ts_salida_disp, origen_salida,
                             lat_salida, lon_salida, precision_salida,
                             km_inicial, num_tripulantes, tripulantes, tipo_jornada,
                             observaciones, estado, creado_por, creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'en_curso', ?,?)`)
      .bind(consecutivo, itinerarioId, vehiculoId, conductorId, fecha,
            cuerpo.municipio_id || null, cuerpo.lugar || null,
            ts, cuerpo.ts_dispositivo || null, cuerpo.origen || 'en_linea',
            cuerpo.lat ?? null, cuerpo.lon ?? null, cuerpo.precision ?? null,
            cuerpo.km_inicial || null, cuerpo.num_tripulantes || null,
            String(cuerpo.tripulantes || '').trim() || null,
            (itin && itin.tipo_jornada) || cuerpo.tipo_jornada || null,
            cuerpo.observaciones || null, sesion.id, ts).run() }));

  await guardarFoto(db, r.meta.last_row_id, 'salida', cuerpo.foto, sesion, cuerpo);
  await recalcularDia(db, fecha, vehiculoId);
  await auditar(db, sesion, 'crear', 'trayectos', r.meta.last_row_id, null,
                { consecutivo, hito: 'salida', ts });
  return { id: r.meta.last_row_id, consecutivo, ts_salida: ts };
}, TODOS);

/** Marca de LLEGADA: cierra el trayecto y recalcula el día. */
ruta('POST', '/api/trayectos/:id/llegada', async ({ db, sesion, params, cuerpo }) => {
  const t = await db.prepare('SELECT * FROM trayectos WHERE id = ?').bind(params.id).first();
  if (!t) throw noEncontrado('Trayecto no encontrado');
  if (t.estado !== 'en_curso') throw malaPeticion('Ese trayecto ya está cerrado');
  if (sesion.rol === 'conductor' && Number(t.conductor_id) !== Number(sesion.persona_id)) {
    throw prohibido('Ese trayecto es de otro conductor');
  }
  if (cuerpo.km_final == null || cuerpo.km_final === '') {
    throw malaPeticion('El kilometraje final es obligatorio');
  }
  if (t.km_inicial != null && Number(cuerpo.km_final) < Number(t.km_inicial)) {
    throw malaPeticion(
      `El kilometraje final (${cuerpo.km_final}) no puede ser menor que el inicial (${t.km_inicial})`);
  }
  if (await exigeFoto(db) && !cuerpo.foto?.datos && cuerpo.origen !== 'offline_sincronizado') {
    throw malaPeticion('Debe adjuntar la fotografía de llegada');
  }

  const ts = ahora();
  await db.prepare(`
    UPDATE trayectos
       SET municipio_llegada_id = ?, lugar_llegada = ?, ts_llegada = ?,
           ts_llegada_disp = ?, origen_llegada = ?, lat_llegada = ?,
           lon_llegada = ?, precision_llegada = ?, km_final = ?,
           observaciones = COALESCE(?, observaciones),
           estado = 'cerrado', cerrado_en = ?
     WHERE id = ?`)
    .bind(cuerpo.municipio_id || null, cuerpo.lugar || null, ts,
          cuerpo.ts_dispositivo || null, cuerpo.origen || 'en_linea',
          cuerpo.lat ?? null, cuerpo.lon ?? null, cuerpo.precision ?? null,
          cuerpo.km_final || null, cuerpo.observaciones || null, ts, params.id).run();

  await guardarFoto(db, Number(params.id), 'llegada', cuerpo.foto, sesion, cuerpo);
  if (cuerpo.km_final) {
    await db.prepare('UPDATE vehiculos SET km_actual = ? WHERE id = ?')
      .bind(cuerpo.km_final, t.vehiculo_id).run();
  }
  await recalcularDia(db, t.fecha_operacion, t.vehiculo_id);
  await auditar(db, sesion, 'editar', 'trayectos', params.id, null,
                { hito: 'llegada', ts });
  return { ok: true, ts_llegada: ts };
}, TODOS);

/**
 * Corrección de un viaje ya registrado (D38). Solo el administrador.
 *
 * El conductor NO puede corregir su propia marca: si pudiera, el soporte de
 * pago no probaría nada. Y Coordinación tampoco — un viaje es lo que sostiene
 * un día de operación, así que mover sus datos mueve lo que se le paga a un
 * contratista, igual que borrarlo (D35).
 *
 * Lo que NO se puede tocar, a propósito: las coordenadas, la precisión del
 * GPS y las fotografías. Son lo único del soporte que no se puede fabricar
 * desde un escritorio; si se volvieran editables dejarían de probar dónde
 * estuvo el vehículo.
 *
 * Cambiar `fecha_operacion` mueve el día pagable de un día a otro: se
 * recalculan LOS DOS, el de antes y el de después. Recalcular solo uno dejaría
 * el día viejo contando un viaje que ya no existe ahí.
 */
const CAMPOS_TRAYECTO = {
  fecha_operacion: 'Día de operación',
  municipio_salida_id: 'Municipio de salida',
  lugar_salida: 'Lugar de salida',
  ts_salida: 'Hora de salida',
  km_inicial: 'Kilometraje inicial',
  municipio_llegada_id: 'Municipio de llegada',
  lugar_llegada: 'Lugar de llegada',
  ts_llegada: 'Hora de llegada',
  km_final: 'Kilometraje final',
  num_tripulantes: 'Personas a bordo',
  tripulantes: 'Nombres de los tripulantes',
  tipo_jornada: 'Tipo de jornada',
  observaciones: 'Observaciones',
};

ruta('PUT', '/api/trayectos/:id', async ({ db, sesion, params, cuerpo }) => {
  await asegurarEsquema(db);
  const antes = await db.prepare('SELECT * FROM trayectos WHERE id = ?').bind(params.id).first();
  if (!antes) throw noEncontrado('Trayecto no encontrado');

  const motivo = String(cuerpo.motivo || '').trim();
  if (motivo.length < 5) {
    throw malaPeticion('Escriba por qué se corrige: queda registrado y es lo que ' +
      'explica después el cambio en la liquidación.');
  }
  if (antes.estado === 'anulado') {
    throw malaPeticion('Ese viaje está anulado. Deshaga la anulación antes de corregirlo.');
  }

  // Solo se tocan los campos que vienen; lo demás se queda como está.
  const nuevos = {};
  for (const c of Object.keys(CAMPOS_TRAYECTO)) {
    if (cuerpo[c] !== undefined) nuevos[c] = cuerpo[c] === '' ? null : cuerpo[c];
  }
  const valor = (c) => (c in nuevos ? nuevos[c] : antes[c]);

  // ── Comprobaciones: una corrección no puede dejar el viaje imposible ──
  const fecha = valor('fecha_operacion');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) {
    throw malaPeticion('El día de operación no es una fecha válida');
  }
  const kmI = valor('km_inicial'), kmF = valor('km_final');
  if (kmI != null && kmF != null && Number(kmF) < Number(kmI)) {
    throw malaPeticion(
      `El kilometraje final (${kmF}) no puede ser menor que el inicial (${kmI})`);
  }
  const tS = valor('ts_salida'), tL = valor('ts_llegada');
  if (tS && tL && String(tL) < String(tS)) {
    throw malaPeticion('La hora de llegada es anterior a la de salida');
  }
  if (!tS) throw malaPeticion('Un viaje no puede quedarse sin hora de salida');
  const tj = valor('tipo_jornada');
  if (tj && !['ebs', 'jornada', 'vacunacion', 'disponible', 'traslado_ciudad',
              'administrativo'].includes(tj)) {
    throw malaPeticion('Tipo de jornada no válido');
  }

  // El estado NO se edita por aquí: anular tiene su propia ruta, con su motivo
  // y su columna. Dejarlo en este UPDATE permitiría anular sin dejar rastro.
  const set = [], valores = [];
  for (const c of Object.keys(nuevos)) { set.push(`${c} = ?`); valores.push(nuevos[c]); }
  if (!set.length) return { ok: true, sin_cambios: true };
  valores.push(antes.id);
  await db.prepare(`UPDATE trayectos SET ${set.join(', ')} WHERE id = ?`).bind(...valores).run();

  // Historial visible, campo por campo. Solo lo que de verdad cambió: una fila
  // por cada campo que el usuario abrió pero no tocó sería ruido.
  const ts = ahora();
  const cambiados = [];
  for (const [campo, despues] of Object.entries(nuevos)) {
    if (String(antes[campo] ?? '') === String(despues ?? '')) continue;
    cambiados.push(campo);
    await db.prepare(`
      INSERT INTO trayecto_cambios (trayecto_id, ts, usuario_id, campo,
                                    valor_antes, valor_despues, motivo)
      VALUES (?,?,?,?,?,?,?)`)
      .bind(antes.id, ts, sesion.id, campo,
            antes[campo] != null ? String(antes[campo]) : null,
            despues != null ? String(despues) : null, motivo).run();
  }

  // Los dos días: el de antes y el de después. Si solo se recalculara uno, el
  // viejo seguiría contando un viaje que ya no está ahí.
  await recalcularDia(db, antes.fecha_operacion, antes.vehiculo_id);
  if (fecha !== antes.fecha_operacion) await recalcularDia(db, fecha, antes.vehiculo_id);

  await auditar(db, sesion, 'editar', 'trayectos', antes.id,
                { consecutivo: antes.consecutivo }, { motivo, campos: cambiados });

  const dias = {};
  for (const f of new Set([antes.fecha_operacion, fecha])) {
    dias[f] = await db.prepare(
      'SELECT dia_pagable, estado_dia FROM dias_operacion WHERE fecha = ? AND vehiculo_id = ?')
      .bind(f, antes.vehiculo_id).first();
  }
  return { ok: true, cambiados, fecha_antes: antes.fecha_operacion, fecha: fecha, dias };
}, ['principal']);

/** El historial de correcciones de un viaje, para verlo en su propia ficha. */
ruta('GET', '/api/trayectos/:id/cambios', async ({ db, params }) => {
  await asegurarEsquema(db);
  const r = await db.prepare(`
    SELECT c.*, u.usuario,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS nombre_usuario
      FROM trayecto_cambios c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      LEFT JOIN personas p ON p.id = u.persona_id
     WHERE c.trayecto_id = ?
     ORDER BY c.ts DESC, c.id DESC`).bind(params.id).all();
  return r.results;
}, GESTION);

/**
 * Los viajes de un período.
 *
 * El tope existe para que «toda la operación» no sea una petición que crece
 * sin límite: un año de flota son miles de filas, y la pantalla las pide desde
 * un celular en el Catatumbo. Se devuelven los MÁS RECIENTES, que es el
 * recorte útil, y la pantalla avisa cuando llegó justo al tope para que se
 * acote el período o se descargue el archivo.
 */
const TOPE_TRAYECTOS = 20000;

ruta('GET', '/api/trayectos', async ({ db, url, sesion }) => {
  await asegurarEsquema(db);
  const desde = url.searchParams.get('desde') || hoyISO();
  const hasta = url.searchParams.get('hasta') || desde;
  const vehiculo = url.searchParams.get('vehiculo_id');
  const limite = Math.min(Number(url.searchParams.get('limite')) || 2000, TOPE_TRAYECTOS);

  // Un viaje anulado no aparece: dejó de existir para todo lo que cuenta. El
  // administrador puede pedirlos para revisar qué se anuló y por qué.
  const verAnulados = url.searchParams.get('anulados') === '1' && sesion.rol === 'principal';
  const cond = ['t.fecha_operacion BETWEEN ? AND ?'];
  if (!verAnulados) cond.push("t.estado != 'anulado'");
  const args = [desde, hasta];
  if (vehiculo) { cond.push('t.vehiculo_id = ?'); args.push(vehiculo); }
  if (sesion.rol === 'conductor') { cond.push('t.conductor_id = ?'); args.push(sesion.persona_id); }

  const r = await db.prepare(`
    SELECT t.*, v.placa,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS conductor,
           ms.nombre AS municipio_salida, ml.nombre AS municipio_llegada,
           u.usuario AS registrado_por,
           ua.usuario AS anulado_por_usuario,
           CASE WHEN t.ts_llegada IS NOT NULL AND t.ts_salida IS NOT NULL
                THEN ROUND((julianday(t.ts_llegada) - julianday(t.ts_salida)) * 24, 2)
                END AS horas,
           (SELECT group_concat(f.momento) FROM trayecto_fotos f
             WHERE f.trayecto_id = t.id) AS fotos
      FROM trayectos t
      JOIN vehiculos v ON v.id = t.vehiculo_id
      LEFT JOIN personas p ON p.id = t.conductor_id
      LEFT JOIN cat_municipios ms ON ms.id = t.municipio_salida_id
      LEFT JOIN cat_municipios ml ON ml.id = t.municipio_llegada_id
      LEFT JOIN usuarios u ON u.id = t.creado_por
      LEFT JOIN usuarios ua ON ua.id = t.anulado_por
     WHERE ${cond.join(' AND ')}
     ORDER BY t.fecha_operacion DESC, t.ts_salida DESC
     LIMIT ?`).bind(...args, limite).all();
  return r.results;
}, TODOS);

/**
 * La primera fecha con viajes registrados: el arranque real de la operación.
 *
 * La pantalla de Viajes la usa para el botón «Toda la operación». Sin esto
 * habría que inventar una fecha de inicio —2000-01-01— y pedir un rango que
 * en su mayor parte está vacío.
 */
ruta('GET', '/api/trayectos/rango', async ({ db, sesion }) => {
  const cond = ["estado != 'anulado'"];
  const args = [];
  if (sesion.rol === 'conductor') { cond.push('conductor_id = ?'); args.push(sesion.persona_id); }
  const r = await db.prepare(`
    SELECT MIN(fecha_operacion) AS primera, MAX(fecha_operacion) AS ultima,
           COUNT(*) AS total
      FROM trayectos WHERE ${cond.join(' AND ')}`).bind(...args).first();
  return r || { primera: null, ultima: null, total: 0 };
}, TODOS);

/** Devuelve las fotografías de un trayecto. Pesan, así que van aparte. */
ruta('GET', '/api/trayectos/:id/fotos', async ({ db, sesion, params }) => {
  const t = await db.prepare('SELECT conductor_id FROM trayectos WHERE id = ?')
    .bind(params.id).first();
  if (!t) throw noEncontrado('Trayecto no encontrado');
  if (sesion.rol === 'conductor' && Number(t.conductor_id) !== Number(sesion.persona_id)) {
    throw prohibido('Ese trayecto es de otro conductor');
  }
  const r = await db.prepare(`
    SELECT momento, mime, datos, bytes, lat, lon, ts FROM trayecto_fotos
     WHERE trayecto_id = ? ORDER BY momento DESC`).bind(params.id).all();
  return r.results;
}, TODOS);

/**
 * Anular o borrar un viaje. Solo el administrador (D35).
 *
 * Un viaje es el soporte de un día de operación: quitarlo cambia lo que se le
 * paga a un contratista. Por eso son dos cosas distintas, igual que en el
 * itinerario (D15):
 *
 *   · ANULAR (por omisión) deja el registro con estado 'anulado'. Deja de
 *     contar en todas partes —la lista, el día de operación, el dashboard y
 *     la liquidación ya filtran `estado != 'anulado'`—, pero el viaje, sus
 *     fotografías y el motivo siguen ahí para quien revise la cuenta. Es lo
 *     que se debe usar casi siempre.
 *   · BORRAR (?definitivo=1) lo elimina de veras, con sus fotografías y su
 *     checklist. Para lo que se registró por error y no debe dejar rastro.
 *
 * El motivo es obligatorio en los dos casos: es dinero.
 *
 * Las novedades que colgaban del viaje NO se borran, se desenganchan. Un
 * retén o un derrumbe ocurrió de verdad, aunque el viaje al que se asoció
 * estuviera mal registrado.
 *
 * En ambos casos se recalcula el día: sin eso el contador de días y el día
 * pagable se quedarían diciendo lo de antes, en silencio.
 */
ruta('DELETE', '/api/trayectos/:id', async ({ db, sesion, params, cuerpo, url }) => {
  await asegurarEsquema(db);
  const t = await db.prepare('SELECT * FROM trayectos WHERE id = ?').bind(params.id).first();
  if (!t) throw noEncontrado('Trayecto no encontrado');

  const motivo = (cuerpo && cuerpo.motivo || '').trim();
  if (motivo.length < 5) {
    throw malaPeticion('Escriba por qué se quita este viaje: queda registrado y ' +
      'es lo que explica el cambio en la liquidación.');
  }

  const definitivo = url.searchParams.get('definitivo') === '1';

  if (definitivo) {
    // Las novedades sobreviven al viaje: lo que pasó en la vía pasó.
    await db.prepare('UPDATE eventos SET trayecto_id = NULL WHERE trayecto_id = ?')
      .bind(t.id).run();
    await db.prepare(`DELETE FROM checklist_items WHERE checklist_id IN
      (SELECT id FROM checklists WHERE trayecto_id = ?)`).bind(t.id).run();
    await db.prepare('DELETE FROM checklists WHERE trayecto_id = ?').bind(t.id).run();
    await db.prepare('DELETE FROM trayecto_fotos WHERE trayecto_id = ?').bind(t.id).run();
    await db.prepare('DELETE FROM trayectos WHERE id = ?').bind(t.id).run();
  } else {
    await db.prepare(`
      UPDATE trayectos SET estado = 'anulado', anulado_por = ?, anulado_en = ?,
                           motivo_anulacion = ?
       WHERE id = ?`).bind(sesion.id, ahora(), motivo, t.id).run();
  }

  await recalcularDia(db, t.fecha_operacion, t.vehiculo_id);
  await auditar(db, sesion, definitivo ? 'eliminar' : 'anular', 'trayectos', t.id,
                { consecutivo: t.consecutivo, fecha: t.fecha_operacion,
                  vehiculo_id: t.vehiculo_id, estado: t.estado },
                { motivo, definitivo });

  const dia = await db.prepare(
    'SELECT dia_pagable, estado_dia FROM dias_operacion WHERE fecha = ? AND vehiculo_id = ?')
    .bind(t.fecha_operacion, t.vehiculo_id).first();
  return { ok: true, definitivo, fecha: t.fecha_operacion, dia: dia || null };
}, ['principal']);

/** Deshacer una anulación. También solo el administrador. */
ruta('POST', '/api/trayectos/:id/restaurar', async ({ db, sesion, params }) => {
  await asegurarEsquema(db);
  const t = await db.prepare('SELECT * FROM trayectos WHERE id = ?').bind(params.id).first();
  if (!t) throw noEncontrado('Trayecto no encontrado');
  if (t.estado !== 'anulado') throw malaPeticion('Ese viaje no está anulado');

  // No puede volver si entretanto se registró otro viaje abierto del mismo
  // vehículo ese día y este también estaba abierto: quedarían dos en curso.
  if (t.ts_llegada == null) {
    const abierto = await db.prepare(`
      SELECT id FROM trayectos WHERE vehiculo_id = ? AND estado = 'en_curso' AND id != ?`)
      .bind(t.vehiculo_id, t.id).first();
    if (abierto) {
      throw malaPeticion('Ese vehículo ya tiene otro viaje en curso. Ciérrelo primero.');
    }
  }

  await db.prepare(`
    UPDATE trayectos SET estado = ?, anulado_por = NULL, anulado_en = NULL,
                         motivo_anulacion = NULL
     WHERE id = ?`).bind(t.ts_llegada ? 'cerrado' : 'en_curso', t.id).run();
  await recalcularDia(db, t.fecha_operacion, t.vehiculo_id);
  await auditar(db, sesion, 'restaurar', 'trayectos', t.id,
                { estado: 'anulado' }, { estado: t.ts_llegada ? 'cerrado' : 'en_curso' });
  return { ok: true };
}, ['principal']);

/** Agregar o reemplazar una fotografía, p. ej. la que no se pudo subir sin señal. */
ruta('POST', '/api/trayectos/:id/foto', async ({ db, sesion, params, cuerpo }) => {
  const t = await db.prepare('SELECT conductor_id FROM trayectos WHERE id = ?')
    .bind(params.id).first();
  if (!t) throw noEncontrado('Trayecto no encontrado');
  if (sesion.rol === 'conductor' && Number(t.conductor_id) !== Number(sesion.persona_id)) {
    throw prohibido('Ese trayecto es de otro conductor');
  }
  if (!['salida', 'llegada'].includes(cuerpo.momento)) {
    throw malaPeticion('El momento debe ser salida o llegada');
  }
  await guardarFoto(db, Number(params.id), cuerpo.momento, cuerpo.foto || cuerpo, sesion, cuerpo);
  await auditar(db, sesion, 'crear', 'trayecto_fotos', Number(params.id), null,
                { momento: cuerpo.momento });
  return { ok: true };
}, TODOS);

/** Sincronización de marcas capturadas sin señal. */
ruta('POST', '/api/sync', async ({ db, sesion, cuerpo }) => {
  const pendientes = Array.isArray(cuerpo.marcas) ? cuerpo.marcas : [];
  const resultados = [];
  for (const m of pendientes) {
    try {
      // La hora del servidor ya no aplica a una marca tomada horas antes sin
      // señal: se conserva la del dispositivo y se etiqueta como tal, para que
      // el dashboard no la confunda con una marca en tiempo real.
      if (m.hito === 'salida') {
        // Una cola que se vacía tras volver la señal manda varias marcas
        // seguidas, y varios teléfonos a la vez: mismo reintento que arriba.
        const r = await conConsecutivo(db, 'TR', 'trayectos', (consecutivo) =>
          db.prepare(`
          INSERT INTO trayectos (consecutivo, vehiculo_id, conductor_id, fecha_operacion,
                                 municipio_salida_id, lugar_salida, ts_salida,
                                 ts_salida_disp, origen_salida, lat_salida, lon_salida,
                                 precision_salida, km_inicial, estado, creado_por, creado_en)
          VALUES (?,?,?,?,?,?,?,?,'offline_sincronizado',?,?,?,?,'en_curso',?,?)`)
          .bind(consecutivo, m.vehiculo_id, m.conductor_id || sesion.persona_id,
                m.fecha_operacion || (m.ts_dispositivo || '').slice(0, 10) || hoyISO(),
                m.municipio_id || null, m.lugar || null,
                m.ts_dispositivo, m.ts_dispositivo,
                m.lat ?? null, m.lon ?? null, m.precision ?? null,
                m.km_inicial || null, sesion.id, ahora()).run());
        await recalcularDia(db, m.fecha_operacion || hoyISO(), m.vehiculo_id);
        // La fotografía viaja con la marca: sin señal el conductor la toma igual
        // y se guarda en el teléfono, así que aquí hay que aterrizarla.
        await guardarFoto(db, r.meta.last_row_id, 'salida', m.foto, sesion, m);
        resultados.push({ local_id: m.local_id, ok: true, id: r.meta.last_row_id });
      } else if (m.hito === 'llegada') {
        const u = await db.prepare(`
          UPDATE trayectos
             SET municipio_llegada_id = ?, lugar_llegada = ?, ts_llegada = ?,
                 ts_llegada_disp = ?, origen_llegada = 'offline_sincronizado',
                 lat_llegada = ?, lon_llegada = ?, precision_llegada = ?,
                 km_final = ?, estado = 'cerrado', cerrado_en = ?
           WHERE id = ? AND estado = 'en_curso'`)
          .bind(m.municipio_id || null, m.lugar || null, m.ts_dispositivo,
                m.ts_dispositivo, m.lat ?? null, m.lon ?? null, m.precision ?? null,
                m.km_final || null, ahora(), m.trayecto_id).run();
        // Si no tocó ninguna fila, la llegada NO se guardó. Decirlo: darla por
        // buena haría que el teléfono la borrara y el viaje quedaría sin cerrar.
        if (!u.meta.changes) {
          resultados.push({ local_id: m.local_id, ok: false,
                            error: 'No se encontró el viaje abierto que cierra esta llegada' });
          continue;
        }
        const t = await db.prepare('SELECT fecha_operacion, vehiculo_id FROM trayectos WHERE id = ?')
          .bind(m.trayecto_id).first();
        if (t) await recalcularDia(db, t.fecha_operacion, t.vehiculo_id);
        await guardarFoto(db, m.trayecto_id, 'llegada', m.foto, sesion, m);
        resultados.push({ local_id: m.local_id, ok: true });
      }
    } catch (e) {
      resultados.push({ local_id: m.local_id, ok: false, error: e.message });
    }
  }
  await auditar(db, sesion, 'crear', 'trayectos', null, null,
                { sincronizadas: resultados.filter(r => r.ok).length });
  return { resultados };
}, TODOS);

// ═════════════════════════════════════════════════════════ CHECKLIST ════════

const DISTINTIVOS = ['lateral_izquierdo', 'lateral_derecho', 'frontal', 'trasero', 'techo'];
const ELEMENTOS = ['bandera', 'chaleco', 'carnet', 'carta_presentacion'];
const FALTANTES = ['ausente', 'obstruido', 'vencido'];

ruta('POST', '/api/checklists', async ({ db, sesion, cuerpo }) => {
  const { trayecto_id, vehiculo_id, momento, items } = cuerpo;
  if (!vehiculo_id || !Array.isArray(items)) {
    throw malaPeticion('Se requieren vehiculo_id e items');
  }

  const esperados = DISTINTIVOS.length + ELEMENTOS.length;   // 5 + 4 = 9
  const completo = items.length >= esperados ? 1 : 0;
  const faltantes = items.filter(i => FALTANTES.includes(i.estado));

  const param = await db.prepare(
    "SELECT valor FROM parametros WHERE clave = 'checklist_bloquea_salida'").first();
  const bloquea = param && param.valor === 'bloquear';

  if (bloquea && faltantes.length && !cuerpo.excepcion_autorizada) {
    throw malaPeticion(
      `Faltan o están obstruidos ${faltantes.length} ítems: ` +
      faltantes.map(f => `${f.item} (${f.estado})`).join(', ') +
      '. Requiere excepción autorizada para salir.');
  }

  const r = await db.prepare(`
    INSERT INTO checklists (trayecto_id, vehiculo_id, momento, ts, registrado_por,
                            completo, excepcion_autorizada, justificacion, autorizado_por)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(trayecto_id || null, vehiculo_id, momento || 'presalida', ahora(), sesion.id,
          completo, cuerpo.excepcion_autorizada ? 1 : 0,
          cuerpo.justificacion || null,
          cuerpo.excepcion_autorizada ? sesion.id : null).run();

  const id = r.meta.last_row_id;
  for (const i of items) {
    const bloque = DISTINTIVOS.includes(i.item) ? 'distintivo_vehiculo' : 'elemento';
    await db.prepare(`
      INSERT INTO checklist_items (checklist_id, bloque, item, estado, cantidad,
                                   foto_url, observacion)
      VALUES (?,?,?,?,?,?,?)`)
      .bind(id, bloque, i.item, i.estado, i.cantidad || null,
            i.foto_url || null, i.observacion || null).run();
  }

  // Un faltante deja novedad automática: es la traza que alimenta la reposición.
  if (faltantes.length) {
    await db.prepare(`
      INSERT INTO eventos (trayecto_id, vehiculo_id, persona_id, tipo, gravedad,
                           ts_evento, descripcion, estado, registrado_por, creado_en)
      VALUES (?,?,?, 'novedad_distintivo', ?, ?, ?, 'abierto', ?, ?)`)
      .bind(trayecto_id || null, vehiculo_id, sesion.persona_id || null,
            faltantes.length > 2 ? 'alta' : 'media', ahora(),
            'Checklist ' + (momento || 'presalida') + ': ' +
            faltantes.map(f => `${f.item} (${f.estado})`).join(', '),
            sesion.id, ahora()).run();
  }

  await auditar(db, sesion, 'crear', 'checklists', id, null,
                { momento, completo, faltantes: faltantes.length });
  return { id, completo: !!completo, faltantes: faltantes.length };
}, TODOS);

ruta('GET', '/api/checklists', async ({ db, url }) => {
  const cond = [], args = [];
  if (url.searchParams.get('trayecto_id')) {
    cond.push('c.trayecto_id = ?'); args.push(url.searchParams.get('trayecto_id'));
  }
  if (url.searchParams.get('vehiculo_id')) {
    cond.push('c.vehiculo_id = ?'); args.push(url.searchParams.get('vehiculo_id'));
  }
  const r = await db.prepare(`
    SELECT c.*, v.placa,
           (SELECT json_group_array(json_object('item', i.item, 'bloque', i.bloque,
                                                'estado', i.estado, 'cantidad', i.cantidad,
                                                'observacion', i.observacion))
              FROM checklist_items i WHERE i.checklist_id = c.id) AS items
      FROM checklists c JOIN vehiculos v ON v.id = c.vehiculo_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY c.ts DESC LIMIT 200`).bind(...args).all();
  return r.results.map(c => ({ ...c, items: JSON.parse(c.items || '[]') }));
}, TODOS);

// ═══════════════════════════════════════════════════════════ EVENTOS ════════

ruta('POST', '/api/eventos', async ({ db, sesion, cuerpo }) => {
  if (!cuerpo.tipo || !cuerpo.descripcion) {
    throw malaPeticion('Tipo y descripción son obligatorios');
  }
  const r = await db.prepare(`
    INSERT INTO eventos (trayecto_id, vehiculo_id, persona_id, tipo, gravedad,
                         ts_evento, municipio_id, lugar, lat, lon, descripcion,
                         acciones, adjunto_url, estado, registrado_por, creado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'abierto', ?,?)`)
    .bind(cuerpo.trayecto_id || null, cuerpo.vehiculo_id || null,
          cuerpo.persona_id || sesion.persona_id || null,
          cuerpo.tipo, cuerpo.gravedad || 'baja', cuerpo.ts_evento || ahora(),
          cuerpo.municipio_id || null, cuerpo.lugar || null,
          cuerpo.lat ?? null, cuerpo.lon ?? null,
          cuerpo.descripcion, cuerpo.acciones || null, cuerpo.adjunto_url || null,
          sesion.id, ahora()).run();
  await auditar(db, sesion, 'crear', 'eventos', r.meta.last_row_id, null,
                { tipo: cuerpo.tipo, gravedad: cuerpo.gravedad });
  return { id: r.meta.last_row_id };
}, TODOS);

ruta('GET', '/api/eventos', async ({ db, url, sesion }) => {
  const desde = url.searchParams.get('desde') || '0000-01-01';
  const hasta = url.searchParams.get('hasta') || '9999-12-31';
  // Mismo tope que los viajes, y por lo mismo: el período es libre.
  const limite = Math.min(Number(url.searchParams.get('limite')) || 500, 5000);
  const cond = ['date(e.ts_evento) BETWEEN ? AND ?'];
  const args = [desde, hasta];
  if (sesion.rol === 'conductor') { cond.push('e.persona_id = ?'); args.push(sesion.persona_id); }
  const r = await db.prepare(`
    SELECT e.*, v.placa, m.nombre AS municipio,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS persona
      FROM eventos e
      LEFT JOIN vehiculos v ON v.id = e.vehiculo_id
      LEFT JOIN cat_municipios m ON m.id = e.municipio_id
      LEFT JOIN personas p ON p.id = e.persona_id
     WHERE ${cond.join(' AND ')}
     ORDER BY e.ts_evento DESC LIMIT ?`).bind(...args, limite).all();
  return r.results;
}, TODOS);

/** La primera novedad registrada, para el atajo de «toda la operación». */
ruta('GET', '/api/eventos/rango', async ({ db, sesion }) => {
  const cond = ['1 = 1'];
  const args = [];
  if (sesion.rol === 'conductor') { cond.push('persona_id = ?'); args.push(sesion.persona_id); }
  const r = await db.prepare(`
    SELECT MIN(date(ts_evento)) AS primera, MAX(date(ts_evento)) AS ultima,
           COUNT(*) AS total
      FROM eventos WHERE ${cond.join(' AND ')}`).bind(...args).first();
  return r || { primera: null, ultima: null, total: 0 };
}, TODOS);

ruta('PUT', '/api/eventos/:id', async ({ db, sesion, params, cuerpo }) => {
  await db.prepare('UPDATE eventos SET estado = ?, acciones = COALESCE(?, acciones) WHERE id = ?')
    .bind(cuerpo.estado || 'cerrado', cuerpo.acciones || null, params.id).run();
  await auditar(db, sesion, 'editar', 'eventos', params.id, null, cuerpo);
  return { ok: true };
}, GESTION);

// ══════════════════════════════════════════════════ DÍAS Y DASHBOARD ════════

ruta('GET', '/api/dias', async ({ db, url }) => {
  const desde = url.searchParams.get('desde') || hoyISO().slice(0, 8) + '01';
  const hasta = url.searchParams.get('hasta') || hoyISO();
  const r = await db.prepare(`
    SELECT d.*, v.placa, v.propiedad, v.valor_dia,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS conductor
      FROM dias_operacion d
      JOIN vehiculos v ON v.id = d.vehiculo_id
      LEFT JOIN personas p ON p.id = d.conductor_id
     WHERE d.fecha BETWEEN ? AND ?
     ORDER BY d.fecha DESC, v.placa`).bind(desde, hasta).all();
  return r.results;
}, ['principal', 'coordinacion']);

ruta('PUT', '/api/dias/:id', async ({ db, sesion, params, cuerpo }) => {
  if (!cuerpo.motivo_ajuste) throw malaPeticion('Todo ajuste manual exige un motivo');
  const antes = await db.prepare('SELECT * FROM dias_operacion WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Día no encontrado');
  await db.prepare(`
    UPDATE dias_operacion
       SET dia_pagable = ?, estado_dia = COALESCE(?, estado_dia),
           ajuste_manual = 1, ajustado_por = ?, motivo_ajuste = ?
     WHERE id = ?`)
    .bind(cuerpo.dia_pagable ? 1 : 0, cuerpo.estado_dia || null,
          sesion.id, cuerpo.motivo_ajuste, params.id).run();
  await auditar(db, sesion, 'editar', 'dias_operacion', params.id, antes, cuerpo);
  return { ok: true };
}, ['principal']);

/**
 * Dashboard. Devuelve dos contadores deliberadamente distintos por vehículo:
 *   dias_pagables            → lo que se liquida (incluye días DISPONIBLE, D11)
 *   dias_con_desplazamiento  → quién se movió de verdad
 * Con un solo número el vehículo subutilizado sería invisible.
 */
ruta('GET', '/api/dashboard', async ({ db, url }) => {
  const desde = url.searchParams.get('desde') || hoyISO().slice(0, 8) + '01';
  const hasta = url.searchParams.get('hasta') || hoyISO();

  // Filtros de enfoque (D37): al escoger un conductor o un vehículo, TODO el
  // dashboard pasa a hablar solo de él. Se aplica aquí, en cada consulta, y no
  // recortando el resultado en la pantalla: así los totales de arriba son los
  // de esa persona, no los de la flota con una tabla recortada debajo.
  const conductorId = Number(url.searchParams.get('conductor_id')) || null;
  const vehiculoId = Number(url.searchParams.get('vehiculo_id')) || null;

  // Las cifras salen de estadistica.js, el MISMO sitio del que las toma el
  // informe firmado (D42). Dos consultas distintas para el mismo número serían
  // dos verdades, y la diferencia aparecería encima de un papel con una firma.
  const filtro = enfoque(conductorId, vehiculoId);
  const vehiculosOp = await porVehiculo(db, desde, hasta, filtro, vehiculoId);
  const conductores = await porConductor(db, desde, hasta, filtro, conductorId);
  const totales = await totalesOperacion(db, desde, hasta, filtro);
  const municipios = await porMunicipio(db, desde, hasta, filtro);

  const fTray = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const porDia = await db.prepare(`
    SELECT t.fecha_operacion AS fecha, COUNT(*) AS trayectos
      FROM trayectos t
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado' ${fTray.sql}
     GROUP BY t.fecha_operacion ORDER BY t.fecha_operacion`)
    .bind(desde, hasta, ...fTray.args).all();

  const fItin = filtro({ conductor: 'i.conductor_id', vehiculo: 'i.vehiculo_id' });
  const porDestino = await db.prepare(`
    SELECT IFNULL(d.nombre, i.destino_texto) AS destino, COUNT(*) AS veces
      FROM itinerarios i LEFT JOIN cat_destinos d ON d.id = i.destino_id
     WHERE i.fecha BETWEEN ? AND ? AND i.estado != 'cancelado' ${fItin.sql}
     GROUP BY destino ORDER BY veces DESC LIMIT 15`)
    .bind(desde, hasta, ...fItin.args).all();

  const fEv = filtro({ conductor: 'persona_id', vehiculo: 'vehiculo_id' });
  const eventos = await db.prepare(`
    SELECT tipo, COUNT(*) AS n FROM eventos
     WHERE date(ts_evento) BETWEEN ? AND ? ${fEv.sql}
     GROUP BY tipo ORDER BY n DESC`).bind(desde, hasta, ...fEv.args).all();

  const checklist = await db.prepare(`
    SELECT v.placa,
           COUNT(c.id) AS total,
           SUM(c.completo) AS completos,
           (SELECT COUNT(*) FROM checklist_items i
              JOIN checklists c2 ON c2.id = i.checklist_id
             WHERE c2.vehiculo_id = v.id
               AND date(c2.ts) BETWEEN ? AND ?
               AND i.estado IN ('ausente','obstruido','vencido')) AS faltantes
      FROM vehiculos v
      LEFT JOIN checklists c ON c.vehiculo_id = v.id AND date(c.ts) BETWEEN ? AND ?
     WHERE v.activo = 1 ${vehiculoId ? 'AND v.id = ?' : ''}
     GROUP BY v.id ORDER BY v.placa`)
    .bind(desde, hasta, desde, hasta, ...(vehiculoId ? [vehiculoId] : [])).all();

  // Con un filtro puesto solo se muestran los vencimientos de ese titular: un
  // dashboard que habla de una persona no debe listar los papeles de los demás.
  const vencimientos = await db.prepare(`
    SELECT 'vehiculo' AS ambito, v.placa AS titular, dv.tipo, dv.vencimiento,
           CAST(julianday(dv.vencimiento) - julianday('now') AS INTEGER) AS dias
      FROM documentos_vehiculo dv JOIN vehiculos v ON v.id = dv.vehiculo_id
     WHERE dv.vencimiento IS NOT NULL
       AND julianday(dv.vencimiento) - julianday('now') <= 30
       ${conductorId ? 'AND 0' : ''} ${vehiculoId ? 'AND v.id = ?' : ''}
    UNION ALL
    SELECT 'persona', p.nombres || ' ' || IFNULL(p.apellidos,''), dp.tipo, dp.vencimiento,
           CAST(julianday(dp.vencimiento) - julianday('now') AS INTEGER)
      FROM documentos_persona dp JOIN personas p ON p.id = dp.persona_id
     WHERE dp.vencimiento IS NOT NULL
       AND julianday(dp.vencimiento) - julianday('now') <= 30
       ${vehiculoId ? 'AND 0' : ''} ${conductorId ? 'AND p.id = ?' : ''}
     ORDER BY dias`)
    .bind(...(vehiculoId ? [vehiculoId] : []), ...(conductorId ? [conductorId] : [])).all();

  const marcas = await db.prepare(`
    SELECT t.origen_salida AS origen, COUNT(*) AS n
      FROM trayectos t
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.origen_salida IS NOT NULL
       AND t.estado != 'anulado' ${fTray.sql}
     GROUP BY t.origen_salida`).bind(desde, hasta, ...fTray.args).all();

  return {
    periodo: { desde, hasta },
    enfoque: { conductor_id: conductorId, vehiculo_id: vehiculoId },
    totales,
    por_vehiculo: vehiculosOp,
    por_conductor: conductores,
    por_municipio: municipios,
    por_dia: porDia.results,
    por_destino: porDestino.results,
    eventos: eventos.results,
    checklist: checklist.results,
    vencimientos: vencimientos.results,
    origen_marcas: marcas.results,
  };
}, ['principal', 'coordinacion']);

// ════════════════════════════════════════════ AUDITORÍA Y PARÁMETROS ════════

ruta('GET', '/api/auditoria', async ({ db, url }) => {
  const limite = Math.min(Number(url.searchParams.get('limite') || 200), 1000);
  const r = await db.prepare(`
    SELECT a.*, u.usuario,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS nombre
      FROM auditoria a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      LEFT JOIN personas p ON p.id = u.persona_id
     ORDER BY a.ts DESC LIMIT ?`).bind(limite).all();
  return r.results;
}, ['principal']);

/**
 * Los parámetros los lee todo el mundo: son reglas de operación, no secretos, y
 * la pantalla del conductor los necesita —si no puede leerlos, un cambio hecho
 * en Ajustes nunca llega a su teléfono y el celular sigue con el valor de
 * fábrica sin que nadie lo note. Modificarlos sigue siendo solo del principal.
 *
 * La única excepción son los correos de alertas, que no le hacen falta.
 */
ruta('GET', '/api/parametros', async ({ db, sesion }) => {
  const r = await db.prepare('SELECT * FROM parametros ORDER BY clave').all();
  if (sesion.rol === 'conductor') {
    return r.results.filter(p => p.clave !== 'correo_alertas');
  }
  return r.results;
}, TODOS);

ruta('PUT', '/api/parametros/:clave', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM parametros WHERE clave = ?')
    .bind(params.clave).first();
  await db.prepare(`
    INSERT INTO parametros (clave, valor, descripcion, actualizado_por, actualizado_en)
    VALUES (?,?,?,?,?)
    ON CONFLICT (clave) DO UPDATE SET
      valor = excluded.valor, actualizado_por = excluded.actualizado_por,
      actualizado_en = excluded.actualizado_en`)
    .bind(params.clave, String(cuerpo.valor),
          cuerpo.descripcion || (antes && antes.descripcion) || null,
          sesion.id, ahora()).run();
  await auditar(db, sesion, 'editar', 'parametros', null, antes, cuerpo);
  return { ok: true };
}, ['principal']);

// ════════════════════════════════════════════════════════════════════════
// rutas_fuera_servicio.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — días fuera de servicio (D33)
 *
 * Responde a una sola pregunta, la que sostiene la liquidación: qué días
 * estuvo parado cada vehículo y por qué. No es `vehiculos.estado`, que dice
 * cómo está HOY y no desde cuándo; ni `mantenimientos`, que es el libro de
 * taller de la fase de logística.
 *
 * Tres reglas que el resto del sistema da por ciertas:
 *
 *   1. Dos períodos del mismo vehículo NO pueden solaparse. Si se permitiera,
 *      un mismo día se contaría dos veces y el descuento al contratista
 *      quedaría mal. SQLite no tiene restricciones de rango: se comprueba aquí.
 *   2. `fecha_fin` NULL significa que SIGUE fuera de servicio. Es el caso
 *      normal cuando lo reporta el conductor desde la vía: sabe que se varó, no
 *      sabe cuándo vuelve.
 *   3. Cada día del rango se recalcula en `dias_operacion`, que es donde vive
 *      `dia_pagable`. Registrar el período sin recalcular dejaría la
 *      liquidación diciendo lo de antes.
 */

/** Tope de días de un período. Un rango disparatado recalcularía media base. */
const MAX_DIAS = 400;

const esFecha = f => typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f);

/** Los días de un rango, ambos extremos incluidos. */
function diasDelRango(desde, hasta) {
  const dias = [];
  for (let t = Date.parse(desde + 'T12:00:00Z'), fin = Date.parse(hasta + 'T12:00:00Z');
       t <= fin; t += 86400000) {
    dias.push(new Date(t).toISOString().slice(0, 10));
  }
  return dias;
}

/**
 * Recalcula dias_operacion en todo el rango del período.
 *
 * Un período abierto no tiene fin: se recalcula hasta hoy, que es hasta donde
 * puede haber días liquidables. Los días futuros se recalcularán solos cuando
 * se programen o se cierre el período.
 */
async function recalcularRango(db, vehiculoId, desde, hasta) {
  const fin = hasta || hoyISO();
  if (fin < desde) return;
  for (const f of diasDelRango(desde, fin.slice(0, 10))) {
    await recalcularDia(db, f, vehiculoId);
  }
}

/**
 * Períodos del mismo vehículo que chocan con el rango dado.
 *
 * Dos rangos se solapan si cada uno empieza antes de que acabe el otro. El fin
 * NULL se trata como infinito, que es lo que significa.
 */
async function solapes(db, vehiculoId, desde, hasta, excluirId) {
  const r = await db.prepare(`
    SELECT id, causa, fecha_inicio, fecha_fin FROM fuera_servicio
     WHERE vehiculo_id = ? AND id != ?
       AND fecha_inicio <= IFNULL(?, '9999-12-31')
       AND IFNULL(fecha_fin, '9999-12-31') >= ?`)
    .bind(vehiculoId, excluirId || 0, hasta, desde).all();
  return r.results;
}

/** Las programaciones vivas que caen dentro del rango. */
async function programadosEnRango(db, vehiculoId, desde, hasta) {
  const r = await db.prepare(`
    SELECT i.id, i.fecha, i.tipo_jornada, d.nombre AS destino,
           (SELECT COUNT(*) FROM trayectos t
             WHERE t.fecha_operacion = i.fecha AND t.vehiculo_id = i.vehiculo_id
               AND t.estado != 'anulado') AS viajes
      FROM itinerarios i
      LEFT JOIN cat_destinos d ON d.id = i.destino_id
     WHERE i.vehiculo_id = ? AND i.estado != 'cancelado'
       AND i.fecha BETWEEN ? AND IFNULL(?, '9999-12-31')
     ORDER BY i.fecha`)
    .bind(vehiculoId, desde, hasta).all();
  return r.results;
}

/** El vehículo que un conductor tiene derecho a marcar: el suyo de hoy. */
async function vehiculoDelConductor(db, personaId, fecha) {
  const r = await db.prepare(`
    SELECT vehiculo_id FROM itinerarios
     WHERE conductor_id = ? AND fecha = ? AND estado != 'cancelado'
    UNION
    SELECT vehiculo_id FROM trayectos
     WHERE conductor_id = ? AND fecha_operacion = ? AND estado != 'anulado'
    UNION
    SELECT vehiculo_id FROM asignaciones
     WHERE persona_id = ? AND rol = 'conductor'
       AND desde <= ? AND (hasta IS NULL OR hasta >= ?)`)
    .bind(personaId, fecha, personaId, fecha, personaId, fecha, fecha).all();
  return r.results.map(x => x.vehiculo_id);
}

// ═══════════════════════════════════════════════════════════ CONSULTA ════════

/**
 * Los períodos que tocan el rango pedido.
 *
 * Sin `desde`/`hasta` devuelve los abiertos, que es lo que hace falta para
 * saber qué está parado ahora mismo. La foto no viaja en la lista: son cientos
 * de kilobytes que solo se miran de uno en uno.
 */
ruta('GET', '/api/fuera-servicio', async ({ db, url }) => {
  await asegurarEsquema(db);
  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');
  const vehiculo = url.searchParams.get('vehiculo_id');

  const cond = [], args = [];
  if (desde && hasta) {
    cond.push("fs.fecha_inicio <= ? AND IFNULL(fs.fecha_fin, '9999-12-31') >= ?");
    args.push(hasta, desde);
  } else if (!vehiculo) {
    cond.push('fs.fecha_fin IS NULL');
  }
  if (vehiculo) { cond.push('fs.vehiculo_id = ?'); args.push(Number(vehiculo)); }

  const r = await db.prepare(`
    SELECT fs.id, fs.vehiculo_id, fs.causa, fs.fecha_inicio, fs.fecha_fin,
           fs.descripcion, fs.taller, fs.km_evento, fs.evento_id, fs.rol_registro,
           fs.creado_en, fs.cerrado_en, fs.motivo_cierre,
           fs.foto_datos IS NOT NULL AS tiene_foto,
           v.placa,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS registrado_por_nombre,
           u.usuario AS registrado_por_usuario
      FROM fuera_servicio fs
      JOIN vehiculos v ON v.id = fs.vehiculo_id
      LEFT JOIN usuarios u ON u.id = fs.registrado_por
      LEFT JOIN personas p ON p.id = u.persona_id
     ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY fs.fecha_inicio DESC, fs.id DESC
     LIMIT 500`).bind(...args).all();
  return r.results;
}, TODOS);

/** La fotografía de un período, aparte: pesa demasiado para ir en la lista. */
ruta('GET', '/api/fuera-servicio/:id/foto', async ({ db, params }) => {
  await asegurarEsquema(db);
  const r = await db.prepare(
    'SELECT foto_mime, foto_datos FROM fuera_servicio WHERE id = ?')
    .bind(params.id).first();
  if (!r || !r.foto_datos) throw noEncontrado('Ese registro no tiene fotografía');
  return { mime: r.foto_mime, datos: r.foto_datos };
}, TODOS);

/**
 * Días fuera de servicio por vehículo, de TODA la operación.
 *
 * Se cuenta desde `dias_operacion`, no restando fechas: es la misma fuente de
 * la que sale el día pagable, así que las dos cifras no pueden discrepar. Un
 * período abierto que se extiende al futuro no infla la cuenta, porque solo
 * existen filas de los días que ya se recalcularon.
 */
ruta('GET', '/api/fuera-servicio/resumen', async ({ db }) => {
  await asegurarEsquema(db);
  const r = await db.prepare(`
    SELECT vehiculo_id,
           COUNT(*) AS dias,
           SUM(CASE WHEN estado_dia = 'mantenimiento' THEN 1 ELSE 0 END) AS dias_mantenimiento,
           MIN(fecha) AS primera, MAX(fecha) AS ultima
      FROM dias_operacion
     WHERE estado_dia IN ('fuera_servicio', 'mantenimiento')
     GROUP BY vehiculo_id`).all();
  const abiertos = await db.prepare(`
    SELECT vehiculo_id, causa, fecha_inicio FROM fuera_servicio
     WHERE fecha_fin IS NULL`).all();
  return { vehiculos: r.results, abiertos: abiertos.results };
}, GESTION);

// ═══════════════════════════════════════════════════════════ REGISTRO ════════

/**
 * Registrar un período fuera de servicio.
 *
 * El conductor también puede (decisión del usuario), pero acotado: solo el
 * vehículo que tiene asignado, solo desde hoy y sin poner fecha de fin. No es
 * desconfianza, es que desde la vía no se sabe nada más: se varó, hoy, y no
 * sabe cuándo vuelve. Quien cierra el período es Coordinación.
 */
ruta('POST', '/api/fuera-servicio', async ({ db, sesion, cuerpo }) => {
  await asegurarEsquema(db);
  const esConductor = sesion.rol === 'conductor';

  const vehiculoId = Number(cuerpo.vehiculo_id);
  if (!vehiculoId) throw malaPeticion('Indique el vehículo');
  const veh = await db.prepare('SELECT id, placa FROM vehiculos WHERE id = ?')
    .bind(vehiculoId).first();
  if (!veh) throw noEncontrado('Vehículo no encontrado');

  const causa = cuerpo.causa || 'averia';
  if (!CAUSAS.includes(causa)) throw malaPeticion('Causa no válida');

  let desde = cuerpo.fecha_inicio;
  let hasta = cuerpo.fecha_fin || null;

  if (esConductor) {
    // El conductor reporta lo que le acaba de pasar, no reescribe el pasado.
    desde = hoyISO();
    hasta = null;
    const suyos = await vehiculoDelConductor(db, sesion.persona_id, desde);
    if (!suyos.includes(vehiculoId)) {
      throw prohibido('Solo puede reportar el vehículo que tiene asignado hoy');
    }
  }

  if (!esFecha(desde)) throw malaPeticion('La fecha de inicio es obligatoria (AAAA-MM-DD)');
  if (hasta && !esFecha(hasta)) throw malaPeticion('La fecha de fin no es válida');
  if (hasta && hasta < desde) throw malaPeticion('La fecha de fin es anterior a la de inicio');
  if (hasta && diasDelRango(desde, hasta).length > MAX_DIAS) {
    throw malaPeticion(`Un período no puede pasar de ${MAX_DIAS} días`);
  }

  const choques = await solapes(db, vehiculoId, desde, hasta, null);
  if (choques.length) {
    const c = choques[0];
    throw malaPeticion(
      `${veh.placa} ya está registrado fuera de servicio del ${c.fecha_inicio} ` +
      `${c.fecha_fin ? 'al ' + c.fecha_fin : 'en adelante'}. Modifique ese período ` +
      'en vez de crear otro.');
  }

  if (cuerpo.foto && cuerpo.foto.datos) {
    if (!/^image\/(jpeg|png|webp)$/.test(cuerpo.foto.mime || '')) {
      throw malaPeticion('La fotografía debe ser JPG, PNG o WEBP');
    }
    if (Math.floor(cuerpo.foto.datos.length * 3 / 4) > 600_000) {
      throw malaPeticion('La fotografía pesa demasiado (máximo 600 KB)');
    }
  }

  const r = await db.prepare(`
    INSERT INTO fuera_servicio (vehiculo_id, causa, fecha_inicio, fecha_fin,
                                descripcion, taller, km_evento, evento_id,
                                foto_mime, foto_datos, registrado_por,
                                rol_registro, creado_en)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(vehiculoId, causa, desde, hasta,
          cuerpo.descripcion || null, esConductor ? null : (cuerpo.taller || null),
          cuerpo.km_evento || null, cuerpo.evento_id || null,
          cuerpo.foto?.datos ? cuerpo.foto.mime : null,
          cuerpo.foto?.datos || null,
          sesion.id, sesion.rol, ahora()).run();

  const id = r.meta.last_row_id;
  await recalcularRango(db, vehiculoId, desde, hasta);
  await auditar(db, sesion, 'crear', 'fuera_servicio', id, null,
                { vehiculo_id: vehiculoId, causa, desde, hasta });

  // Lo que el usuario necesita decidir a continuación: qué hacer con los días
  // que ya estaban programados dentro del rango. No se cancela nada por cuenta
  // propia; se informa y Coordinación decide.
  const programados = await programadosEnRango(db, vehiculoId, desde, hasta);
  return { id, placa: veh.placa, programados };
}, TODOS);

/**
 * Modificar o cerrar un período.
 *
 * Al mover las fechas hay que recalcular el rango VIEJO además del nuevo: los
 * días que dejan de estar cubiertos vuelven a contar como antes, y si no se
 * recalculan se quedan marcados fuera de servicio para siempre.
 */
ruta('PUT', '/api/fuera-servicio/:id', async ({ db, sesion, params, cuerpo }) => {
  await asegurarEsquema(db);
  const antes = await db.prepare('SELECT * FROM fuera_servicio WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Período no encontrado');

  const causa = cuerpo.causa || antes.causa;
  if (!CAUSAS.includes(causa)) throw malaPeticion('Causa no válida');

  const desde = cuerpo.fecha_inicio ?? antes.fecha_inicio;
  // fecha_fin: null explícito reabre el período; undefined lo deja como está.
  const hasta = cuerpo.fecha_fin === undefined ? antes.fecha_fin : (cuerpo.fecha_fin || null);

  if (!esFecha(desde)) throw malaPeticion('La fecha de inicio no es válida');
  if (hasta && !esFecha(hasta)) throw malaPeticion('La fecha de fin no es válida');
  if (hasta && hasta < desde) throw malaPeticion('La fecha de fin es anterior a la de inicio');
  if (hasta && diasDelRango(desde, hasta).length > MAX_DIAS) {
    throw malaPeticion(`Un período no puede pasar de ${MAX_DIAS} días`);
  }

  const choques = await solapes(db, antes.vehiculo_id, desde, hasta, antes.id);
  if (choques.length) {
    const c = choques[0];
    throw malaPeticion(`Choca con otro período del mismo vehículo (${c.fecha_inicio} ` +
      `${c.fecha_fin ? 'a ' + c.fecha_fin : 'en adelante'})`);
  }

  const cerrando = !antes.fecha_fin && hasta;
  await db.prepare(`
    UPDATE fuera_servicio
       SET causa = ?, fecha_inicio = ?, fecha_fin = ?, descripcion = ?, taller = ?,
           km_evento = ?, motivo_cierre = ?,
           cerrado_por = ?, cerrado_en = ?
     WHERE id = ?`)
    .bind(causa, desde, hasta,
          cuerpo.descripcion !== undefined ? cuerpo.descripcion : antes.descripcion,
          cuerpo.taller !== undefined ? cuerpo.taller : antes.taller,
          cuerpo.km_evento !== undefined ? cuerpo.km_evento : antes.km_evento,
          cuerpo.motivo_cierre !== undefined ? cuerpo.motivo_cierre : antes.motivo_cierre,
          cerrando ? sesion.id : antes.cerrado_por,
          cerrando ? ahora() : antes.cerrado_en,
          antes.id).run();

  // Primero el rango viejo, para devolver a su sitio los días que se liberan.
  await recalcularRango(db, antes.vehiculo_id, antes.fecha_inicio, antes.fecha_fin);
  await recalcularRango(db, antes.vehiculo_id, desde, hasta);
  await auditar(db, sesion, 'editar', 'fuera_servicio', antes.id,
                { causa: antes.causa, desde: antes.fecha_inicio, hasta: antes.fecha_fin },
                { causa, desde, hasta });
  return { ok: true, cerrado: !!hasta };
}, GESTION);

/** Borrar un período registrado por error. Solo el administrador. */
ruta('DELETE', '/api/fuera-servicio/:id', async ({ db, sesion, params }) => {
  await asegurarEsquema(db);
  const antes = await db.prepare('SELECT * FROM fuera_servicio WHERE id = ?')
    .bind(params.id).first();
  if (!antes) throw noEncontrado('Período no encontrado');
  await db.prepare('DELETE FROM fuera_servicio WHERE id = ?').bind(antes.id).run();
  await recalcularRango(db, antes.vehiculo_id, antes.fecha_inicio, antes.fecha_fin);
  await auditar(db, sesion, 'eliminar', 'fuera_servicio', antes.id, antes, null);
  return { ok: true };
}, ['principal']);

// ════════════════════════════════════════════════════════════════════════
// rutas_solicitudes.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — solicitudes de aprobación (D41)
 *
 * La coordinación propone; el administrador dispone. Lo que la coordinación
 * pide no toca la base: se guarda entero —método, ruta, parámetros y cuerpo—
 * y espera. Al aprobar se vuelve a ejecutar la MISMA ruta, con la MISMA sesión
 * de quien la pidió, de modo que las validaciones, el historial de cambios y
 * la auditoría salen idénticos a los de un cambio hecho directamente. Eso es
 * lo que evita tener dos caminos que escriban lo mismo de dos maneras y se
 * separen con el tiempo.
 */

const SELECT_SOLICITUD = `
  SELECT s.*,
         u.usuario AS solicitante,
         TRIM(IFNULL(p.nombres,'') || ' ' || IFNULL(p.apellidos,'')) AS solicitante_nombre,
         ur.usuario AS resuelto_por_usuario
    FROM solicitudes s
    LEFT JOIN usuarios u  ON u.id = s.solicitante_id
    LEFT JOIN personas p  ON p.id = u.persona_id
    LEFT JOIN usuarios ur ON ur.id = s.resuelto_por`;

/**
 * La bandeja.
 *
 * La coordinación ve SOLO lo suyo: es quien pide, y saber qué pidió otro no le
 * sirve para nada. El administrador las ve todas, que es el punto.
 */
ruta('GET', '/api/solicitudes', async ({ db, sesion, url }) => {
  await vencerSolicitudes(db);
  const estado = url.searchParams.get('estado') || 'pendiente';
  const limite = Math.min(Math.max(Number(url.searchParams.get('limite')) || 200, 1), 1000);

  const donde = [];
  const args = [];
  if (estado !== 'todas') { donde.push('s.estado = ?'); args.push(estado); }
  if (sesion.rol !== 'principal') { donde.push('s.solicitante_id = ?'); args.push(sesion.id); }
  args.push(limite);

  const r = await db.prepare(`${SELECT_SOLICITUD}
    ${donde.length ? 'WHERE ' + donde.join(' AND ') : ''}
    ORDER BY s.ts DESC LIMIT ?`).bind(...args).all();
  return r.results;
}, GESTION);

/**
 * Cuántas esperan. Es lo que pinta el número rojo del menú: sin él la bandeja
 * es una pantalla a la que hay que acordarse de entrar, y nadie entra.
 */
ruta('GET', '/api/solicitudes/conteo', async ({ db, sesion }) => {
  await vencerSolicitudes(db);
  const propias = sesion.rol !== 'principal';
  const r = await db.prepare(`
    SELECT COUNT(*) AS n FROM solicitudes
     WHERE estado = 'pendiente' ${propias ? 'AND solicitante_id = ?' : ''}`)
    .bind(...(propias ? [sesion.id] : [])).first();
  return { pendientes: (r && r.n) || 0 };
}, GESTION);

/**
 * Los días con solicitud pendiente, para marcarlos en la matriz.
 *
 * Sin esto la coordinación programa, no ve nada aparecer y vuelve a programar:
 * la pantalla le estaría mintiendo. Con esto la celda sale rayada y dice
 * «pendiente», que es la verdad.
 */
ruta('GET', '/api/solicitudes/dias', async ({ db, url }) => {
  await vencerSolicitudes(db);
  const desde = url.searchParams.get('desde') || hoyISO();
  const hasta = url.searchParams.get('hasta') || desde;
  const r = await db.prepare(`
    SELECT sd.fecha, sd.vehiculo_id, sd.solicitud_id, s.resumen, s.ts,
           u.usuario AS solicitante
      FROM solicitud_dias sd
      JOIN solicitudes s ON s.id = sd.solicitud_id
      LEFT JOIN usuarios u ON u.id = s.solicitante_id
     WHERE s.estado = 'pendiente' AND sd.fecha BETWEEN ? AND ?`)
    .bind(desde, hasta).all();
  return r.results;
}, GESTION);

/**
 * Aprobar: ejecuta de verdad lo que se pidió.
 *
 * Puede fallar, y es normal que falle: entre la petición y el visto bueno el
 * mundo siguió andando y el día pudo quedarse con viajes registrados, o la
 * programación pudo desaparecer. En ese caso la solicitud NO queda aprobada ni
 * pendiente, queda `fallida` con el motivo exacto — no se pierde, y nadie cree
 * que se aplicó algo que no se aplicó.
 */
ruta('POST', '/api/solicitudes/:id/aprobar', async ({ db, sesion, params, env, request }) => {
  await vencerSolicitudes(db);
  const s = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(params.id).first();
  if (!s) throw noEncontrado('Solicitud no encontrada');
  if (s.estado !== 'pendiente') {
    throw malaPeticion(`Esa solicitud ya está ${s.estado}; no se puede aprobar de nuevo.`);
  }

  const encontrada = resolver(s.metodo, s.ruta.split('?')[0]);
  if (!encontrada) throw malaPeticion('La ruta de esa solicitud ya no existe en esta versión');

  // La sesión de quien la pidió, reconstruida: el cambio queda firmado por la
  // coordinación —fue su decisión— y la aprobación queda firmada aparte, por
  // el administrador. Las dos cosas en la auditoría, que es como se lee luego.
  const quien = await db.prepare(
    'SELECT id, usuario, rol, persona_id, municipio_id FROM usuarios WHERE id = ?')
    .bind(s.solicitante_id).first();
  if (!quien) throw malaPeticion('Quien pidió el cambio ya no existe como usuario');

  let resultado;
  try {
    resultado = await encontrada.manejador({
      db, env, sesion: quien,
      cuerpo: JSON.parse(s.cuerpo || '{}'),
      params: encontrada.params,
      url: new URL('http://interno' + s.ruta),
      request,
    });
  } catch (e) {
    const motivo = String((e && e.message) || e);
    await db.prepare(`
      UPDATE solicitudes SET estado = 'fallida', resuelto_en = ?, resuelto_por = ?,
                             motivo = ?
       WHERE id = ?`).bind(ahora(), sesion.id, motivo, params.id).run();
    await auditar(db, sesion, 'aprobar', 'solicitudes', Number(params.id), null,
                  { fallida: true, motivo });
    throw malaPeticion(`No se pudo aplicar: ${motivo}`);
  }

  await db.prepare(`
    UPDATE solicitudes SET estado = 'aprobada', resuelto_en = ?, resuelto_por = ?,
                           resultado = ?
     WHERE id = ?`)
    .bind(ahora(), sesion.id, JSON.stringify(resultado || { ok: true }), params.id).run();
  await auditar(db, sesion, 'aprobar', 'solicitudes', Number(params.id), null,
                { resumen: s.resumen, cuantas: s.cuantas });
  return { ok: true, aplicada: true, resultado };
}, ['principal']);

/**
 * Rechazar. El motivo es obligatorio: un «no» sin razón se vuelve a pedir
 * mañana igual, y quien lo pidió no tiene cómo corregirlo.
 */
ruta('POST', '/api/solicitudes/:id/rechazar', async ({ db, sesion, params, cuerpo }) => {
  await asegurarEsquema(db);
  const motivo = String((cuerpo && cuerpo.motivo) || '').trim();
  if (motivo.length < 5) throw malaPeticion('Escriba por qué no se aprueba (mínimo 5 letras)');

  const s = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(params.id).first();
  if (!s) throw noEncontrado('Solicitud no encontrada');
  if (s.estado !== 'pendiente') {
    throw malaPeticion(`Esa solicitud ya está ${s.estado}; no se puede rechazar.`);
  }

  await db.prepare(`
    UPDATE solicitudes SET estado = 'rechazada', resuelto_en = ?, resuelto_por = ?, motivo = ?
     WHERE id = ?`).bind(ahora(), sesion.id, motivo, params.id).run();
  await auditar(db, sesion, 'rechazar', 'solicitudes', Number(params.id), null,
                { resumen: s.resumen, motivo });
  return { ok: true };
}, ['principal']);

/**
 * Retirar lo que uno mismo pidió, antes de que lo contesten.
 *
 * Es la salida de la celda bloqueada: si la coordinación se equivocó al pedir,
 * sin esto tendría que esperar a que el administrador le rechace su propio
 * error para poder volver a pedirlo bien.
 */
ruta('DELETE', '/api/solicitudes/:id', async ({ db, sesion, params }) => {
  await asegurarEsquema(db);
  const s = await db.prepare('SELECT * FROM solicitudes WHERE id = ?').bind(params.id).first();
  if (!s) throw noEncontrado('Solicitud no encontrada');
  if (s.estado !== 'pendiente') throw malaPeticion(`Esa solicitud ya está ${s.estado}.`);
  if (sesion.rol !== 'principal' && s.solicitante_id !== sesion.id) {
    throw prohibido('Solo puede retirar las solicitudes que usted pidió');
  }

  await db.prepare(`
    UPDATE solicitudes SET estado = 'retirada', resuelto_en = ?, resuelto_por = ?
     WHERE id = ?`).bind(ahora(), sesion.id, params.id).run();
  await auditar(db, sesion, 'retirar', 'solicitudes', Number(params.id), null,
                { resumen: s.resumen });
  return { ok: true };
}, GESTION);

// ════════════════════════════════════════════════════════════════════════
// rutas_informes.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — informe estadístico firmado (D42)
 *
 * Un informe que alguien firma no es una descarga: es un documento. Por eso
 * aquí se EMITE —con su consecutivo, su fecha y sus firmantes— y las cifras
 * quedan congeladas en la base. Volver a descargarlo imprime exactamente el
 * mismo papel que se firmó, aunque después se haya anulado un viaje o
 * corregido un kilometraje. Si se recalculara, el PDF archivado y el de la
 * aplicación dirían cosas distintas, y el que llevaría la firma sería el que
 * no cuadra.
 *
 * Las cifras se calculan EN EL SERVIDOR, nunca en el navegador: la pantalla de
 * Viajes solo tiene los viajes que alcanzó a descargar, y los días pagables no
 * están ahí sino en dias_operacion.
 */

/** Tope del anexo. Un PDF de cien mil filas no lo abre nadie. */
const TOPE_ANEXO = 3000;

/**
 * Quiénes pueden firmar: los usuarios con rol principal.
 *
 * Se devuelven con el cargo y el documento de su persona, que es lo que va
 * impreso bajo la raya. Un administrador sin persona vinculada sale igual, con
 * lo que haya: es preferible una firma con el nombre de usuario a que no
 * aparezca en la lista y nadie entienda por qué.
 */
ruta('GET', '/api/informes/firmantes', async ({ db }) => {
  const r = await db.prepare(`
    SELECT u.id, u.usuario,
           TRIM(IFNULL(p.nombres,'') || ' ' || IFNULL(p.apellidos,'')) AS nombre,
           p.cargo, p.tipo_doc, p.numero_doc
      FROM usuarios u LEFT JOIN personas p ON p.id = u.persona_id
     WHERE u.rol = 'principal' AND u.activo = 1
     ORDER BY nombre, u.usuario`).all();
  return r.results.map(x => ({
    ...x,
    nombre: (x.nombre || '').trim() || x.usuario,
  }));
}, ['principal']);

/** Los informes ya emitidos. */
ruta('GET', '/api/informes', async ({ db, url }) => {
  await asegurarEsquema(db);
  const limite = Math.min(Math.max(Number(url.searchParams.get('limite')) || 50, 1), 500);
  const r = await db.prepare(`
    SELECT i.id, i.consecutivo, i.ts, i.titulo, i.desde, i.hasta, i.con_anexo,
           i.filtros, i.firmantes,
           u.usuario AS emitido_por_usuario
      FROM informes i LEFT JOIN usuarios u ON u.id = i.emitido_por
     ORDER BY i.ts DESC LIMIT ?`).bind(limite).all();
  return r.results.map(x => ({
    ...x,
    filtros: JSON.parse(x.filtros || '{}'),
    firmantes: JSON.parse(x.firmantes || '[]'),
  }));
}, ['principal']);

/** Uno ya emitido, tal cual se firmó. */
ruta('GET', '/api/informes/:id', async ({ db, params }) => {
  await asegurarEsquema(db);
  const x = await db.prepare(`
    SELECT i.*, u.usuario AS emitido_por_usuario
      FROM informes i LEFT JOIN usuarios u ON u.id = i.emitido_por
     WHERE i.id = ?`).bind(params.id).first();
  if (!x) throw noEncontrado('Informe no encontrado');
  return {
    ...x,
    filtros: JSON.parse(x.filtros || '{}'),
    firmantes: JSON.parse(x.firmantes || '[]'),
    cifras: JSON.parse(x.cifras || '{}'),
  };
}, ['principal']);

/**
 * Emitir. Calcula, congela y numera.
 *
 * El consecutivo sale del máximo y con reintento, igual que el de los viajes
 * (D36): un número borrado deja hueco y la serie sigue.
 */
ruta('POST', '/api/informes', async ({ db, sesion, cuerpo }) => {
  await asegurarEsquema(db);

  const desde = String(cuerpo.desde || '').slice(0, 10);
  const hasta = String(cuerpo.hasta || '').slice(0, 10);
  const esFecha = f => /^\d{4}-\d{2}-\d{2}$/.test(f);
  if (!esFecha(desde) || !esFecha(hasta)) throw malaPeticion('El período no es válido');
  if (desde > hasta) throw malaPeticion('La fecha inicial es posterior a la final');

  const firmantesPedidos = Array.isArray(cuerpo.firmantes) ? cuerpo.firmantes : [];
  if (!firmantesPedidos.length) throw malaPeticion('Escoja al menos un firmante');
  if (firmantesPedidos.length > 6) throw malaPeticion('Son demasiados firmantes para una hoja');

  // Los datos del firmante NO se toman de lo que mande el navegador: se leen
  // de la base por su id. Si no, cualquiera podría emitir un informe firmado a
  // nombre de quien quisiera, con el cargo que se le ocurriera.
  const firmantes = [];
  for (const f of firmantesPedidos) {
    const u = await db.prepare(`
      SELECT u.id, u.usuario, u.rol,
             TRIM(IFNULL(p.nombres,'') || ' ' || IFNULL(p.apellidos,'')) AS nombre,
             p.cargo, p.tipo_doc, p.numero_doc
        FROM usuarios u LEFT JOIN personas p ON p.id = u.persona_id
       WHERE u.id = ? AND u.activo = 1`).bind(f.usuario_id).first();
    if (!u) throw malaPeticion('Uno de los firmantes escogidos ya no existe o está inactivo');
    if (u.rol !== 'principal') throw malaPeticion(`${u.usuario} no es administrador y no puede firmar`);
    firmantes.push({
      usuario_id: u.id,
      usuario: u.usuario,
      nombre: (u.nombre || '').trim() || u.usuario,
      cargo: u.cargo || null,
      documento: u.numero_doc ? `${u.tipo_doc || 'CC'} ${u.numero_doc}` : null,
      rotulo: String(f.rotulo || '').trim().slice(0, 40) || null,
    });
  }

  const conductorId = Number(cuerpo.conductor_id) || null;
  const vehiculoId = Number(cuerpo.vehiculo_id) || null;
  const filtro = enfoque(conductorId, vehiculoId);

  const cifras = {
    totales: await totalesOperacion(db, desde, hasta, filtro),
    por_vehiculo: await porVehiculo(db, desde, hasta, filtro, vehiculoId),
    por_conductor: await porConductor(db, desde, hasta, filtro, conductorId),
    calidad: await calidadRegistro(db, desde, hasta, filtro),
    por_municipio: await porMunicipio(db, desde, hasta, filtro),
  };

  // El enfoque, en palabras: el papel tiene que decir de qué habla sin que
  // haya que adivinarlo por la ausencia de filas.
  if (vehiculoId) {
    const v = await db.prepare('SELECT placa FROM vehiculos WHERE id = ?').bind(vehiculoId).first();
    cifras.enfoque_vehiculo = v ? v.placa : `#${vehiculoId}`;
  }
  if (conductorId) {
    const c = await db.prepare(
      "SELECT TRIM(nombres || ' ' || IFNULL(apellidos,'')) AS n FROM personas WHERE id = ?")
      .bind(conductorId).first();
    cifras.enfoque_conductor = c ? c.n : `#${conductorId}`;
  }

  const conAnexo = !!cuerpo.con_anexo;
  if (conAnexo) {
    const f = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
    const r = await db.prepare(`
      SELECT t.consecutivo, t.fecha_operacion, v.placa,
             TRIM(p.nombres || ' ' || IFNULL(p.apellidos,'')) AS conductor,
             ms.nombre AS origen, t.lugar_salida, t.ts_salida,
             ml.nombre AS destino, t.lugar_llegada, t.ts_llegada,
             t.km_inicial, t.km_final, t.num_tripulantes, t.tipo_jornada, t.estado
        FROM trayectos t
        LEFT JOIN vehiculos v ON v.id = t.vehiculo_id
        LEFT JOIN personas p ON p.id = t.conductor_id
        LEFT JOIN cat_municipios ms ON ms.id = t.municipio_salida_id
        LEFT JOIN cat_municipios ml ON ml.id = t.municipio_llegada_id
       WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado' ${f.sql}
       ORDER BY t.fecha_operacion, t.ts_salida
       LIMIT ?`).bind(desde, hasta, ...f.args, TOPE_ANEXO + 1).all();
    cifras.anexo = r.results.slice(0, TOPE_ANEXO);
    // Un anexo recortado tiene que DECIR que está recortado. Un soporte al que
    // le faltan filas en silencio es peor que no tener anexo.
    cifras.anexo_recortado = r.results.length > TOPE_ANEXO ? TOPE_ANEXO : 0;
  }

  const titulo = String(cuerpo.titulo || '').trim().slice(0, 120)
    || 'INFORME ESTADÍSTICO DE OPERACIÓN — MISIÓN MÉDICA';
  const observaciones = String(cuerpo.observaciones || '').trim().slice(0, 2000) || null;
  const ts = ahora();

  const consecutivo = await conConsecutivo(db, 'INF', 'informes', async (num) => {
    await db.prepare(`
      INSERT INTO informes (consecutivo, ts, emitido_por, titulo, desde, hasta,
                            filtros, firmantes, cifras, con_anexo, observaciones)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(num, ts, sesion.id, titulo, desde, hasta,
            JSON.stringify({ conductor_id: conductorId, vehiculo_id: vehiculoId }),
            JSON.stringify(firmantes), JSON.stringify(cifras),
            conAnexo ? 1 : 0, observaciones).run();
    return num;
  });

  const fila = await db.prepare('SELECT id FROM informes WHERE consecutivo = ?')
    .bind(consecutivo).first();
  await auditar(db, sesion, 'emitir', 'informes', fila.id, null,
                { consecutivo, desde, hasta, firmantes: firmantes.map(f => f.usuario) });

  return {
    id: fila.id, consecutivo, ts, titulo, desde, hasta,
    emitido_por_usuario: sesion.usuario,
    filtros: { conductor_id: conductorId, vehiculo_id: vehiculoId },
    firmantes, cifras, con_anexo: conAnexo ? 1 : 0, observaciones,
  };
}, ['principal']);

// ════════════════════════════════════════════════════════════════════════
// index.js
// ════════════════════════════════════════════════════════════════════════
/**
 * FLOTA VEHICULAR HRNO — punto de entrada del Worker
 *
 * ESE Hospital Regional Noroccidental · Coordinación de Salud Pública
 *
 * Reglas transversales que la API hace cumplir:
 *   1. La hora de toda marca la pone el servidor, nunca el dispositivo.
 *   2. Solo el rol principal crea usuarios y modifica parámetros.
 *   3. El conductor no puede corregir una marca ya registrada.
 *   4. Todo cambio de itinerario deja rastro visible en itinerario_cambios.
 *   5. Un destino ya usado se desactiva, jamás se borra.
 */

// El sólo hecho de importarlos registra sus rutas en el router.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cabecerasCors = cors(request.headers.get('Origin'), env.ORIGENES_PERMITIDOS);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cabecerasCors });
    }

    // Sonda de salud, sin sesión: sirve para verificar el despliegue.
    if (url.pathname === '/api/salud') {
      return json({ ok: true, servicio: 'flota-hrno', version: VERSION_API,
                    rutas: totalRutas(), ts: ahora() }, 200, cabecerasCors);
    }

    // Diagnóstico: prueba cada pieza por separado y dice cuál falla.
    // No expone secretos, solo si están definidos.
    if (url.pathname === '/api/diag') {
      return diagnostico(env, cabecerasCors);
    }

    // Creación del primer usuario principal. Solo funciona si la tabla de
    // usuarios está vacía y quien llama conoce el secreto CLAVE_ADMIN_INICIAL,
    // que vive fuera del repositorio. Después de eso queda inerte para siempre.
    if (url.pathname === '/api/instalar' && request.method === 'POST') {
      return instalar(request, env, cabecerasCors);
    }

    const encontrada = resolver(request.method, url.pathname);
    if (!encontrada) {
      return json({ error: 'Ruta no encontrada', ruta: url.pathname }, 404, cabecerasCors);
    }

    try {
      let sesion = null;
      if (encontrada.roles) {
        sesion = await sesionActual(env.DB, request);
        if (!sesion) throw new ErrorApi(401, 'Sesión no válida o expirada');
        if (!encontrada.roles.includes(sesion.rol)) {
          throw new ErrorApi(403, 'Su rol no permite esta acción');
        }
      }

      let cuerpo = {};
      if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
        const texto = await request.text();
        if (texto) {
          try { cuerpo = JSON.parse(texto); }
          catch { throw new ErrorApi(400, 'El cuerpo de la petición no es JSON válido'); }
        }
      }

      // Lo que pide la coordinación NO se aplica: se guarda y espera al
      // administrador (D41). Se intercepta aquí, en el único sitio por el que
      // pasan todas las rutas, y no dentro de cada manejador: una ruta nueva
      // que se olvidara de pedir permiso sería una puerta abierta, y el olvido
      // no se vería hasta que alguien lo usara.
      if (necesitaAprobacion(sesion, request.method, encontrada.patron)) {
        const pendiente = await registrarSolicitud(env.DB, sesion, {
          metodo: request.method, patron: encontrada.patron,
          ruta: url.pathname + url.search, params: encontrada.params, cuerpo, url,
        });
        return json(pendiente, 202, cabecerasCors);
      }

      const resultado = await encontrada.manejador({
        db: env.DB, env, sesion, cuerpo, params: encontrada.params, url, request,
      });
      return json(resultado === undefined ? { ok: true } : resultado, 200, cabecerasCors);

    } catch (e) {
      if (e instanceof ErrorApi) {
        return json({ error: e.message }, e.status, cabecerasCors);
      }
      // Restricciones de la base traducidas a algo legible para quien usa la app.
      const m = String(e && e.message || e);
      if (m.includes('UNIQUE constraint failed')) {
        return json({ error: 'Ya existe un registro con esos datos', detalle: m },
                    409, cabecerasCors);
      }
      if (m.includes('FOREIGN KEY constraint failed')) {
        return json({ error: 'El registro referenciado no existe', detalle: m },
                    400, cabecerasCors);
      }
      console.error('Error no controlado:', m);
      // Se incluye el mensaje: es una herramienta institucional interna y sin
      // él cada fallo cuesta un viaje de ida y vuelta para diagnosticarlo.
      return json({ error: 'Error interno del servidor', detalle: m }, 500, cabecerasCors);
    }
  },
};

/**
 * Instalación inicial. Deliberadamente irrepetible: en cuanto existe un usuario
 * queda cerrada, para que nadie pueda crearse un administrador más adelante.
 */
async function instalar(request, env, cabeceras) {
  const existentes = await env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios').first();
  if (existentes && existentes.n > 0) {
    return json({ error: 'El sistema ya está instalado' }, 409, cabeceras);
  }
  if (!env.CLAVE_ADMIN_INICIAL) {
    return json({ error: 'Falta configurar el secreto CLAVE_ADMIN_INICIAL' }, 500, cabeceras);
  }

  let cuerpo = {};
  try { cuerpo = JSON.parse(await request.text() || '{}'); } catch { /* cuerpo vacío */ }
  if (cuerpo.clave_instalacion !== env.CLAVE_ADMIN_INICIAL) {
    return json({ error: 'Clave de instalación incorrecta' }, 403, cabeceras);
  }

  const usuario = (cuerpo.usuario || 'admin').trim().toLowerCase();
  const clave = cuerpo.clave || env.CLAVE_ADMIN_INICIAL;

  const r = await env.DB.prepare(`
    INSERT INTO usuarios (usuario, correo, clave_hash, rol, activo,
                          debe_cambiar_clave, creado_en)
    VALUES (?,?,?, 'principal', 1, 1, ?)`)
    .bind(usuario, cuerpo.correo || null, await hashClave(clave), ahora()).run();

  await env.DB.prepare(`
    INSERT INTO auditoria (ts, usuario_id, rol, accion, entidad, entidad_id)
    VALUES (?,?, 'principal', 'crear', 'usuarios', ?)`)
    .bind(ahora(), r.meta.last_row_id, r.meta.last_row_id).run();

  return json({
    ok: true,
    usuario,
    id: r.meta.last_row_id,
    nota: 'Debe cambiar la clave en el primer ingreso',
  }, 200, cabeceras);
}

/**
 * Reporta el estado de cada dependencia del Worker: el enlace con la base, una
 * consulta real, los secretos definidos (solo si existen, nunca su valor) y si
 * el runtime acepta PBKDF2 con distintos números de iteraciones.
 */
async function diagnostico(env, cabeceras) {
  const r = {
    ts: ahora(),
    version: VERSION_API,
    enlace_db: !!env.DB,
    origenes_permitidos: env.ORIGENES_PERMITIDOS || null,
    horas_sesion: env.HORAS_SESION || null,
    clave_instalacion_definida: !!env.CLAVE_ADMIN_INICIAL,
  };

  if (env.DB) {
    try {
      const f = await env.DB.prepare('SELECT COUNT(*) AS n FROM usuarios').first();
      r.consulta_db = 'ok';
      r.usuarios_registrados = f.n;
    } catch (e) {
      r.consulta_db = 'FALLA: ' + (e && e.message || e);
    }
  } else {
    r.consulta_db = 'FALLA: no hay enlace llamado DB';
  }

  r.pbkdf2 = {};
  for (const iter of [1000, 50000, 100000, 120000, 250000]) {
    try {
      await hashClave('prueba', new Uint8Array(16), iter);
      r.pbkdf2[iter] = 'ok';
    } catch (e) {
      r.pbkdf2[iter] = 'FALLA: ' + (e && e.message || e);
    }
  }

  return json(r, 200, cabeceras);
}
