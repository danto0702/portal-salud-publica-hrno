// datos.js — Capa de acceso a datos (Supabase)
// Todas las consultas pasan por RLS: lo que el usuario no puede ver no llega
// al navegador. Las comprobaciones de rol que hay aquí son para la interfaz,
// la barrera real está en la base de datos.

(function (global) {
  'use strict';

  var sb = function () { return DNTAuth.sb; };
  var BUCKET = 'dnt-soportes';

  function slug(municipio) { return String(municipio || '').replace(/ /g, '_'); }
  function lanzar(r) { if (r.error) throw new Error(r.error.message); return r.data; }

  // ═══ Catálogos ═══════════════════════════════════════════════════
  var _cache = {};
  async function catalogos(refrescar) {
    if (_cache.listo && !refrescar) return _cache;
    var r = await Promise.all([
      sb().from('dnt_checklist_catalogo').select('*').eq('activo', true).order('lista').order('orden'),
      sb().from('dnt_factores_catalogo').select('*').eq('activo', true).order('orden'),
      sb().from('dnt_sedes').select('*').eq('activo', true).order('nombre')
    ]);
    _cache = {
      checklist: lanzar(r[0]),
      factores:  lanzar(r[1]),
      sedes:     lanzar(r[2]),
      listo: true
    };
    return _cache;
  }
  function checklistDe(lista) {
    return (_cache.checklist || []).filter(function (i) { return i.lista === lista; });
  }
  function itemChecklist(codigo) {
    return (_cache.checklist || []).filter(function (i) { return i.codigo === codigo; })[0];
  }

  // ═══ Casos ═══════════════════════════════════════════════════════
  async function casos(f) {
    f = f || {};
    var q = sb().from('dnt_v_casos_detalle').select('*');
    if (f.municipio)      q = q.eq('municipio', f.municipio);
    if (f.estado)         q = q.eq('estado', f.estado);
    if (f.responsable_id) q = q.eq('responsable_id', f.responsable_id);
    if (f.abiertos === true)  q = q.is('fecha_cierre', null);
    if (f.abiertos === false) q = q.not('fecha_cierre', 'is', null);
    if (f.texto) {
      var t = '%' + f.texto.trim() + '%';
      q = q.or('nombre.ilike.' + t + ',num_doc.ilike.' + t);
    }
    return lanzar(await q.order('fecha_proximo_control', { ascending: true, nullsFirst: false }).limit(f.limite || 2000));
  }

  async function caso(id) {
    var r = await Promise.all([
      sb().from('dnt_v_casos_detalle').select('*').eq('id', id).single(),
      sb().from('dnt_casos').select('*, dnt_ninos(*)').eq('id', id).single(),
      sb().from('dnt_seguimientos').select('*').eq('caso_id', id).order('fecha'),
      sb().from('dnt_caso_factores').select('*').eq('caso_id', id),
      sb().from('dnt_checklist_respuestas').select('*').eq('caso_id', id),
      sb().from('dnt_soportes').select('*').eq('caso_id', id).eq('eliminado', false).order('subido_en', { ascending: false })
    ]);
    return {
      vista:        lanzar(r[0]),
      caso:         lanzar(r[1]),
      nino:         lanzar(r[1]).dnt_ninos,
      seguimientos: lanzar(r[2]),
      factores:     lanzar(r[3]),
      checklist:    lanzar(r[4]),
      soportes:     lanzar(r[5])
    };
  }

  async function buscarNino(tipoDoc, numDoc) {
    var r = await sb().from('dnt_ninos').select('*').eq('tipo_doc', tipoDoc).eq('num_doc', String(numDoc).trim()).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }

  /**
   * Comprueba si un documento ya existe. Sirve al importador y al formulario:
   *   · existe en el mismo municipio → no se carga de nuevo (B11)
   *   · existe en otro municipio     → se avisa para que lo resuelva un coordinador
   * Si el niño está en un municipio fuera del alcance del usuario, RLS oculta la
   * fila; por eso se consulta también el conteo, que sí atraviesa la política.
   */
  async function verificarDuplicado(tipoDoc, numDoc, municipio) {
    var visible = await buscarNino(tipoDoc, numDoc);
    if (visible) {
      return visible.municipio === municipio
        ? { estado: 'duplicado_mismo_municipio', nino: visible }
        : { estado: 'duplicado_otro_municipio', nino: visible, municipio: visible.municipio };
    }
    return { estado: 'nuevo' };
  }

  async function guardarNino(datos) {
    var u = DNTAuth.usuario();
    var fila = Object.assign({}, datos);
    if (!fila.id) fila.creado_por = u.id;
    var r = fila.id
      ? await sb().from('dnt_ninos').update(fila).eq('id', fila.id).select().single()
      : await sb().from('dnt_ninos').insert(fila).select().single();
    return lanzar(r);
  }

  async function guardarCaso(datos) {
    var u = DNTAuth.usuario();
    var fila = Object.assign({}, datos);
    if (!fila.id) { fila.creado_por = u.id; if (!fila.responsable_id) fila.responsable_id = u.id; }
    var r = fila.id
      ? await sb().from('dnt_casos').update(fila).eq('id', fila.id).select().single()
      : await sb().from('dnt_casos').insert(fila).select().single();
    var out = lanzar(r);
    DNTAuth.registrar(fila.id ? 'caso_actualizado' : 'caso_creado',
      { entidad: 'dnt_casos', entidad_id: out.id, caso_id: out.id, municipio: out.municipio });
    return out;
  }

  async function cerrarCaso(casoId, datos) {
    var r = await sb().from('dnt_casos').update({
      fecha_cierre: datos.fecha_cierre,
      motivo_cierre: datos.motivo_cierre,
      justificacion_egreso: datos.justificacion_egreso || null,
      egreso_con_pendientes: !!datos.egreso_con_pendientes,
      estado: datos.estado || (datos.motivo_cierre === 'recuperacion' ? 'recuperado' : datos.motivo_cierre)
    }).eq('id', casoId).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('caso_cerrado', { entidad: 'dnt_casos', entidad_id: casoId, caso_id: casoId,
      municipio: out.municipio, detalle: { motivo: datos.motivo_cierre, con_pendientes: !!datos.egreso_con_pendientes } });
    return out;
  }

  async function reabrirCaso(casoId) {
    var r = await sb().from('dnt_casos').update({ fecha_cierre: null, estado: 'ambulatorio' })
      .eq('id', casoId).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('caso_reabierto', { entidad: 'dnt_casos', entidad_id: casoId, caso_id: casoId });
    return out;
  }

  async function reasignarResponsable(casoId, responsableId) {
    var r = await sb().from('dnt_casos').update({ responsable_id: responsableId })
      .eq('id', casoId).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('responsable_reasignado', { entidad: 'dnt_casos', entidad_id: casoId,
      caso_id: casoId, detalle: { responsable_id: responsableId } });
    return out;
  }

  // ═══ Seguimientos ════════════════════════════════════════════════
  async function guardarSeguimiento(datos) {
    var u = DNTAuth.usuario();
    var fila = Object.assign({}, datos);
    if (!fila.id) fila.registrado_por = u.id;
    delete fila.municipio;     // lo impone el trigger a partir del caso
    var r = fila.id
      ? await sb().from('dnt_seguimientos').update(fila).eq('id', fila.id).select().single()
      : await sb().from('dnt_seguimientos').insert(fila).select().single();
    var out = lanzar(r);
    DNTAuth.registrar(fila.id ? 'seguimiento_actualizado' : 'seguimiento_registrado',
      { entidad: 'dnt_seguimientos', entidad_id: out.id, caso_id: out.caso_id, municipio: out.municipio });
    return out;
  }

  // ═══ Factores de riesgo ══════════════════════════════════════════
  async function guardarFactores(casoId, codigosPresentes) {
    var u = DNTAuth.usuario();
    await sb().from('dnt_caso_factores').delete().eq('caso_id', casoId);
    if (codigosPresentes.length) {
      var filas = codigosPresentes.map(function (c) {
        return { caso_id: casoId, factor: c, presente: true, registrado_por: u.id };
      });
      lanzar(await sb().from('dnt_caso_factores').insert(filas));
    }
    var p = DNTClinico.puntajeRiesgo(codigosPresentes, _cache.factores || []);
    lanzar(await sb().from('dnt_casos')
      .update({ puntaje_riesgo: p.puntaje, nivel_riesgo: p.nivel }).eq('id', casoId));
    return p;
  }

  // ═══ Check-lists ═════════════════════════════════════════════════
  async function guardarRespuesta(casoId, item, estado, opciones) {
    var o = opciones || {}, u = DNTAuth.usuario();
    var fila = {
      caso_id: casoId, item: item, estado: estado,
      fecha: o.fecha || new Date().toISOString().slice(0, 10),
      observacion: o.observacion || null,
      seguimiento_id: o.seguimiento_id || null,
      usuario_id: u.id
    };
    var q = sb().from('dnt_checklist_respuestas').select('id').eq('caso_id', casoId).eq('item', item);
    q = o.seguimiento_id ? q.eq('seguimiento_id', o.seguimiento_id) : q.is('seguimiento_id', null);
    var previo = await q.maybeSingle();
    var r = previo.data
      ? await sb().from('dnt_checklist_respuestas').update(fila).eq('id', previo.data.id).select().single()
      : await sb().from('dnt_checklist_respuestas').insert(fila).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('checklist_actualizado', { entidad: 'dnt_checklist_respuestas',
      entidad_id: out.id, caso_id: casoId, detalle: { item: item, estado: estado } });
    return out;
  }

  /**
   * Verifica si el caso cumple los requisitos para el egreso (D28).
   * Devuelve los ítems obligatorios del check-list C que siguen pendientes
   * y los soportes obligatorios que faltan.
   */
  function validarEgreso(datosCaso) {
    var respuestas = {}, soportesPorItem = {};
    datosCaso.checklist.forEach(function (r) {
      if (!r.seguimiento_id) respuestas[r.item] = r.estado;
    });
    datosCaso.soportes.forEach(function (s) {
      if (s.item && s.vigente) soportesPorItem[s.item] = (soportesPorItem[s.item] || 0) + 1;
    });
    var pendientes = [], sinSoporte = [];
    checklistDe('C').forEach(function (it) {
      if (!it.obligatorio) return;
      var e = respuestas[it.codigo];
      if (e !== 'cumple' && e !== 'no_aplica') pendientes.push(it);
      else if (e === 'cumple' && it.requiere_soporte && !soportesPorItem[it.codigo]) sinSoporte.push(it);
    });
    var ultimo = datosCaso.seguimientos[datosCaso.seguimientos.length - 1];
    var z = ultimo ? ultimo.z_pt : null;
    return {
      puede: pendientes.length === 0 && sinSoporte.length === 0,
      pendientes: pendientes,
      sin_soporte: sinSoporte,
      z_ultimo: z,
      cumple_meta: DNTAntro.cumpleMetaEgreso(z)
    };
  }

  // ═══ Soportes (PDF / JPG) ════════════════════════════════════════
  async function subirSoporte(casoId, municipio, archivo, opciones) {
    var o = opciones || {}, u = DNTAuth.usuario();
    var ext = (archivo.name.match(/\.([a-z0-9]+)$/i) || [, 'bin'])[1].toLowerCase();
    var nombre = crypto.randomUUID() + '.' + ext;
    var ruta = slug(municipio) + '/' + casoId + '/' + nombre;

    var up = await sb().storage.from(BUCKET).upload(ruta, archivo, {
      cacheControl: '3600', upsert: false, contentType: archivo.type || undefined
    });
    if (up.error) throw new Error('No se pudo subir el archivo: ' + up.error.message);

    var fila = {
      caso_id: casoId, seguimiento_id: o.seguimiento_id || null,
      item: o.item || null, categoria: o.categoria || (o.item ? 'checklist' : 'general'),
      nombre_archivo: archivo.name, storage_path: ruta,
      mime_type: archivo.type || null, file_size: archivo.size,
      descripcion: o.descripcion || null, reemplaza_a: o.reemplaza_a || null,
      subido_por: u.id
    };
    var r = await sb().from('dnt_soportes').insert(fila).select().single();
    if (r.error) {                       // si falla la fila, no dejar el archivo huérfano
      await sb().storage.from(BUCKET).remove([ruta]);
      throw new Error(r.error.message);
    }
    DNTAuth.registrar('soporte_cargado', { entidad: 'dnt_soportes', entidad_id: r.data.id,
      caso_id: casoId, municipio: municipio, detalle: { item: o.item, archivo: archivo.name } });
    return r.data;
  }

  async function urlSoporte(storagePath, segundos) {
    var r = await sb().storage.from(BUCKET).createSignedUrl(storagePath, segundos || 300);
    if (r.error) throw new Error(r.error.message);
    return r.data.signedUrl;
  }

  async function descargarSoporte(soporte) {
    var url = await urlSoporte(soporte.storage_path, 120);
    DNTAuth.registrar('soporte_descargado', { entidad: 'dnt_soportes', entidad_id: soporte.id,
      caso_id: soporte.caso_id, municipio: soporte.municipio,
      detalle: { archivo: soporte.nombre_archivo } });
    return url;
  }

  /** Borrado lógico, recuperable (E35). Sólo admin: el trigger lo exige. */
  async function eliminarSoporte(id, motivo) {
    var r = await sb().from('dnt_soportes')
      .update({ eliminado: true, motivo_eliminacion: motivo || null }).eq('id', id).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('soporte_eliminado', { entidad: 'dnt_soportes', entidad_id: id,
      caso_id: out.caso_id, detalle: { motivo: motivo } });
    return out;
  }

  async function restaurarSoporte(id) {
    var r = await sb().from('dnt_soportes')
      .update({ eliminado: false, vigente: true, motivo_eliminacion: null }).eq('id', id).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('soporte_restaurado', { entidad: 'dnt_soportes', entidad_id: id, caso_id: out.caso_id });
    return out;
  }

  async function soportesEliminados() {
    return lanzar(await sb().from('dnt_soportes').select('*')
      .eq('eliminado', true).order('eliminado_en', { ascending: false }).limit(300));
  }

  // ═══ Módulos de apoyo ════════════════════════════════════════════
  function coleccion(tabla, orden) {
    return {
      listar: async function (filtros) {
        var q = sb().from(tabla).select('*');
        Object.keys(filtros || {}).forEach(function (k) {
          if (filtros[k] !== '' && filtros[k] != null) q = q.eq(k, filtros[k]);
        });
        return lanzar(await q.order(orden || 'creado_en', { ascending: false }).limit(1000));
      },
      guardar: async function (fila) {
        var f = Object.assign({}, fila);
        if (!f.id) f.registrado_por = DNTAuth.usuario().id;
        var r = f.id
          ? await sb().from(tabla).update(f).eq('id', f.id).select().single()
          : await sb().from(tabla).insert(f).select().single();
        return lanzar(r);
      },
      eliminar: async function (id) { return lanzar(await sb().from(tabla).delete().eq('id', id)); }
    };
  }

  var inventario    = coleccion('dnt_inventario', 'fecha');
  var equipos       = coleccion('dnt_equipos', 'creado_en');
  var jornadas      = coleccion('dnt_jornadas_extramurales', 'fecha');
  var capacitaciones= coleccion('dnt_capacitaciones', 'fecha');

  /** Saldo por municipio e insumo a partir de los movimientos. */
  async function saldoInventario(municipio) {
    var movs = await inventario.listar(municipio ? { municipio: municipio } : {});
    var saldo = {};
    movs.forEach(function (m) {
      var k = m.municipio + '|' + m.insumo;
      var signo = (m.movimiento === 'entrada') ? 1 : (m.movimiento === 'ajuste' ? 1 : -1);
      saldo[k] = (saldo[k] || 0) + signo * Number(m.cantidad);
    });
    return Object.keys(saldo).map(function (k) {
      var p = k.split('|');
      return { municipio: p[0], insumo: p[1], saldo: +saldo[k].toFixed(2) };
    });
  }

  // ═══ Usuarios (administración) ═══════════════════════════════════
  async function usuarios() {
    var r = await Promise.all([
      sb().from('dnt_perfiles').select('*').order('creado_en', { ascending: false }),
      sb().from('dnt_usuarios_municipio').select('*')
    ]);
    var perfiles = lanzar(r[0]), asign = lanzar(r[1]);
    perfiles.forEach(function (p) {
      p.municipios = asign.filter(function (a) { return a.usuario_id === p.id; })
                          .map(function (a) { return a.municipio; });
    });
    return perfiles;
  }

  async function actualizarUsuario(id, cambios) {
    var r = await sb().from('dnt_perfiles').update(cambios).eq('id', id).select().single();
    var out = lanzar(r);
    DNTAuth.registrar('usuario_actualizado', { entidad: 'dnt_perfiles', entidad_id: id, detalle: cambios });
    return out;
  }

  async function asignarMunicipios(usuarioId, codigos) {
    await sb().from('dnt_usuarios_municipio').delete().eq('usuario_id', usuarioId);
    if (codigos.length) {
      lanzar(await sb().from('dnt_usuarios_municipio').insert(codigos.map(function (c) {
        return { usuario_id: usuarioId, municipio: c, asignado_por: DNTAuth.usuario().id };
      })));
    }
    DNTAuth.registrar('municipios_asignados', { entidad: 'dnt_perfiles', entidad_id: usuarioId,
      detalle: { municipios: codigos } });
  }

  /** Solicitudes de contraseña pendientes. Sólo las ve el administrador. */
  async function solicitudesClave() {
    return lanzar(await sb().from('dnt_solicitudes_clave')
      .select('id,perfil_id,email,estado,solicitado_en')
      .eq('estado', 'pendiente').order('solicitado_en'));
  }

  /** Cierra una solicitud sin generar contraseña (duplicada, o ya resuelta). */
  async function descartarSolicitudClave(id) {
    var r = await sb().from('dnt_solicitudes_clave').update({
      estado: 'descartada',
      atendida_por: DNTAuth.usuario().id,
      atendida_en: new Date().toISOString()
    }).eq('id', id);
    lanzar(r);
    DNTAuth.registrar('solicitud_clave_descartada',
      { entidad: 'dnt_solicitudes_clave', entidad_id: id });
  }

  async function responsables() {
    return lanzar(await sb().from('dnt_perfiles').select('id,nombre,email,rol')
      .eq('estado', 'activo').order('nombre'));
  }

  // ═══ Indicadores y auditoría ═════════════════════════════════════
  async function indicadores(filtros) {
    var q = sb().from('dnt_v_indicadores').select('*');
    if (filtros && filtros.municipio) q = q.eq('municipio', filtros.municipio);
    if (filtros && filtros.periodo)   q = q.eq('periodo', filtros.periodo);
    return lanzar(await q.order('periodo', { ascending: false }));
  }

  async function auditoria(limite) {
    return lanzar(await sb().from('dnt_log').select('*')
      .order('creado_en', { ascending: false }).limit(limite || 300));
  }

  async function registrarImportacion(resumen) {
    var r = await sb().from('dnt_importaciones')
      .insert(Object.assign({ usuario_id: DNTAuth.usuario().id }, resumen)).select().single();
    return lanzar(r);
  }

  async function importaciones() {
    return lanzar(await sb().from('dnt_importaciones').select('*')
      .order('creado_en', { ascending: false }).limit(100));
  }

  global.DNTDatos = {
    slug: slug, catalogos: catalogos, checklistDe: checklistDe, itemChecklist: itemChecklist,
    casos: casos, caso: caso, buscarNino: buscarNino, verificarDuplicado: verificarDuplicado,
    guardarNino: guardarNino, guardarCaso: guardarCaso, cerrarCaso: cerrarCaso,
    reabrirCaso: reabrirCaso, reasignarResponsable: reasignarResponsable,
    guardarSeguimiento: guardarSeguimiento, guardarFactores: guardarFactores,
    guardarRespuesta: guardarRespuesta, validarEgreso: validarEgreso,
    subirSoporte: subirSoporte, urlSoporte: urlSoporte, descargarSoporte: descargarSoporte,
    eliminarSoporte: eliminarSoporte, restaurarSoporte: restaurarSoporte,
    soportesEliminados: soportesEliminados,
    inventario: inventario, equipos: equipos, jornadas: jornadas, capacitaciones: capacitaciones,
    saldoInventario: saldoInventario,
    usuarios: usuarios, actualizarUsuario: actualizarUsuario,
    solicitudesClave: solicitudesClave, descartarSolicitudClave: descartarSolicitudClave,
    asignarMunicipios: asignarMunicipios, responsables: responsables,
    indicadores: indicadores, auditoria: auditoria,
    registrarImportacion: registrarImportacion, importaciones: importaciones
  };
})(window);
