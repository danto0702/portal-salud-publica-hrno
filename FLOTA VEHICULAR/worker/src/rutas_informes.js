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

import { ruta } from './router.js';
import {
  ahora, hoyISO, malaPeticion, noEncontrado, auditar, asegurarEsquema,
  conConsecutivo,
} from './lib.js';
import {
  enfoque, porVehiculo, porConductor, totalesOperacion, calidadRegistro,
  porMunicipio,
} from './estadistica.js';

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
