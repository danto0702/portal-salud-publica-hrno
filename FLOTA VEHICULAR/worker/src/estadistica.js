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
export const enfoque = (conductorId, vehiculoId) => (cols) => {
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
export async function porVehiculo(db, desde, hasta, filtro, vehiculoId) {
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
export async function porConductor(db, desde, hasta, filtro, conductorId) {
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
export async function totalesOperacion(db, desde, hasta, filtro) {
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
export async function calidadRegistro(db, desde, hasta, filtro) {
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
export async function porMunicipio(db, desde, hasta, filtro) {
  const f = filtro({ conductor: 't.conductor_id', vehiculo: 't.vehiculo_id' });
  const r = await db.prepare(`
    SELECT IFNULL(m.nombre, 'Sin registrar') AS municipio, COUNT(*) AS trayectos
      FROM trayectos t
      LEFT JOIN cat_municipios m ON m.id = t.municipio_llegada_id
     WHERE t.fecha_operacion BETWEEN ? AND ? AND t.estado != 'anulado' ${f.sql}
     GROUP BY m.nombre ORDER BY trayectos DESC`).bind(desde, hasta, ...f.args).all();
  return r.results;
}
