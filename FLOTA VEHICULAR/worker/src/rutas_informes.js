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
 * Calcula TODO lo que va impreso, para un período y un enfoque.
 *
 * Lo usan emitir y reemitir, que es justamente el punto de la reemisión: el
 * mismo período y el mismo alcance, vueltos a calcular sobre los datos de
 * hoy. Si cada una tuviera su propio cálculo, una versión 2 podría diferir de
 * su versión 1 por algo que no fueran los datos.
 */
async function calcularCifras(db, desde, hasta, conductorId, vehiculoId, conAnexo) {
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
  return cifras;
}

/**
 * Resuelve quiénes firman, leyendo sus datos DE LA BASE.
 *
 * Nunca de lo que mande el navegador: si no, cualquiera podría emitir un
 * informe firmado a nombre de quien quisiera y con el cargo que se le
 * ocurriera. Del cuerpo solo se toman el id y el rótulo.
 */
async function resolverFirmantes(db, pedidos) {
  if (!Array.isArray(pedidos) || !pedidos.length) throw malaPeticion('Escoja al menos un firmante');
  if (pedidos.length > 6) throw malaPeticion('Son demasiados firmantes para una hoja');
  const firmantes = [];
  for (const f of pedidos) {
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
  return firmantes;
}

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
           i.filtros, i.firmantes, i.version, i.ts_version, i.motivo_reemision,
           u.usuario AS emitido_por_usuario, ur.usuario AS reemitido_por_usuario
      FROM informes i
      LEFT JOIN usuarios u  ON u.id = i.emitido_por
      LEFT JOIN usuarios ur ON ur.id = i.reemitido_por
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

  const firmantes = await resolverFirmantes(db, cuerpo.firmantes);
  const conductorId = Number(cuerpo.conductor_id) || null;
  const vehiculoId = Number(cuerpo.vehiculo_id) || null;
  const conAnexo = !!cuerpo.con_anexo;
  const cifras = await calcularCifras(db, desde, hasta, conductorId, vehiculoId, conAnexo);

  const titulo = String(cuerpo.titulo || '').trim().slice(0, 120)
    || 'INFORME ESTADÍSTICO DE OPERACIÓN — MISIÓN MÉDICA';
  const observaciones = String(cuerpo.observaciones || '').trim().slice(0, 2000) || null;
  const ts = ahora();

  const consecutivo = await conConsecutivo(db, 'INF', 'informes', async (num) => {
    await db.prepare(`
      INSERT INTO informes (consecutivo, ts, emitido_por, titulo, desde, hasta,
                            filtros, firmantes, cifras, con_anexo, observaciones,
                            version, ts_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 1, ?)`)
      .bind(num, ts, sesion.id, titulo, desde, hasta,
            JSON.stringify({ conductor_id: conductorId, vehiculo_id: vehiculoId }),
            JSON.stringify(firmantes), JSON.stringify(cifras),
            conAnexo ? 1 : 0, observaciones, ts).run();
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
    version: 1, ts_version: ts,
  };
}, ['principal']);

/**
 * Reemitir: el MISMO radicado, vuelto a calcular sobre los datos de hoy (D43).
 *
 * Hace falta cuando el informe ya se radicó —el número está anotado en el
 * libro, o ya se mandó al contratista— y después se corrigió un viaje. Pedir
 * un número nuevo obligaría a radicar otra vez y a explicar por qué hay dos.
 *
 * Pero un radicado con dos contenidos distintos y sin forma de distinguirlos
 * es peor que no tener esta función: por eso cada reemisión lleva VERSIÓN, la
 * anterior se archiva entera en vez de pisarse, y el papel dice en la primera
 * página a cuál sustituye y por qué. El motivo es obligatorio: es lo único que
 * contesta «¿por qué el 000012 dice hoy otra cosa que en noviembre?».
 *
 * El período y el alcance NO se pueden cambiar. Con otro período sería otro
 * informe, y reutilizarle el radicado sería esconder uno nuevo dentro de uno
 * viejo. Lo que sí cambia: las cifras, los firmantes y las observaciones.
 */
ruta('POST', '/api/informes/:id/reemitir', async ({ db, sesion, params, cuerpo }) => {
  await asegurarEsquema(db);
  const actual = await db.prepare('SELECT * FROM informes WHERE id = ?').bind(params.id).first();
  if (!actual) throw noEncontrado('Informe no encontrado');

  const motivo = String((cuerpo && cuerpo.motivo) || '').trim();
  if (motivo.length < 10) {
    throw malaPeticion('Escriba por qué se reemite: queda impreso en el documento '
                     + 'y es lo que explica el cambio (mínimo 10 letras)');
  }

  const firmantes = await resolverFirmantes(db, cuerpo.firmantes);
  const filtros = JSON.parse(actual.filtros || '{}');
  const conAnexo = cuerpo.con_anexo === undefined ? !!actual.con_anexo : !!cuerpo.con_anexo;
  const cifras = await calcularCifras(db, actual.desde, actual.hasta,
                                      filtros.conductor_id || null,
                                      filtros.vehiculo_id || null, conAnexo);

  const ts = ahora();
  const versionAnterior = actual.version || 1;
  const nueva = versionAnterior + 1;

  // Primero se archiva la que sale, y solo después se pisa la vigente: si
  // fallara en medio, se habría perdido lo que alguien ya firmó.
  await db.prepare(`
    INSERT INTO informe_versiones (informe_id, version, ts, emitido_por, firmantes,
                                   cifras, con_anexo, observaciones,
                                   sustituida_en, sustituida_por, motivo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(actual.id, versionAnterior, actual.ts_version || actual.ts, actual.emitido_por,
          actual.firmantes, actual.cifras, actual.con_anexo, actual.observaciones,
          ts, sesion.id, motivo).run();

  const observaciones = cuerpo.observaciones !== undefined
    ? (String(cuerpo.observaciones).trim().slice(0, 2000) || null)
    : actual.observaciones;

  await db.prepare(`
    UPDATE informes SET firmantes = ?, cifras = ?, con_anexo = ?, observaciones = ?,
                        version = ?, ts_version = ?, motivo_reemision = ?, reemitido_por = ?
     WHERE id = ?`)
    .bind(JSON.stringify(firmantes), JSON.stringify(cifras), conAnexo ? 1 : 0,
          observaciones, nueva, ts, motivo, sesion.id, actual.id).run();

  await auditar(db, sesion, 'reemitir', 'informes', actual.id,
                { version: versionAnterior },
                { consecutivo: actual.consecutivo, version: nueva, motivo });

  return {
    id: actual.id, consecutivo: actual.consecutivo, ts: actual.ts,
    titulo: actual.titulo, desde: actual.desde, hasta: actual.hasta,
    emitido_por_usuario: sesion.usuario,
    filtros, firmantes, cifras, con_anexo: conAnexo ? 1 : 0, observaciones,
    version: nueva, ts_version: ts, motivo_reemision: motivo,
    sustituye_a: versionAnterior,
  };
}, ['principal']);

/** Las versiones que quedaron sustituidas, para poder volver a bajarlas. */
ruta('GET', '/api/informes/:id/versiones', async ({ db, params }) => {
  await asegurarEsquema(db);
  const r = await db.prepare(`
    SELECT v.id, v.version, v.ts, v.sustituida_en, v.motivo, v.con_anexo,
           u.usuario AS emitido_por_usuario, us.usuario AS sustituida_por_usuario
      FROM informe_versiones v
      LEFT JOIN usuarios u  ON u.id = v.emitido_por
      LEFT JOIN usuarios us ON us.id = v.sustituida_por
     WHERE v.informe_id = ? ORDER BY v.version DESC`).bind(params.id).all();
  return r.results;
}, ['principal']);

/** Una versión sustituida, tal cual se imprimió en su momento. */
ruta('GET', '/api/informes/:id/versiones/:v', async ({ db, params }) => {
  await asegurarEsquema(db);
  const inf = await db.prepare('SELECT * FROM informes WHERE id = ?').bind(params.id).first();
  if (!inf) throw noEncontrado('Informe no encontrado');
  const v = await db.prepare(
    'SELECT * FROM informe_versiones WHERE informe_id = ? AND version = ?')
    .bind(params.id, params.v).first();
  if (!v) throw noEncontrado('Esa versión no existe');
  const u = await db.prepare('SELECT usuario FROM usuarios WHERE id = ?')
    .bind(v.emitido_por).first();
  return {
    id: inf.id, consecutivo: inf.consecutivo, ts: inf.ts, titulo: inf.titulo,
    desde: inf.desde, hasta: inf.hasta,
    emitido_por_usuario: u ? u.usuario : null,
    filtros: JSON.parse(inf.filtros || '{}'),
    firmantes: JSON.parse(v.firmantes || '[]'),
    cifras: JSON.parse(v.cifras || '{}'),
    con_anexo: v.con_anexo, observaciones: v.observaciones,
    version: v.version, ts_version: v.ts,
    sustituida_en: v.sustituida_en, motivo_sustitucion: v.motivo,
  };
}, ['principal']);
