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
const VERSION_API = 13;

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

export {
  VERSION_API, TODOS, GESTION,
  ahora, hoyISO, cors, json, ErrorApi,
  malaPeticion, noAutorizado, prohibido, noEncontrado,
  hashClave, verificarClave,
  sesionActual, exigirRol, auditar,
  recalcularDia, marcarUsoDestino, resolverDestino, siguienteConsecutivo,
  conConsecutivo, asegurarEsquema, fueraDeServicio,
};
