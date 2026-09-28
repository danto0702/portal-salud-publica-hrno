/**
 * FLOTA VEHICULAR HRNO — Worker completo en un solo archivo
 *
 * ESE Hospital Regional Noroccidental · Coordinación de Salud Pública
 *
 * ARCHIVO GENERADO — no editar a mano.
 * Se produce con:  node construir_bundle.mjs
 * El código fuente está en src/ (router, lib, rutas_admin, rutas_operacion,
 * rutas_fuera_servicio, index).
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
const VERSION_API = 10;

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

async function siguienteConsecutivo(db, prefijo, tabla) {
  const anio = hoyISO().slice(0, 4);
  const fila = await db.prepare(
    `SELECT COUNT(*) AS n FROM ${tabla} WHERE consecutivo LIKE ?`)
    .bind(`${prefijo}-${anio}-%`).first();
  const n = String((fila ? fila.n : 0) + 1).padStart(6, '0');
  return `${prefijo}-${anio}-${n}`;
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

/** Copia la programación de un rango a otro, para no reprogramar desde cero. */
ruta('POST', '/api/itinerario/copiar', async ({ db, sesion, cuerpo }) => {
  const { desde, hasta, destino_desde } = cuerpo;
  if (!desde || !hasta || !destino_desde) {
    throw malaPeticion('Se requieren desde, hasta y destino_desde');
  }
  const origen = await db.prepare(
    "SELECT * FROM itinerarios WHERE fecha BETWEEN ? AND ? AND estado != 'cancelado'")
    .bind(desde, hasta).all();

  const dias = Math.round(
    (Date.parse(destino_desde) - Date.parse(desde)) / 86400000);
  let creados = 0, omitidos = 0;

  for (const it of origen.results) {
    const nueva = new Date(Date.parse(it.fecha) + dias * 86400000)
      .toISOString().slice(0, 10);
    const choque = await db.prepare(
      "SELECT id FROM itinerarios WHERE fecha = ? AND vehiculo_id = ? AND estado != 'cancelado'")
      .bind(nueva, it.vehiculo_id).first();
    if (choque) { omitidos++; continue; }
    await db.prepare(`
      INSERT INTO itinerarios (fecha, vehiculo_id, conductor_id, municipio_id,
                               destino_id, destino_texto, tipo_jornada, observaciones,
                               estado, creado_por, creado_en)
      VALUES (?,?,?,?,?,?,?,?,'programado',?,?)`)
      .bind(nueva, it.vehiculo_id, it.conductor_id, it.municipio_id, it.destino_id,
            it.destino_texto, it.tipo_jornada, it.observaciones, sesion.id, ahora()).run();
    await recalcularDia(db, nueva, it.vehiculo_id);
    creados++;
  }
  await auditar(db, sesion, 'crear', 'itinerarios', null, null,
                { copiados: creados, omitidos });
  return { creados, omitidos };
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
            VALUES (?,?,?,?,?,?, 'Carga desde plantilla de Excel')`)
            .bind(op.id, ahora(), sesion.id, campo,
                  antes[campo] != null ? String(antes[campo]) : null, String(val)).run();
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
                { origen: 'plantilla de Excel', ...resultados,
                  errores: resultados.errores.length });
  return resultados;
}, GESTION);

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

  const consecutivo = await siguienteConsecutivo(db, 'TR', 'trayectos');
  const ts = ahora();

  const r = await db.prepare(`
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
          cuerpo.observaciones || null, sesion.id, ts).run();

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
 * Corrección de una marca ya registrada.
 * El conductor NO puede hacerlo: si pudiera editar su propia marca, el soporte
 * de pago no probaría nada. Reporta el error como novedad y coordinación corrige,
 * quedando el cambio en auditoría.
 */
ruta('PUT', '/api/trayectos/:id', async ({ db, sesion, params, cuerpo }) => {
  const antes = await db.prepare('SELECT * FROM trayectos WHERE id = ?').bind(params.id).first();
  if (!antes) throw noEncontrado('Trayecto no encontrado');
  if (!cuerpo.motivo) throw malaPeticion('Toda corrección exige un motivo');

  const campos = ['municipio_salida_id', 'lugar_salida', 'ts_salida',
    'municipio_llegada_id', 'lugar_llegada', 'ts_llegada',
    'km_inicial', 'km_final', 'num_tripulantes', 'observaciones', 'estado'];
  const set = [], valores = [];
  for (const c of campos) {
    if (cuerpo[c] !== undefined) { set.push(`${c} = ?`); valores.push(cuerpo[c]); }
  }
  if (!set.length) return { ok: true, sin_cambios: true };
  valores.push(params.id);
  await db.prepare(`UPDATE trayectos SET ${set.join(', ')} WHERE id = ?`).bind(...valores).run();

  await recalcularDia(db, antes.fecha_operacion, antes.vehiculo_id);
  await auditar(db, sesion, 'editar', 'trayectos', params.id, antes,
                { ...cuerpo, motivo: cuerpo.motivo });
  return { ok: true };
}, GESTION);

ruta('GET', '/api/trayectos', async ({ db, url, sesion }) => {
  const desde = url.searchParams.get('desde') || hoyISO();
  const hasta = url.searchParams.get('hasta') || desde;
  const vehiculo = url.searchParams.get('vehiculo_id');

  const cond = ['t.fecha_operacion BETWEEN ? AND ?', "t.estado != 'anulado'"];
  const args = [desde, hasta];
  if (vehiculo) { cond.push('t.vehiculo_id = ?'); args.push(vehiculo); }
  if (sesion.rol === 'conductor') { cond.push('t.conductor_id = ?'); args.push(sesion.persona_id); }

  const r = await db.prepare(`
    SELECT t.*, v.placa,
           p.nombres || ' ' || IFNULL(p.apellidos,'') AS conductor,
           ms.nombre AS municipio_salida, ml.nombre AS municipio_llegada,
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
     WHERE ${cond.join(' AND ')}
     ORDER BY t.fecha_operacion DESC, t.ts_salida DESC`).bind(...args).all();
  return r.results;
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
        const consecutivo = await siguienteConsecutivo(db, 'TR', 'trayectos');
        const r = await db.prepare(`
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
                m.km_inicial || null, sesion.id, ahora()).run();
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
     ORDER BY e.ts_evento DESC LIMIT 500`).bind(...args).all();
  return r.results;
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

  const porVehiculo = await db.prepare(`
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
             ON d.vehiculo_id = v.id AND d.fecha BETWEEN ? AND ?
     WHERE v.activo = 1
     GROUP BY v.id
     ORDER BY dias_con_desplazamiento DESC, dias_pagables DESC`).bind(desde, hasta).all();

  const totales = await db.prepare(`
    SELECT SUM(programado) AS programados, SUM(ejecutado) AS ejecutados,
           SUM(dia_pagable) AS pagables, SUM(num_trayectos) AS trayectos,
           ROUND(SUM(horas_operacion), 1) AS horas, SUM(km_dia) AS km
      FROM dias_operacion WHERE fecha BETWEEN ? AND ?`).bind(desde, hasta).first();

  const porMunicipio = await db.prepare(`
    SELECT IFNULL(m.nombre, 'Sin registrar') AS municipio, COUNT(*) AS trayectos
      FROM trayectos t
      LEFT JOIN cat_municipios m ON m.id = t.municipio_llegada_id
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado'
     GROUP BY m.nombre ORDER BY trayectos DESC`).bind(desde, hasta).all();

  const porDia = await db.prepare(`
    SELECT fecha_operacion AS fecha, COUNT(*) AS trayectos
      FROM trayectos WHERE fecha_operacion BETWEEN ? AND ? AND estado != 'anulado'
     GROUP BY fecha_operacion ORDER BY fecha_operacion`).bind(desde, hasta).all();

  const porDestino = await db.prepare(`
    SELECT IFNULL(d.nombre, i.destino_texto) AS destino, COUNT(*) AS veces
      FROM itinerarios i LEFT JOIN cat_destinos d ON d.id = i.destino_id
     WHERE i.fecha BETWEEN ? AND ? AND i.estado != 'cancelado'
     GROUP BY destino ORDER BY veces DESC LIMIT 15`).bind(desde, hasta).all();

  const eventos = await db.prepare(`
    SELECT tipo, COUNT(*) AS n FROM eventos
     WHERE date(ts_evento) BETWEEN ? AND ?
     GROUP BY tipo ORDER BY n DESC`).bind(desde, hasta).all();

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
     WHERE v.activo = 1 GROUP BY v.id ORDER BY v.placa`)
    .bind(desde, hasta, desde, hasta).all();

  const vencimientos = await db.prepare(`
    SELECT 'vehiculo' AS ambito, v.placa AS titular, dv.tipo, dv.vencimiento,
           CAST(julianday(dv.vencimiento) - julianday('now') AS INTEGER) AS dias
      FROM documentos_vehiculo dv JOIN vehiculos v ON v.id = dv.vehiculo_id
     WHERE dv.vencimiento IS NOT NULL
       AND julianday(dv.vencimiento) - julianday('now') <= 30
    UNION ALL
    SELECT 'persona', p.nombres || ' ' || IFNULL(p.apellidos,''), dp.tipo, dp.vencimiento,
           CAST(julianday(dp.vencimiento) - julianday('now') AS INTEGER)
      FROM documentos_persona dp JOIN personas p ON p.id = dp.persona_id
     WHERE dp.vencimiento IS NOT NULL
       AND julianday(dp.vencimiento) - julianday('now') <= 30
     ORDER BY dias`).all();

  const marcas = await db.prepare(`
    SELECT origen_salida AS origen, COUNT(*) AS n
      FROM trayectos WHERE fecha_operacion BETWEEN ? AND ? AND origen_salida IS NOT NULL
     GROUP BY origen_salida`).bind(desde, hasta).all();

  return {
    periodo: { desde, hasta },
    totales: totales || {},
    por_vehiculo: porVehiculo.results,
    por_municipio: porMunicipio.results,
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

const CAUSAS = ['averia', 'mantenimiento', 'accidente', 'documentos',
                'retenido', 'sin_conductor', 'otro'];

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
