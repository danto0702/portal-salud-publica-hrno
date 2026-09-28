/**
 * FLOTA VEHICULAR HRNO — rutas de operación
 * Itinerario, trayectos con GPS, checklist, eventos, días y dashboard.
 */

import { ruta } from './router.js';
import {
  ahora, hoyISO, malaPeticion, prohibido, noEncontrado,
  auditar, recalcularDia, marcarUsoDestino, resolverDestino, siguienteConsecutivo,
  fueraDeServicio, TODOS, GESTION,
} from './lib.js';



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
