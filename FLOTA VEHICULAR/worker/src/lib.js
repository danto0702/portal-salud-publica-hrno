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
const VERSION_API = 18;

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

export {
  VERSION_API, TODOS, GESTION, CAUSAS,
  ahora, hoyISO, cors, json, ErrorApi,
  malaPeticion, noAutorizado, prohibido, noEncontrado,
  hashClave, verificarClave,
  sesionActual, exigirRol, auditar,
  recalcularDia, marcarUsoDestino, resolverDestino, siguienteConsecutivo,
  conConsecutivo, asegurarEsquema, fueraDeServicio,
  REQUIERE_APROBACION, necesitaAprobacion, registrarSolicitud,
  describirSolicitud, vencerSolicitudes, TEXTO_JORNADA,
};
