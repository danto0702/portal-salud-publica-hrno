// gestion.js — Indicadores, módulos de apoyo y administración del sistema.

var DNTGestion = (function () {
  'use strict';

  var A;
  function $(i) { return DNTApp.$(i); }
  function esc(s) { return DNTApp.esc(s); }
  function cp(id, et, ctrl, ayuda) {
    return '<div class="campo"><label for="' + id + '">' + esc(et) + '</label>' + ctrl +
      (ayuda ? '<div class="ayuda">' + esc(ayuda) + '</div>' : '') + '</div>';
  }

  // ═══════════════════════════════════════════════════════════════
  // INDICADORES (Tablas 44 y 45)
  // ═══════════════════════════════════════════════════════════════
  var INDICADORES = [
    { id: 'identificacion', nombre: 'Identificación adecuada de casos de DNT', tipo: 'Proceso',
      periodicidad: 'Mensual', num: 'identificacion_adecuada', den: 'total_casos',
      formula: 'Niños identificados adecuadamente / Total de niños identificados',
      nota: 'Se considera adecuada cuando los ítems A1, A2 y A3 del check-list están en «Cumple».' },
    { id: 'escenario', nombre: 'Definición adecuada del escenario', tipo: 'Proceso',
      periodicidad: 'Mensual', num: 'escenario_definido', den: 'total_casos',
      formula: 'Niños con escenario definido / Total de niños identificados',
      nota: 'Al menos un seguimiento con escenario ambulatorio u hospitalización registrado.' },
    { id: 'ambulatorio', nombre: 'Adecuado manejo ambulatorio', tipo: 'Producto',
      periodicidad: 'Mensual', num: 'escenario_definido', den: 'en_ambulatorio',
      formula: 'Niños con manejo ambulatorio adecuado / Total en ambulatorio' },
    { id: 'mipres', nombre: 'Prescripción de FTLC en MIPRES', tipo: 'Producto',
      periodicidad: 'Mensual', num: 'ftlc_mipres', den: 'en_ambulatorio',
      formula: 'Niños con FTLC en MIPRES / Total en ambulatorio',
      nota: 'Se cuenta el ítem A9 del check-list en «Cumple».' },
    { id: 'recuperacion', nombre: 'Recuperación nutricional (Z ≥ -1 DE)', tipo: 'Resultado',
      periodicidad: 'Mensual', num: 'recuperados_z1', den: 'en_ambulatorio',
      formula: 'Niños que alcanzan Z P/T-L ≥ -1 DE / Total en ambulatorio',
      nota: 'Meta elevada por la Res. 115 de 2026.' }
  ];

  async function pintarIndicadores() {
    A = DNTApp;
    $('vista-indicadores').innerHTML =
      '<div class="titulo-vista"><div class="icono">📈</div><div>' +
        '<h1>Indicadores de gestión y calidad</h1>' +
        '<p>Matriz de las tablas 44 y 45 del anexo técnico de las Resoluciones 2350 de 2020 y 115 de 2026. ' +
        'Se calculan sobre los casos que usted puede ver.</p>' +
      '</div></div>' +
      '<div class="filtros">' +
        cp('iMunicipio', 'Municipio', '<select id="iMunicipio">' + A.opcionesMunicipio('', true) + '</select>') +
        cp('iPeriodo', 'Periodo', '<select id="iPeriodo"><option value="">Acumulado</option></select>') +
        '<button class="btn" id="btnExportarInd">⬇ Excel</button>' +
      '</div>' +
      '<div id="panelIndicadores" class="cargando"><span class="hilo">◐</span> Calculando…</div>';

    var datos = [];
    try { datos = await DNTDatos.indicadores({}); }
    catch (e) { A.toast('No se pudieron calcular los indicadores: ' + e.message, 'error'); }

    var periodos = {};
    datos.forEach(function (d) { periodos[d.periodo] = true; });
    $('iPeriodo').innerHTML = '<option value="">Acumulado de todos los periodos</option>' +
      Object.keys(periodos).sort().reverse().map(function (p) {
        return A.opcion(p, A.nombreMes(p));
      }).join('');

    function calcular() {
      var mun = $('iMunicipio').value, per = $('iPeriodo').value;
      var filas = datos.filter(function (d) {
        return (!mun || d.municipio === mun) && (!per || d.periodo === per);
      });
      var t = {};
      ['total_casos', 'identificacion_adecuada', 'escenario_definido', 'en_ambulatorio',
       'ftlc_mipres', 'recuperados_z1', 'egresos_recuperacion'].forEach(function (k) {
        t[k] = filas.reduce(function (a, f) { return a + (f[k] || 0); }, 0);
      });

      var panel = $('panelIndicadores');
      panel.className = '';
      panel.innerHTML =
        '<div class="rejilla c3" style="margin-bottom:16px">' +
          A.kpi('Casos en el periodo', t.total_casos, '', mun ? DNTAuth.nombreMunicipio(mun) : 'Todos los municipios') +
          A.kpi('En manejo ambulatorio', t.en_ambulatorio, '', '') +
          A.kpi('Egresos por recuperación', t.egresos_recuperacion, 'verde', '') +
        '</div>' +
        '<div class="tarjeta"><h3>Matriz de indicadores</h3>' +
          '<p class="tarjeta-sub">El color de la barra sigue el cumplimiento, y la cifra siempre está escrita.</p>' +
          '<div class="tabla-env"><table class="t"><thead><tr>' +
            '<th>Indicador</th><th>Tipo</th><th class="num">Numerador</th><th class="num">Denominador</th>' +
            '<th class="num">Resultado</th><th>Cumplimiento</th></tr></thead><tbody>' +
          INDICADORES.map(function (ind) {
            var n = t[ind.num], den = t[ind.den];
            var pct = den ? Math.round(100 * n / den) : null;
            var color = pct == null ? 'gris' : (pct >= 90 ? 'verde' : pct >= 70 ? 'amarillo' : 'rojo');
            return '<tr><td><strong>' + esc(ind.nombre) + '</strong>' +
              '<div class="chk-norma">' + esc(ind.formula) + '</div>' +
              (ind.nota ? '<div class="chk-detalle">' + esc(ind.nota) + '</div>' : '') + '</td>' +
              '<td><span class="sem gris">' + esc(ind.tipo) + '</span></td>' +
              '<td class="num mono">' + n + '</td><td class="num mono">' + den + '</td>' +
              '<td class="num mono"><strong>' + (pct == null ? '—' : pct + ' %') + '</strong></td>' +
              '<td>' + (pct == null ? '<span class="sem gris">Sin datos</span>'
                : '<div style="display:flex;align-items:center;gap:8px">' +
                  '<div style="flex:1;height:8px;background:var(--gris-luz);border-radius:4px;overflow:hidden;min-width:70px">' +
                  '<div style="width:' + pct + '%;height:100%;background:var(--' +
                  ({ verde: 'verde', amarillo: 'amarillo', rojo: 'rojo' }[color]) + ')"></div></div>' +
                  '<span class="sem ' + color + '">' + pct + ' %</span></div>') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>' +

        '<div class="tarjeta"><h3>Indicador trimestral de talento humano</h3>' +
          '<p class="tarjeta-sub">Profesionales capacitados sobre el total que atiende menores de 5 años. ' +
          'Se alimenta desde Apoyo → Capacitaciones.</p>' +
          '<div id="indCapacitacion" class="cargando"><span class="hilo">◐</span> Cargando…</div></div>' +

        '<div class="tarjeta"><h3>Desglose por municipio y periodo</h3>' +
          '<div class="tabla-env"><table class="t"><thead><tr><th>Municipio</th><th>Periodo</th>' +
            '<th class="num">Casos</th><th class="num">Identificación</th><th class="num">Escenario</th>' +
            '<th class="num">FTLC MIPRES</th><th class="num">Recuperados</th></tr></thead><tbody>' +
          (filas.length ? filas.sort(function (a, b) { return b.periodo.localeCompare(a.periodo); })
            .map(function (f) {
              return '<tr><td>' + esc(DNTAuth.nombreMunicipio(f.municipio)) + '</td>' +
                '<td>' + esc(A.nombreMes(f.periodo)) + '</td>' +
                '<td class="num">' + f.total_casos + '</td>' +
                '<td class="num">' + f.identificacion_adecuada + '</td>' +
                '<td class="num">' + f.escenario_definido + '</td>' +
                '<td class="num">' + f.ftlc_mipres + '</td>' +
                '<td class="num">' + f.recuperados_z1 + '</td></tr>';
            }).join('')
            : '<tr><td colspan="7" class="vacio">Sin datos en el periodo seleccionado.</td></tr>') +
          '</tbody></table></div></div>';

      capacitacionResumen(mun);
    }

    $('iMunicipio').onchange = $('iPeriodo').onchange = calcular;
    $('btnExportarInd').onclick = function () { exportarIndicadores(datos); };
    calcular();
  }

  async function capacitacionResumen(mun) {
    try {
      var lista = await DNTDatos.capacitaciones.listar(mun ? { municipio: mun } : {});
      var tot = lista.reduce(function (a, c) { return a + c.profesionales_total; }, 0);
      var cap = lista.reduce(function (a, c) { return a + c.profesionales_capacitados; }, 0);
      var pct = tot ? Math.round(100 * cap / tot) : null;
      var el = $('indCapacitacion');
      if (!el) return;
      el.className = '';
      el.innerHTML = lista.length
        ? '<div class="rejilla c3">' +
          A.kpi('Profesionales capacitados', cap, 'verde', '') +
          A.kpi('Total que atiende menores de 5 años', tot, '', '') +
          A.kpi('Cumplimiento', (pct == null ? '—' : pct + ' %'),
                pct >= 90 ? 'verde' : pct >= 70 ? 'amarillo' : 'rojo', 'Meta institucional: 90 %') +
          '</div>'
        : '<div class="vacio">Todavía no se han registrado capacitaciones.</div>';
    } catch (e) { /* indicador secundario */ }
  }

  function exportarIndicadores(datos) {
    if (!datos.length) { A.toast('No hay datos para exportar.', 'ojo'); return; }
    var filas = datos.map(function (f) {
      function pct(n, d) { return d ? Math.round(100 * f[n] / f[d]) : ''; }
      return {
        'Municipio': DNTAuth.nombreMunicipio(f.municipio), 'Periodo': f.periodo,
        'Total de casos': f.total_casos,
        'Identificación adecuada': f.identificacion_adecuada,
        '% identificación': pct('identificacion_adecuada', 'total_casos'),
        'Escenario definido': f.escenario_definido,
        '% escenario': pct('escenario_definido', 'total_casos'),
        'En ambulatorio': f.en_ambulatorio,
        'FTLC en MIPRES': f.ftlc_mipres, '% MIPRES': pct('ftlc_mipres', 'en_ambulatorio'),
        'Recuperados Z ≥ -1': f.recuperados_z1, '% recuperación': pct('recuperados_z1', 'en_ambulatorio'),
        'Egresos por recuperación': f.egresos_recuperacion
      };
    });
    var libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), 'Indicadores');
    XLSX.writeFile(libro, 'Indicadores_Nutricion_HRNO_' + A.hoy() + '.xlsx');
    DNTAuth.registrar('exporte_indicadores', { detalle: { filas: filas.length } });
  }

  // ═══════════════════════════════════════════════════════════════
  // APOYO: inventario, equipos, extramural, capacitaciones
  // ═══════════════════════════════════════════════════════════════
  var subApoyo = 'inventario';

  function pintarApoyo() {
    A = DNTApp;
    $('vista-apoyo').innerHTML =
      '<div class="titulo-vista"><div class="icono">🧰</div><div>' +
        '<h1>Módulos de apoyo</h1>' +
        '<p>Insumos, equipos antropométricos, búsqueda activa comunitaria y capacitación del talento humano ' +
        '(Art. 11 de la Res. 115 de 2026).</p>' +
      '</div></div>' +
      '<div class="subtabs" id="subApoyo">' +
        [['inventario', '🥜 Inventario de insumos'], ['equipos', '⚖️ Equipos antropométricos'],
         ['extramural', '🚶 Búsqueda activa'], ['capacitacion', '🎓 Capacitaciones']]
        .map(function (t) {
          return '<button data-s="' + t[0] + '"' + (subApoyo === t[0] ? ' class="activo"' : '') + '>' + t[1] + '</button>';
        }).join('') +
      '</div><div id="panelApoyo" class="cargando"><span class="hilo">◐</span> Cargando…</div>';

    Array.prototype.forEach.call($('subApoyo').querySelectorAll('button'), function (b) {
      b.onclick = function () { subApoyo = b.dataset.s; pintarApoyo(); };
    });
    ({ inventario: panelInventario, equipos: panelEquipos,
       extramural: panelExtramural, capacitacion: panelCapacitacion })[subApoyo]();
  }

  var INSUMOS = { FTLC: 'FTLC (sobre de 92 g)', FORMULA_INICIO: 'Fórmula láctea de inicio',
    F100: 'Fórmula F-100', F75: 'Fórmula F-75', SRO75: 'SRO de baja osmolaridad (SRO-75)',
    MICRONUTRIENTES: 'Micronutrientes' };

  async function panelInventario() {
    var puede = DNTAuth.esAdmin() || DNTAuth.esResp();
    try {
      var movs = await DNTDatos.inventario.listar({});
      var saldos = await DNTDatos.saldoInventario();
      $('panelApoyo').className = '';
      $('panelApoyo').innerHTML =
        '<div class="tarjeta"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">' +
          '<div><h3>🥜 Saldo de insumos</h3><p class="tarjeta-sub" style="margin:0">' +
          'Calculado a partir de los movimientos. Las entregas registradas en un seguimiento descuentan automáticamente.</p></div>' +
          (puede ? '<button class="btn" id="btnMovimiento">➕ Registrar movimiento</button>' : '') +
        '</div>' +
        (saldos.length
          ? '<div class="rejilla c4" style="margin-top:14px">' + saldos.map(function (s) {
              return A.kpi(INSUMOS[s.insumo] || s.insumo, s.saldo,
                s.saldo <= 0 ? 'rojo' : s.saldo < 20 ? 'amarillo' : 'verde',
                DNTAuth.nombreMunicipio(s.municipio));
            }).join('') + '</div>'
          : '<div class="vacio"><span class="emo">📦</span>Sin movimientos registrados.</div>') +
        '</div>' +
        '<div class="tarjeta"><h3>Movimientos</h3>' +
          (movs.length
            ? '<div class="tabla-env"><table class="t"><thead><tr><th>Fecha</th><th>Municipio</th>' +
              '<th>Insumo</th><th>Movimiento</th><th class="num">Cantidad</th><th>Lote</th>' +
              '<th>Vence</th><th>Observación</th></tr></thead><tbody>' +
              movs.slice(0, 200).map(function (m) {
                return '<tr><td>' + A.fecha(m.fecha) + '</td>' +
                  '<td>' + esc(DNTAuth.nombreMunicipio(m.municipio)) + '</td>' +
                  '<td>' + esc(INSUMOS[m.insumo] || m.insumo) + '</td>' +
                  '<td><span class="sem ' + (m.movimiento === 'entrada' ? 'verde' : m.movimiento === 'salida' ? 'azul' : 'gris') +
                    '">' + esc(m.movimiento) + '</span></td>' +
                  '<td class="num mono">' + m.cantidad + ' ' + esc(m.unidad) + '</td>' +
                  '<td class="mono">' + esc(m.lote || '—') + '</td>' +
                  '<td>' + A.fecha(m.fecha_vencimiento) + '</td>' +
                  '<td style="font-size:.79rem">' + esc(m.observacion || '') + '</td></tr>';
              }).join('') + '</tbody></table></div>'
            : '<div class="vacio">Sin movimientos.</div>') +
        '</div>';
      if ($('btnMovimiento')) $('btnMovimiento').onclick = dialogoMovimiento;
    } catch (e) { errorPanel(e); }
  }

  function dialogoMovimiento() {
    A.modal('Registrar movimiento de inventario',
      '<div class="fila">' +
        cp('vMunicipio', 'Municipio', '<select id="vMunicipio">' + A.opcionesMunicipio(DNTAuth.alcance()[0], false) + '</select>') +
        cp('vFecha', 'Fecha', '<input type="date" id="vFecha" value="' + A.hoy() + '">') +
      '</div>' +
      '<div class="fila">' +
        cp('vInsumo', 'Insumo', '<select id="vInsumo">' +
          Object.keys(INSUMOS).map(function (k) { return A.opcion(k, INSUMOS[k]); }).join('') + '</select>') +
        cp('vMovimiento', 'Movimiento', '<select id="vMovimiento">' +
          A.opcion('entrada', 'Entrada') + A.opcion('salida', 'Salida') +
          A.opcion('ajuste', 'Ajuste') + A.opcion('baja', 'Baja por vencimiento o daño') + '</select>') +
        cp('vCantidad', 'Cantidad', '<input type="number" id="vCantidad" step="0.01" min="0.01" value="1">') +
      '</div>' +
      '<div class="fila">' +
        cp('vUnidad', 'Unidad', '<select id="vUnidad">' + A.opcion('sobre', 'Sobre') +
          A.opcion('tarro', 'Tarro') + A.opcion('unidad', 'Unidad') + A.opcion('mL', 'Mililitros') + '</select>') +
        cp('vLote', 'Lote', '<input type="text" id="vLote">') +
        cp('vVence', 'Fecha de vencimiento', '<input type="date" id="vVence">') +
      '</div>' +
      cp('vObs', 'Observación', '<input type="text" id="vObs">'),
      [
        { texto: 'Cancelar', accion: A.cerrarModal },
        { texto: 'Guardar', accion: async function () {
          try {
            await DNTDatos.inventario.guardar({
              municipio: $('vMunicipio').value, fecha: $('vFecha').value,
              insumo: $('vInsumo').value, movimiento: $('vMovimiento').value,
              cantidad: parseFloat($('vCantidad').value), unidad: $('vUnidad').value,
              lote: $('vLote').value || null, fecha_vencimiento: $('vVence').value || null,
              observacion: $('vObs').value || null
            });
            A.cerrarModal(); A.toast('Movimiento registrado.', 'ok'); pintarApoyo();
          } catch (e) { A.toast(e.message, 'error'); }
        } }
      ]);
  }

  var TIPOS_EQUIPO = { balanza_pediatrica: 'Balanza pediátrica', balanza_pie: 'Balanza de pie',
    infantometro: 'Infantómetro', tallimetro: 'Tallímetro', cinta_braquial: 'Cinta braquial',
    cinta_cefalica: 'Cinta cefálica', termometro: 'Termómetro' };

  async function panelEquipos() {
    var puede = DNTAuth.esAdmin() || DNTAuth.esResp();
    try {
      var lista = await DNTDatos.equipos.listar({});
      var vencidos = lista.filter(function (e) {
        return e.proxima_calibracion && e.proxima_calibracion < A.hoy();
      });
      $('panelApoyo').className = '';
      $('panelApoyo').innerHTML =
        '<div class="tarjeta"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">' +
          '<div><h3>⚖️ Hoja de vida de equipos antropométricos</h3>' +
          '<p class="tarjeta-sub" style="margin:0">Res. 2465 de 2016: balanza, infantómetro, tallímetro y ' +
          'cinta braquial calibrados y con hoja de vida.</p></div>' +
          (puede ? '<button class="btn" id="btnEquipo">➕ Registrar equipo</button>' : '') +
        '</div>' +
        (vencidos.length
          ? '<div class="aviso grave" style="margin-top:12px"><span class="ic">⚠</span><div>' +
            '<strong>' + vencidos.length + ' equipo(s) con calibración vencida</strong>' +
            'Una medición con equipo descalibrado invalida la clasificación nutricional.</div></div>'
          : '') +
        (lista.length
          ? '<div class="tabla-env" style="margin-top:12px"><table class="t"><thead><tr>' +
            '<th>Equipo</th><th>Municipio</th><th>Marca y serie</th><th>Última calibración</th>' +
            '<th>Próxima</th><th>Estado</th></tr></thead><tbody>' +
            lista.map(function (e) {
              var venc = e.proxima_calibracion && e.proxima_calibracion < A.hoy();
              return '<tr><td><strong>' + esc(TIPOS_EQUIPO[e.tipo] || e.tipo) + '</strong></td>' +
                '<td>' + esc(DNTAuth.nombreMunicipio(e.municipio)) + '</td>' +
                '<td>' + esc([e.marca, e.modelo, e.serie].filter(Boolean).join(' · ') || '—') + '</td>' +
                '<td>' + A.fecha(e.ultima_calibracion) + '</td>' +
                '<td>' + A.fecha(e.proxima_calibracion) +
                  (venc ? ' <span class="sem rojo">vencida</span>' : '') + '</td>' +
                '<td><span class="sem ' + (e.estado === 'operativo' ? 'verde' : e.estado === 'mantenimiento' ? 'amarillo' : 'rojo') +
                  '">' + esc(e.estado) + '</span></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="vacio"><span class="emo">⚖️</span>Sin equipos registrados.</div>') +
        '</div>';
      if ($('btnEquipo')) $('btnEquipo').onclick = dialogoEquipo;
    } catch (e) { errorPanel(e); }
  }

  function dialogoEquipo() {
    A.modal('Registrar equipo antropométrico',
      '<div class="fila">' +
        cp('qMunicipio', 'Municipio', '<select id="qMunicipio">' + A.opcionesMunicipio(DNTAuth.alcance()[0], false) + '</select>') +
        cp('qTipo', 'Tipo de equipo', '<select id="qTipo">' +
          Object.keys(TIPOS_EQUIPO).map(function (k) { return A.opcion(k, TIPOS_EQUIPO[k]); }).join('') + '</select>') +
      '</div>' +
      '<div class="fila">' +
        cp('qMarca', 'Marca', '<input type="text" id="qMarca">') +
        cp('qModelo', 'Modelo', '<input type="text" id="qModelo">') +
        cp('qSerie', 'Serie', '<input type="text" id="qSerie">') +
      '</div>' +
      '<div class="fila">' +
        cp('qUltima', 'Última calibración', '<input type="date" id="qUltima">') +
        cp('qProxima', 'Próxima calibración', '<input type="date" id="qProxima">') +
        cp('qEstado', 'Estado', '<select id="qEstado">' + A.opcion('operativo', 'Operativo') +
          A.opcion('mantenimiento', 'En mantenimiento') + A.opcion('fuera_servicio', 'Fuera de servicio') +
          A.opcion('baja', 'Dado de baja') + '</select>') +
      '</div>' +
      cp('qObs', 'Observaciones', '<textarea id="qObs"></textarea>'),
      [
        { texto: 'Cancelar', accion: A.cerrarModal },
        { texto: 'Guardar', accion: async function () {
          try {
            await DNTDatos.equipos.guardar({
              municipio: $('qMunicipio').value, tipo: $('qTipo').value,
              marca: $('qMarca').value || null, modelo: $('qModelo').value || null,
              serie: $('qSerie').value || null,
              ultima_calibracion: $('qUltima').value || null,
              proxima_calibracion: $('qProxima').value || null,
              estado: $('qEstado').value, observaciones: $('qObs').value || null
            });
            A.cerrarModal(); A.toast('Equipo registrado.', 'ok'); pintarApoyo();
          } catch (e) { A.toast(e.message, 'error'); }
        } }
      ]);
  }

  async function panelExtramural() {
    var puede = DNTAuth.esAdmin() || DNTAuth.esResp();
    try {
      var lista = await DNTDatos.jornadas.listar({});
      var tam = lista.reduce(function (a, j) { return a + j.ninos_tamizados; }, 0);
      var nuevos = lista.reduce(function (a, j) {
        return a + j.casos_nuevos_riesgo + j.casos_nuevos_moderada + j.casos_nuevos_severa;
      }, 0);
      $('panelApoyo').className = '';
      $('panelApoyo').innerHTML =
        '<div class="tarjeta"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">' +
          '<div><h3>🚶 Búsqueda activa comunitaria</h3>' +
          '<p class="tarjeta-sub" style="margin:0">Atención extramural en zonas rurales y dispersas, con enfoque ' +
          'diferencial étnico (Art. 11, Res. 115 de 2026).</p></div>' +
          (puede ? '<button class="btn" id="btnJornada">➕ Registrar jornada</button>' : '') +
        '</div>' +
        '<div class="rejilla c3" style="margin-top:14px">' +
          A.kpi('Jornadas registradas', lista.length, '', '') +
          A.kpi('Niños tamizados', tam, '', 'En búsqueda activa') +
          A.kpi('Casos nuevos detectados', nuevos, nuevos ? 'naranja' : 'verde', 'Riesgo y desnutrición aguda') +
        '</div></div>' +
        '<div class="tarjeta"><h3>Historial</h3>' +
          (lista.length
            ? '<div class="tabla-env"><table class="t"><thead><tr><th>Fecha</th><th>Municipio</th><th>Lugar</th>' +
              '<th>Tipo</th><th class="num">Tamizados</th><th class="num">Riesgo</th><th class="num">Moderada</th>' +
              '<th class="num">Severa</th><th class="num">Remitidos</th><th>Traductor</th></tr></thead><tbody>' +
              lista.map(function (j) {
                return '<tr><td>' + A.fecha(j.fecha) + '</td>' +
                  '<td>' + esc(DNTAuth.nombreMunicipio(j.municipio)) + '</td>' +
                  '<td>' + esc(j.lugar) + (j.zona ? ' <span class="sem gris">' + esc(j.zona) + '</span>' : '') + '</td>' +
                  '<td style="font-size:.79rem">' + esc(j.tipo.replace(/_/g, ' ')) + '</td>' +
                  '<td class="num">' + j.ninos_tamizados + '</td>' +
                  '<td class="num">' + j.casos_nuevos_riesgo + '</td>' +
                  '<td class="num">' + j.casos_nuevos_moderada + '</td>' +
                  '<td class="num">' + j.casos_nuevos_severa + '</td>' +
                  '<td class="num">' + j.remitidos + '</td>' +
                  '<td>' + (j.con_traductor ? '<span class="sem verde">Sí</span>' : '—') + '</td></tr>';
              }).join('') + '</tbody></table></div>'
            : '<div class="vacio"><span class="emo">🚶</span>Sin jornadas registradas.</div>') +
        '</div>';
      if ($('btnJornada')) $('btnJornada').onclick = dialogoJornada;
    } catch (e) { errorPanel(e); }
  }

  function dialogoJornada() {
    A.modal('Registrar jornada extramural',
      '<div class="fila">' +
        cp('jMunicipio', 'Municipio', '<select id="jMunicipio">' + A.opcionesMunicipio(DNTAuth.alcance()[0], false) + '</select>') +
        cp('jFecha', 'Fecha', '<input type="date" id="jFecha" value="' + A.hoy() + '">') +
        cp('jTipo', 'Tipo', '<select id="jTipo">' +
          A.opcion('busqueda_activa', 'Búsqueda activa comunitaria') +
          A.opcion('seguimiento_domiciliario', 'Seguimiento domiciliario') +
          A.opcion('jornada_extramural', 'Jornada extramural') +
          A.opcion('telesalud', 'Telesalud') + '</select>') +
      '</div>' +
      '<div class="fila">' +
        cp('jLugar', 'Lugar, vereda o comunidad', '<input type="text" id="jLugar" required>') +
        cp('jZona', 'Zona', '<select id="jZona">' + A.opcion('Rural', 'Rural') + A.opcion('Urbano', 'Urbano') + '</select>') +
      '</div>' +
      '<div class="fila">' +
        cp('jTamizados', 'Niños tamizados', '<input type="number" id="jTamizados" min="0" value="0">') +
        cp('jRiesgo', 'Casos nuevos en riesgo', '<input type="number" id="jRiesgo" min="0" value="0">') +
        cp('jModerada', 'DNT moderada', '<input type="number" id="jModerada" min="0" value="0">') +
        cp('jSevera', 'DNT severa', '<input type="number" id="jSevera" min="0" value="0">') +
        cp('jRemitidos', 'Remitidos', '<input type="number" id="jRemitidos" min="0" value="0">') +
      '</div>' +
      '<div class="fila">' +
        cp('jEquipo', 'Equipo que asistió', '<input type="text" id="jEquipo">') +
        cp('jTraductor', 'Con traductor', '<select id="jTraductor">' +
          A.opcion('no', 'No') + A.opcion('si', 'Sí') + '</select>') +
        cp('jEtnica', 'Comunidad étnica', '<input type="text" id="jEtnica">') +
      '</div>' +
      cp('jObs', 'Observaciones', '<textarea id="jObs"></textarea>'),
      [
        { texto: 'Cancelar', accion: A.cerrarModal },
        { texto: 'Guardar', accion: async function () {
          if (!$('jLugar').value.trim()) { A.toast('Indique el lugar de la jornada.', 'error'); return; }
          try {
            await DNTDatos.jornadas.guardar({
              municipio: $('jMunicipio').value, fecha: $('jFecha').value, tipo: $('jTipo').value,
              lugar: $('jLugar').value.trim(), zona: $('jZona').value,
              ninos_tamizados: +$('jTamizados').value || 0,
              casos_nuevos_riesgo: +$('jRiesgo').value || 0,
              casos_nuevos_moderada: +$('jModerada').value || 0,
              casos_nuevos_severa: +$('jSevera').value || 0,
              remitidos: +$('jRemitidos').value || 0,
              equipo: $('jEquipo').value || null, con_traductor: $('jTraductor').value === 'si',
              comunidad_etnica: $('jEtnica').value || null, observaciones: $('jObs').value || null
            });
            A.cerrarModal(); A.toast('Jornada registrada.', 'ok'); pintarApoyo();
          } catch (e) { A.toast(e.message, 'error'); }
        } }
      ]);
  }

  async function panelCapacitacion() {
    var puede = DNTAuth.esAdmin() || DNTAuth.esResp();
    try {
      var lista = await DNTDatos.capacitaciones.listar({});
      $('panelApoyo').className = '';
      $('panelApoyo').innerHTML =
        '<div class="tarjeta"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">' +
          '<div><h3>🎓 Capacitación del talento humano</h3>' +
          '<p class="tarjeta-sub" style="margin:0">Alimenta el indicador trimestral de profesionales capacitados.</p></div>' +
          (puede ? '<button class="btn" id="btnCap">➕ Registrar capacitación</button>' : '') +
        '</div>' +
        (lista.length
          ? '<div class="tabla-env" style="margin-top:12px"><table class="t"><thead><tr><th>Fecha</th>' +
            '<th>Municipio</th><th>Periodo</th><th>Tema</th><th class="num">Capacitados</th>' +
            '<th class="num">Total</th><th class="num">%</th></tr></thead><tbody>' +
            lista.map(function (c) {
              var pct = c.profesionales_total ? Math.round(100 * c.profesionales_capacitados / c.profesionales_total) : null;
              return '<tr><td>' + A.fecha(c.fecha) + '</td>' +
                '<td>' + esc(DNTAuth.nombreMunicipio(c.municipio)) + '</td>' +
                '<td class="mono">' + esc(c.periodo) + '</td><td>' + esc(c.tema) + '</td>' +
                '<td class="num">' + c.profesionales_capacitados + '</td>' +
                '<td class="num">' + c.profesionales_total + '</td>' +
                '<td class="num"><span class="sem ' + (pct >= 90 ? 'verde' : pct >= 70 ? 'amarillo' : 'rojo') +
                  '">' + (pct == null ? '—' : pct + ' %') + '</span></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="vacio"><span class="emo">🎓</span>Sin capacitaciones registradas.</div>') +
        '</div>';
      if ($('btnCap')) $('btnCap').onclick = dialogoCapacitacion;
    } catch (e) { errorPanel(e); }
  }

  function dialogoCapacitacion() {
    var anio = new Date().getFullYear();
    var tri = 'T' + (Math.floor(new Date().getMonth() / 3) + 1);
    A.modal('Registrar capacitación',
      '<div class="fila">' +
        cp('kMunicipio', 'Municipio', '<select id="kMunicipio">' + A.opcionesMunicipio(DNTAuth.alcance()[0], false) + '</select>') +
        cp('kFecha', 'Fecha', '<input type="date" id="kFecha" value="' + A.hoy() + '">') +
        cp('kPeriodo', 'Periodo', '<input type="text" id="kPeriodo" value="' + anio + '-' + tri + '">', 'Formato aaaa-Tn') +
      '</div>' +
      cp('kTema', 'Tema', '<input type="text" id="kTema" value="Lineamiento técnico Res. 2350/2020 y Res. 115/2026">') +
      '<div class="fila">' +
        cp('kCap', 'Profesionales capacitados', '<input type="number" id="kCap" min="0" value="0">') +
        cp('kTot', 'Total que atiende menores de 5 años', '<input type="number" id="kTot" min="0" value="0">') +
        cp('kResp', 'Responsable', '<input type="text" id="kResp">') +
      '</div>' +
      cp('kObs', 'Observaciones', '<textarea id="kObs"></textarea>'),
      [
        { texto: 'Cancelar', accion: A.cerrarModal },
        { texto: 'Guardar', accion: async function () {
          try {
            await DNTDatos.capacitaciones.guardar({
              municipio: $('kMunicipio').value, fecha: $('kFecha').value, periodo: $('kPeriodo').value,
              tema: $('kTema').value, profesionales_capacitados: +$('kCap').value || 0,
              profesionales_total: +$('kTot').value || 0,
              responsable: $('kResp').value || null, observaciones: $('kObs').value || null
            });
            A.cerrarModal(); A.toast('Capacitación registrada.', 'ok'); pintarApoyo();
          } catch (e) { A.toast(e.message, 'error'); }
        } }
      ]);
  }

  function errorPanel(e) {
    var el = $('panelApoyo');
    el.className = '';
    el.innerHTML = '<div class="aviso grave"><span class="ic">⚠</span><div><strong>No se pudo cargar</strong>' +
      esc(e.message) + '</div></div>';
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMINISTRACIÓN
  // ═══════════════════════════════════════════════════════════════
  var subAdmin = 'usuarios';

  function pintarAdmin() {
    A = DNTApp;
    if (!DNTAuth.esAdmin()) {
      $('vista-admin').innerHTML = '<div class="aviso grave"><span class="ic">⚠</span><div>' +
        '<strong>Acceso restringido</strong>Sólo el administrador puede entrar a esta sección.</div></div>';
      return;
    }
    $('vista-admin').innerHTML =
      '<div class="titulo-vista"><div class="icono">⚙️</div><div>' +
        '<h1>Administración</h1>' +
        '<p>Usuarios, permisos por municipio, documentos eliminados y auditoría del módulo.</p>' +
      '</div></div>' +
      '<div class="subtabs" id="subAdmin">' +
        [['usuarios', '👥 Usuarios y permisos'], ['papelera', '🗑️ Documentos eliminados'],
         ['auditoria', '🔍 Auditoría']]
        .map(function (t) {
          return '<button data-s="' + t[0] + '"' + (subAdmin === t[0] ? ' class="activo"' : '') + '>' + t[1] + '</button>';
        }).join('') +
      '</div><div id="panelAdmin" class="cargando"><span class="hilo">◐</span> Cargando…</div>';

    Array.prototype.forEach.call($('subAdmin').querySelectorAll('button'), function (b) {
      b.onclick = function () { subAdmin = b.dataset.s; pintarAdmin(); };
    });
    ({ usuarios: panelUsuarios, papelera: panelPapelera, auditoria: panelAuditoria })[subAdmin]();
  }

  var ROLES = { admin: 'Administrador', coordinador: 'Coordinador', responsable: 'Responsable' };
  var DESC_ROL = {
    admin: 'Ve y edita todo, gestiona usuarios, asigna permisos y elimina documentos.',
    coordinador: 'Ve todos los municipios, descarga información y estadísticas, cierra casos y reasigna responsables. No edita datos clínicos.',
    responsable: 'Carga, descarga y consulta únicamente la información de los municipios que tenga asignados.'
  };

  async function panelUsuarios() {
    try {
      var lista = await DNTDatos.usuarios();
      var claves = await DNTDatos.solicitudesClave();
      var porId = {};
      lista.forEach(function (u) { porId[u.id] = u; });
      var pendientes = lista.filter(function (u) { return u.estado === 'pendiente'; });
      var el = $('panelAdmin'); el.className = '';
      el.innerHTML =
        (claves.length
          ? '<div class="tarjeta" style="border-left:5px solid var(--rojo)">' +
            '<h3>🔑 Contraseñas por restablecer</h3>' +
            '<p class="tarjeta-sub">El restablecimiento no pasa por el correo: usted genera la ' +
              'contraseña provisional y se la entrega. Quien la reciba tendrá que cambiarla al entrar.</p>' +
            claves.map(function (c) { return tarjetaClave(c, porId[c.perfil_id]); }).join('') + '</div>'
          : '') +
        (pendientes.length
          ? '<div class="tarjeta" style="border-left:5px solid var(--naranja)">' +
            '<h3>⏳ Solicitudes pendientes de aprobación</h3>' +
            '<p class="tarjeta-sub">Apruebe el usuario y asígnele municipio: sin municipio no verá ningún caso.</p>' +
            pendientes.map(tarjetaUsuario).join('') + '</div>'
          : '') +
        '<div class="tarjeta"><h3>👥 Usuarios del módulo</h3>' +
          '<p class="tarjeta-sub">' + lista.length + ' usuario(s) registrado(s). ' +
            'Para dar de alta a alguien no hace falta que se registre: créelo aquí y ' +
            'entréguele la contraseña provisional.</p>' +
          '<p><button class="btn" id="btnNuevoUsuario">➕ Crear usuario</button></p>' +
          '<div class="tabla-env"><table class="t"><thead><tr><th>Usuario</th><th>Rol</th>' +
          '<th>Estado</th><th>Municipios</th><th>Registro</th><th></th></tr></thead><tbody>' +
          lista.map(function (u) {
            return '<tr><td><strong>' + esc(u.nombre) + '</strong>' +
              '<div style="font-size:.78rem;color:var(--texto-2)">' + esc(u.email) +
              (u.cargo ? ' · ' + esc(u.cargo) : '') + '</div></td>' +
              '<td><span class="sem ' + (u.rol === 'admin' ? 'rojo' : u.rol === 'coordinador' ? 'azul' : 'verde') +
                '">' + esc(ROLES[u.rol] || u.rol) + '</span></td>' +
              '<td><span class="sem ' + ({ activo: 'verde', pendiente: 'amarillo', inactivo: 'gris', rechazado: 'rojo' }[u.estado]) +
                '">' + esc(u.estado) + '</span>' +
                (u.clave_provisional
                  ? ' <span class="sem naranja" title="Todavía no ha elegido contraseña propia">🔑 provisional</span>'
                  : '') + '</td>' +
              '<td style="font-size:.79rem">' + (u.rol === 'responsable'
                ? (u.municipios.length ? u.municipios.map(DNTAuth.nombreMunicipio).join(', ')
                   : '<span class="sem naranja">Sin asignar</span>')
                : '<span class="sem gris">Todos</span>') + '</td>' +
              '<td style="font-size:.79rem">' + A.fecha(u.creado_en) + '</td>' +
              '<td><button class="btn sec chico" data-u="' + esc(u.id) + '">Gestionar</button></td></tr>';
          }).join('') + '</tbody></table></div></div>' +

        '<div class="tarjeta"><h3>📖 Qué puede hacer cada rol</h3>' +
          Object.keys(ROLES).map(function (r) {
            return '<div class="chk-item"><div class="chk-cab"><span class="chk-cod">' + esc(ROLES[r]) + '</span>' +
              '<div class="chk-txt" style="font-weight:400">' + esc(DESC_ROL[r]) + '</div></div></div>';
          }).join('') + '</div>';

      Array.prototype.forEach.call(el.querySelectorAll('[data-u]'), function (b) {
        b.onclick = function () { dialogoUsuario(lista.filter(function (u) { return u.id === b.dataset.u; })[0]); };
      });
      $('btnNuevoUsuario').onclick = dialogoCrearUsuario;
      Array.prototype.forEach.call(el.querySelectorAll('[data-clave]'), function (b) {
        b.onclick = function () {
          var c = claves.filter(function (x) { return x.id === b.dataset.clave; })[0];
          generarClave(c, porId[c.perfil_id]);
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll('[data-descartar]'), function (b) {
        b.onclick = async function () {
          if (!confirm('¿Descartar la solicitud sin generar contraseña?')) return;
          try {
            await DNTDatos.descartarSolicitudClave(b.dataset.descartar);
            A.toast('Solicitud descartada.', 'ok'); pintarAdmin();
          } catch (e) { A.toast(e.message, 'error'); }
        };
      });
    } catch (e) { errorAdmin(e); }
  }

  /** Una solicitud de contraseña en la bandeja del administrador. */
  function tarjetaClave(c, u) {
    return '<div class="chk-item pendiente"><div class="chk-cab">' +
      '<span class="chk-cod">clave</span>' +
      '<div class="chk-txt">' + esc(u ? u.nombre : c.email) +
        '<div class="chk-detalle">' + esc(c.email) +
        (u && u.cargo ? ' · ' + esc(u.cargo) : '') +
        '<br>Solicitada el ' + A.fecha(c.solicitado_en) +
        (u && u.telefono ? ' · tel. ' + esc(u.telefono) : '') +
        '</div></div></div>' +
      '<div class="chk-acciones">' +
        '<button class="btn chico" data-clave="' + esc(c.id) + '">Generar contraseña</button> ' +
        '<button class="btn sec chico" data-descartar="' + esc(c.id) + '">Descartar</button>' +
      '</div></div>';
  }

  async function generarClave(c, u) {
    try {
      var r = await DNTAuth.reiniciarClave(c.perfil_id);
      DNTAuth.registrar('clave_reiniciada', { entidad: 'dnt_perfiles', entidad_id: c.perfil_id });
      avisoClave(c.email, r.clave);
      pintarAdmin();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  /** Casillas de municipio, compartidas por el alta y la gestión. */
  function casillasMunicipio(marcados) {
    return '<div style="display:grid;gap:6px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">' +
      DNTAuth.municipios().map(function (m) {
        return '<label style="display:flex;gap:7px;align-items:center;font-size:.85rem;font-weight:400">' +
          '<input type="checkbox" name="uMun" value="' + esc(m.codigo) + '"' +
          ((marcados || []).indexOf(m.codigo) >= 0 ? ' checked' : '') +
          ' style="width:auto"> ' + esc(m.nombre) + '</label>';
      }).join('') + '</div>';
  }

  function municipiosMarcados() {
    return Array.prototype.slice.call(document.querySelectorAll('[name=uMun]:checked'))
      .map(function (x) { return x.value; });
  }

  /** Aviso con la contraseña provisional. No se puede volver a consultar. */
  function avisoClave(email, clave) {
    A.modal('Contraseña provisional',
      '<div class="aviso ok"><span class="ic">✓</span><div>La cuenta quedó lista.</div></div>' +
      '<p>Entréguele estos datos a <strong>' + esc(email) + '</strong>. ' +
        'La contraseña no se puede volver a consultar: si se pierde, genere otra desde ' +
        '«Gestionar».</p>' +
      '<div class="tarjeta" style="text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'font-size:1.5rem;font-weight:700;letter-spacing:.06em">' + esc(clave) + '</div>' +
      '<p class="ayuda">Es provisional: al entrar, el módulo le pedirá que elija una propia ' +
        'antes de dejarlo continuar.</p>',
      [{ texto: 'Copiar', accion: function () {
          navigator.clipboard.writeText(clave).then(
            function () { A.toast('Contraseña copiada.', 'ok'); },
            function () { A.toast('Cópiela a mano: el navegador no lo permitió.', 'error'); });
        } },
       { texto: 'Listo', clase: '', accion: A.cerrarModal }]);
  }

  function dialogoCrearUsuario() {
    A.modal('Crear usuario',
      '<p class="tarjeta-sub">Si el correo ya tiene cuenta del Portal de Salud Pública, no se crea ' +
        'otra: se le da acceso al módulo y conserva su contraseña.</p>' +
      cp('cNombre', 'Nombre completo', '<input id="cNombre" placeholder="Nombres y apellidos">') +
      cp('cCorreo', 'Correo institucional', '<input id="cCorreo" type="email" placeholder="nombre@esehrno.gov.co">') +
      '<div class="fila">' +
        cp('cCargo', 'Cargo', '<input id="cCargo" placeholder="Enfermera, médico, nutricionista…">') +
        cp('cTelefono', 'Teléfono', '<input id="cTelefono">') +
      '</div>' +
      cp('cRol', 'Rol', '<select id="cRol">' +
        Object.keys(ROLES).map(function (r) { return A.opcion(r, ROLES[r], 'responsable'); }).join('') +
        '</select>', DESC_ROL.responsable) +
      '<div class="campo" id="cCampoMun"><label>Municipios asignados</label>' +
        '<div class="ayuda" style="margin-bottom:7px">Sólo aplica al rol Responsable. ' +
          'Sin municipio no vería ningún caso.</div>' + casillasMunicipio([]) + '</div>',
      [
        { texto: 'Cancelar', accion: A.cerrarModal },
        { texto: 'Crear', clase: '', accion: async function () {
          var datos = {
            nombre: $('cNombre').value.trim(), email: $('cCorreo').value.trim(),
            cargo: $('cCargo').value.trim(), telefono: $('cTelefono').value.trim(),
            rol: $('cRol').value, municipios: municipiosMarcados()
          };
          try {
            var r = await DNTAuth.crearUsuario(datos);
            DNTAuth.registrar('usuario_creado', { entidad: 'dnt_perfiles', entidad_id: r.id,
              detalle: { email: datos.email, rol: datos.rol } });
            if (r.clave) avisoClave(datos.email, r.clave);
            else {
              A.cerrarModal();
              A.toast('Ya tenía cuenta del portal: entra con esa misma contraseña.', 'ok');
            }
            pintarAdmin();
          } catch (e) { A.toast(e.message, 'error'); }
        } }
      ]);
    $('cRol').onchange = function () {
      var ayuda = $('cRol').parentNode.querySelector('.ayuda');
      if (ayuda) ayuda.textContent = DESC_ROL[$('cRol').value];
      $('cCampoMun').style.display = $('cRol').value === 'responsable' ? '' : 'none';
    };
  }

  function tarjetaUsuario(u) {
    return '<div class="chk-item pendiente"><div class="chk-cab">' +
      '<span class="chk-cod">nuevo</span>' +
      '<div class="chk-txt">' + esc(u.nombre) +
        '<div class="chk-detalle">' + esc(u.email) + (u.cargo ? ' · ' + esc(u.cargo) : '') +
        (u.telefono ? ' · ' + esc(u.telefono) : '') +
        (u.municipio_solicitado ? '<br>Solicita acceso a <strong>' +
          esc(DNTAuth.nombreMunicipio(u.municipio_solicitado)) + '</strong>' : '') +
        '</div></div></div>' +
      '<div class="chk-acciones"><button class="btn chico" data-u="' + esc(u.id) + '">Revisar y aprobar</button></div></div>';
  }

  function dialogoUsuario(u) {
    if (!u) return;
    var soy = DNTAuth.usuario().id === u.id;
    A.modal('Gestionar usuario',
      '<div class="tabla-env" style="margin-bottom:14px"><table class="t"><tbody>' +
        '<tr><td style="color:var(--texto-3);font-weight:600">Nombre</td><td>' + esc(u.nombre) + '</td></tr>' +
        '<tr><td style="color:var(--texto-3);font-weight:600">Correo</td><td>' + esc(u.email) + '</td></tr>' +
        '<tr><td style="color:var(--texto-3);font-weight:600">Cargo</td><td>' + esc(u.cargo || '—') + '</td></tr>' +
        '<tr><td style="color:var(--texto-3);font-weight:600">Teléfono</td><td>' + esc(u.telefono || '—') + '</td></tr>' +
        '<tr><td style="color:var(--texto-3);font-weight:600">Solicitó</td><td>' +
          esc(u.municipio_solicitado ? DNTAuth.nombreMunicipio(u.municipio_solicitado) : '—') + '</td></tr>' +
      '</tbody></table></div>' +
      (soy ? '<div class="aviso ojo"><span class="ic">!</span><div>Es su propia cuenta: no puede cambiarse el rol ni desactivarse.</div></div>' : '') +
      '<div class="fila">' +
        cp('uRol', 'Rol', '<select id="uRol"' + (soy ? ' disabled' : '') + '>' +
          Object.keys(ROLES).map(function (r) { return A.opcion(r, ROLES[r], u.rol); }).join('') + '</select>',
          DESC_ROL[u.rol]) +
        cp('uEstado', 'Estado', '<select id="uEstado"' + (soy ? ' disabled' : '') + '>' +
          ['activo', 'pendiente', 'inactivo', 'rechazado'].map(function (e) {
            return A.opcion(e, e.charAt(0).toUpperCase() + e.slice(1), u.estado);
          }).join('') + '</select>') +
      '</div>' +
      '<div class="campo"><label>Municipios asignados</label>' +
        '<div class="ayuda" style="margin-bottom:7px">Sólo aplica al rol Responsable. Administrador y coordinador ven todos.</div>' +
        casillasMunicipio(u.municipios) + '</div>',
      [
        { texto: 'Cancelar', accion: A.cerrarModal },
        { texto: 'Contraseña nueva', accion: async function () {
          if (!confirm('Se le asignará una contraseña provisional a ' + u.email +
                       ' y la actual dejará de servir. ¿Continuar?')) return;
          try {
            var r = await DNTAuth.reiniciarClave(u.id);
            avisoClave(u.email, r.clave);
          } catch (e) { A.toast(e.message, 'error'); }
        } },
        { texto: 'Guardar', clase: '', accion: async function () {
          try {
            if (soy) {
              // La propia cuenta no pasa por la función de borde, que la rechaza
              // a propósito; aquí sólo pueden cambiar los municipios.
              await DNTDatos.asignarMunicipios(u.id, municipiosMarcados());
            } else {
              // Rol, estado y municipios en una sola operación: así no queda un
              // responsable activo sin municipio si algo falla a mitad de camino.
              await DNTAuth.fijarAcceso({ id: u.id, rol: $('uRol').value,
                estado: $('uEstado').value, municipios: municipiosMarcados() });
              DNTAuth.registrar('usuario_actualizado', { entidad: 'dnt_perfiles', entidad_id: u.id,
                detalle: { rol: $('uRol').value, estado: $('uEstado').value } });
            }
            A.cerrarModal(); A.toast('Usuario actualizado.', 'ok'); pintarAdmin();
          } catch (e) { A.toast(e.message, 'error'); }
        } }
      ]);
    $('uRol').onchange = function () {
      var ayuda = $('uRol').parentNode.querySelector('.ayuda');
      if (ayuda) ayuda.textContent = DESC_ROL[$('uRol').value];
    };
  }

  async function panelPapelera() {
    try {
      var lista = await DNTDatos.soportesEliminados();
      var el = $('panelAdmin'); el.className = '';
      el.innerHTML =
        '<div class="tarjeta"><h3>🗑️ Documentos eliminados</h3>' +
          '<p class="tarjeta-sub">La eliminación es lógica: el archivo se conserva y puede restaurarse. ' +
          'Toda eliminación queda en la auditoría.</p>' +
          (lista.length
            ? '<div class="tabla-env"><table class="t"><thead><tr><th>Archivo</th><th>Municipio</th>' +
              '<th>Ítem</th><th>Eliminado</th><th>Motivo</th><th></th></tr></thead><tbody>' +
              lista.map(function (s) {
                return '<tr><td><strong>' + esc(s.nombre_archivo) + '</strong>' +
                  '<div style="font-size:.77rem;color:var(--texto-2)">v' + s.version + ' · ' +
                  Math.round((s.file_size || 0) / 1024) + ' KB</div></td>' +
                  '<td>' + esc(DNTAuth.nombreMunicipio(s.municipio)) + '</td>' +
                  '<td class="mono">' + esc(s.item || '—') + '</td>' +
                  '<td style="font-size:.79rem">' + A.fecha(s.eliminado_en) + '</td>' +
                  '<td style="font-size:.79rem">' + esc(s.motivo_eliminacion || '—') + '</td>' +
                  '<td><button class="btn sec chico" data-r="' + esc(s.id) + '">Restaurar</button></td></tr>';
              }).join('') + '</tbody></table></div>'
            : '<div class="vacio"><span class="emo">🗑️</span>No hay documentos eliminados.</div>') +
        '</div>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-r]'), function (b) {
        b.onclick = async function () {
          try { await DNTDatos.restaurarSoporte(b.dataset.r); A.toast('Documento restaurado.', 'ok'); pintarAdmin(); }
          catch (e) { A.toast(e.message, 'error'); }
        };
      });
    } catch (e) { errorAdmin(e); }
  }

  async function panelAuditoria() {
    try {
      var lista = await DNTDatos.auditoria(300);
      var el = $('panelAdmin'); el.className = '';
      el.innerHTML =
        '<div class="tarjeta"><h3>🔍 Auditoría del módulo</h3>' +
          '<p class="tarjeta-sub">Últimos 300 eventos. Registra ingresos, consultas de caso, cargues, ' +
          'descargas de documentos, cierres y cambios de permisos.</p>' +
          '<div class="aviso ojo" style="margin-bottom:12px"><span class="ic">!</span><div>' +
            '<strong>«clave modificada» sin un «clave reiniciada» al lado es un cambio hecho fuera del módulo</strong>' +
            'Por ejemplo, desde la consola de Supabase. La cuenta queda marcada como provisional, ' +
            'así que a esa persona el módulo le exigirá elegir contraseña al entrar.</div></div>' +
          '<div class="tabla-env"><table class="t"><thead><tr><th>Fecha y hora</th><th>Evento</th>' +
          '<th>Entidad</th><th>Municipio</th><th>Detalle</th></tr></thead><tbody>' +
          (lista.length ? lista.map(function (l) {
            return '<tr><td style="font-size:.79rem" class="mono">' +
              new Date(l.creado_en).toLocaleString('es-CO') + '</td>' +
              '<td><span class="sem ' + (/eliminad/.test(l.evento) ? 'rojo' :
                /clave/.test(l.evento) ? 'naranja' :
                /cerrad|cierre/.test(l.evento) ? 'naranja' : 'gris') + '">' +
                esc(l.evento.replace(/_/g, ' ')) + '</span></td>' +
              '<td style="font-size:.79rem">' + esc(l.entidad || '—') + '</td>' +
              '<td style="font-size:.79rem">' + esc(l.municipio ? DNTAuth.nombreMunicipio(l.municipio) : '—') + '</td>' +
              '<td style="font-size:.76rem;color:var(--texto-2);max-width:340px;overflow:hidden;text-overflow:ellipsis">' +
                esc(JSON.stringify(l.detalle || {})) + '</td></tr>';
          }).join('') : '<tr><td colspan="5" class="vacio">Sin eventos registrados.</td></tr>') +
          '</tbody></table></div></div>';
    } catch (e) { errorAdmin(e); }
  }

  function errorAdmin(e) {
    var el = $('panelAdmin'); el.className = '';
    el.innerHTML = '<div class="aviso grave"><span class="ic">⚠</span><div><strong>No se pudo cargar</strong>' +
      esc(e.message) + '</div></div>';
  }

  return { pintarIndicadores: pintarIndicadores, pintarApoyo: pintarApoyo, pintarAdmin: pintarAdmin };
})();
