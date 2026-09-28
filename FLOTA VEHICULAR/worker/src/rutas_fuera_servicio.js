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
import { ruta } from './router.js';
import {
  ahora, hoyISO, malaPeticion, prohibido, noEncontrado,
  auditar, recalcularDia, asegurarEsquema, TODOS, GESTION,
} from './lib.js';

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
