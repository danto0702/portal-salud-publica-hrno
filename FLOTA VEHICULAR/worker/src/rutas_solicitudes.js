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

import { ruta, resolver } from './router.js';
import {
  GESTION, ahora, hoyISO, malaPeticion, noEncontrado, prohibido,
  auditar, asegurarEsquema, vencerSolicitudes,
} from './lib.js';

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
