// ============================================================
// CertiVac v5.1 — Backend Google Apps Script
// ESE Hospital Regional Noroccidental — PAI
// ============================================================

const CONFIG = {
  HOJA_REGISTROS:    'REGISTROS_PAI',
  HOJA_ARCHIVOS:     'ARCHIVOS_CARGADOS',
  HOJA_PARAMETROS:   'PARAMETROS',
  HOJA_ALIAS:        'ALIAS_VACUNADORAS',
  HOJA_VALORES:      'VALORES_BIOLOGICOS',
  HOJA_ASIGNACIONES: 'ASIGNACIONES_MUNICIPIO',
  VERSION_SCHEMA:    '1.2',
};

const COLS_REGISTROS = [
  'id_registro','fecha_carga','id_archivo','nombre_archivo',
  'dia','año','mes_num','mes_nombre','trimestre','semestre',
  'vacunadora','id_paciente','tipo_edad','edad_num','edad_meses',
  'poblacion','biologico','texto_dosis','ciclo','grupo_ciclo',
  'en_ciclo','valor_unitario','meta_ciclo','municipio','departamento','institucion',
];

const COLS_ARCHIVOS = [
  'id_archivo','nombre_archivo','fecha_carga','tamaño',
  'mes_archivo','año_archivo','municipio','departamento','institucion',
  'total_registros','en_ciclo','fuera_ciclo','estado',
];

// ─────────────────────────────────────────────
// HELPERS JSON
// ─────────────────────────────────────────────
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
function errorResponse(msg) {
  return jsonResponse({ ok: false, error: msg });
}

// Valida que un id_registro sea un UUID real (no el de ejemplo)
// Un UUID real tiene formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
function esRegistroReal(row) {
  const id = String(row[0] || '').trim();
  if (!id) return false;
  if (id.toLowerCase().includes('ejemplo')) return false;
  if (id.toLowerCase().includes('uuid-arch')) return false; // id de archivo, no de registro
  // UUID Utilities.getUuid() siempre genera formato estándar con guiones
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ─────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────
function doGet(e) {
  // Si llega con parámetro accion= → es una llamada de API, siempre devolver JSON
  const accion = ((e && e.parameter && e.parameter.accion) || '').toLowerCase();

  if (accion) {
    // Modo API: devolver siempre JSON, nunca HTML
    try {
      switch (accion) {
        case 'ping':          return jsonResponse({ ok: true, ts: new Date().toISOString() });
        case 'registros':     return apiGetRegistros(e);
        case 'archivos':      return apiGetArchivos(e);
        case 'liquidacion':   return apiGetLiquidacion(e);
        case 'analytics':     return apiGetAnalytics(e);
        case 'periodos':      return apiGetPeriodos(e);
        case 'alias':         return apiGetAlias(e);
        case 'valores':       return apiGetValores(e);
        case 'asignaciones':  return apiGetAsignaciones(e);
        case 'trazadores':    return apiGetTrazadores(e);
        default:              return errorResponse('Acción no reconocida: ' + accion);
      }
    } catch (err) {
      Logger.log('doGet API error [' + accion + ']: ' + err.toString() + '\nStack: ' + err.stack);
      return errorResponse('Error en ' + accion + ': ' + err.message);
    }
  }

  // Sin parámetro accion → intentar servir el frontend HTML (solo si existe)
  try {
    return HtmlService
      .createHtmlOutputFromFile('index')
      .setTitle('CertiVac — Sistema PAI')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch(htmlErr) {
    // Si el archivo index.html no está en el proyecto, devolver instrucciones JSON
    return jsonResponse({
      ok: false,
      mensaje: 'CertiVac API activa. Use el index.html externo y configure API_URL con esta URL.',
      endpoints: 'ping|registros|archivos|liquidacion|analytics|periodos|alias|valores|asignaciones|trazadores',
      version: '5.2'
    });
  }
}

function doPost(e) {
  try {
    let body;
    try {
      const raw = (e.parameter && e.parameter.payload) ? e.parameter.payload : null;
      body = JSON.parse(raw || e.postData.contents || '{}');
    } catch(pe) { return errorResponse('JSON inválido: ' + pe.message); }

    const accion = (body.accion || '').toLowerCase();
    switch (accion) {
      case 'guardar_lote':      return apiGuardarLote(body);
      case 'borrar_archivo':    return apiBorrarArchivo(body);
      case 'borrar_todo':       return apiBorrarTodo(body);
      case 'guardar_alias':     return apiGuardarAlias(body);
      case 'borrar_alias':      return apiBorrarAlias(body);
      case 'normalizar_nombres':return apiNormalizarNombres(body);
      case 'guardar_valores':   return apiGuardarValores(body);
      case 'guardar_asignaciones': return apiGuardarAsignaciones(body);
      default: return errorResponse('Acción desconocida: ' + accion);
    }
  } catch (err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// INICIALIZAR HOJAS
// ─────────────────────────────────────────────
function asegurarHojas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let hr = ss.getSheetByName(CONFIG.HOJA_REGISTROS);
  if (!hr) {
    hr = ss.insertSheet(CONFIG.HOJA_REGISTROS);
    hr.getRange(1,1,1,COLS_REGISTROS.length).setValues([COLS_REGISTROS])
      .setBackground('#0C1B33').setFontColor('#00B4A0').setFontWeight('bold').setFontSize(10);
    hr.setFrozenRows(1);
    hr.setColumnWidths(1, COLS_REGISTROS.length, 140);
  }

  let ha = ss.getSheetByName(CONFIG.HOJA_ARCHIVOS);
  if (!ha) {
    ha = ss.insertSheet(CONFIG.HOJA_ARCHIVOS);
    ha.getRange(1,1,1,COLS_ARCHIVOS.length).setValues([COLS_ARCHIVOS])
      .setBackground('#0C1B33').setFontColor('#F59E0B').setFontWeight('bold').setFontSize(10);
    ha.setFrozenRows(1);
  }

  let hp = ss.getSheetByName(CONFIG.HOJA_PARAMETROS);
  if (!hp) {
    hp = ss.insertSheet(CONFIG.HOJA_PARAMETROS);
    hp.getRange('A1:B1').setValues([['clave','valor']])
      .setBackground('#0C1B33').setFontColor('#fff').setFontWeight('bold');
    const params = [
      ['schema_version','1.1'],
      ['creado', new Date().toISOString()],
      ['institucion','ESE Hospital Regional Noroccidental - PAI'],
      ['municipio','Abrego'],
      ['departamento','Norte de Santander'],
      ['contrato','CPSESEHRNO-0064-2026'],
    ];
    hp.getRange(2,1,params.length,2).setValues(params);
    hp.setColumnWidth(1,180); hp.setColumnWidth(2,300);
  }

  // HOJA ALIAS
  let hAlias = ss.getSheetByName(CONFIG.HOJA_ALIAS);
  if (!hAlias) {
    hAlias = ss.insertSheet(CONFIG.HOJA_ALIAS);
    hAlias.getRange(1,1,1,3).setValues([['alias_raw','nombre_canonical','fecha_creacion']])
      .setBackground('#0C1B33').setFontColor('#7C3AED').setFontWeight('bold').setFontSize(10);
    hAlias.setFrozenRows(1);
    hAlias.setColumnWidth(1,280); hAlias.setColumnWidth(2,280); hAlias.setColumnWidth(3,180);
    hAlias.getRange(2,1,1,3).setValues([
      ['EJEMPLO_ALIAS (borrar)','NOMBRE_CANONICAL (borrar)', new Date().toISOString()]
    ]).setFontColor('#aaaaaa').setFontStyle('italic');
    Logger.log('Hoja ALIAS_VACUNADORAS creada');
  }

  // HOJA VALORES BIOLÓGICOS
  let hVal = ss.getSheetByName(CONFIG.HOJA_VALORES);
  if (!hVal) {
    hVal = ss.insertSheet(CONFIG.HOJA_VALORES);
    hVal.getRange(1,1,1,4).setValues([['ciclo','biologico_label','meta','valor_unitario']])
      .setBackground('#0C1B33').setFontColor('#00B4A0').setFontWeight('bold').setFontSize(10);
    hVal.setFrozenRows(1);
    hVal.setColumnWidth(1,200); hVal.setColumnWidth(2,240); hVal.setColumnWidth(3,80); hVal.setColumnWidth(4,130);

    const valoresDefault = [
      ['2M-Polio','Polio Inyectable 2 meses',11,8000],
      ['2M-Penta','Pentavalente 2 meses',11,8000],
      ['2M-Rota','Rotavirus 2 meses',11,8000],
      ['2M-Neumo','Neumococo 2 meses',11,8000],
      ['4M-Polio','Polio Inyectable 4 meses',11,8000],
      ['4M-Penta','Pentavalente 4 meses',11,8000],
      ['4M-Rota','Rotavirus 4 meses',11,8000],
      ['4M-Neumo','Neumococo 4 meses',11,8000],
      ['6M-Polio','Polio Inyectable 6 meses',11,8000],
      ['6M-Penta','Pentavalente 6 meses',11,8000],
      ['6M-Influ','Influenza 6 meses',11,8000],
      ['7M-Influ','Influenza 7 meses',11,8000],
      ['1A-HepA','Hepatitis A 1 año',11,8000],
      ['1A-Varicela','Varicela 1 año',11,8000],
      ['1A-TripleViral','Triple Viral 1 año',11,8000],
      ['1A-FA','Fiebre Amarilla 1 año',11,8000],
      ['1A-Neumo','Neumococo 1 año',11,8000],
      ['18M-Penta','Pentavalente 18 meses',11,8000],
      ['18M-Polio','Polio Inyectable 18 meses',11,8000],
      ['18M-TripleViral','Triple Viral 18 meses',11,8000],
      ['5A-DPT','DPT 5 años',11,8000],
      ['5A-PolioOral','Polio Oral 5 años',11,8000],
      ['5A-PolioInyec','Polio Inyectable 5 años',11,8000],
      ['5A-Varicela','Varicela 5 años',11,8000],
      ['COVID','COVID 19',5,8000],
      ['VPH','VPH',10,8000],
      ['InfluAdultos','Influenza Adultos',11,8000],
      ['RN-BCG','BCG Recién Nacido',11,8000],
      ['RN-HepB','Hepatitis B Recién Nacido',11,8000],
    ];
    hVal.getRange(2,1,valoresDefault.length,4).setValues(valoresDefault);
    Logger.log('Hoja VALORES_BIOLOGICOS creada');
  }

  // HOJA ASIGNACIONES VACUNADORA → MUNICIPIO
  let hAsig = ss.getSheetByName(CONFIG.HOJA_ASIGNACIONES);
  if (!hAsig) {
    hAsig = ss.insertSheet(CONFIG.HOJA_ASIGNACIONES);
    hAsig.getRange(1,1,1,4).setValues([['vacunadora_canonical','municipio_asignado','departamento','notas']])
      .setBackground('#0C1B33').setFontColor('#F59E0B').setFontWeight('bold').setFontSize(10);
    hAsig.setFrozenRows(1);
    hAsig.setColumnWidth(1,280); hAsig.setColumnWidth(2,200);
    hAsig.setColumnWidth(3,200); hAsig.setColumnWidth(4,240);
    Logger.log('Hoja ASIGNACIONES_MUNICIPIO creada');
  }

  return { hr, ha, hp, hAlias, hVal, hAsig };
}

// ─────────────────────────────────────────────
// LEER ALIAS (nombre_raw → canonical)
// ─────────────────────────────────────────────
function cargarMapaAlias() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hAlias = ss.getSheetByName(CONFIG.HOJA_ALIAS);
  if (!hAlias || hAlias.getLastRow() <= 1) return {};
  const datos = hAlias.getDataRange().getValues().slice(1);
  const mapa = {};
  datos.forEach(row => {
    const raw = String(row[0] || '').trim().toUpperCase();
    const canonical = String(row[1] || '').trim().toUpperCase();
    if (raw && canonical && !raw.includes('EJEMPLO')) {
      mapa[raw] = canonical;
    }
  });
  return mapa;
}

function resolverNombre(nombreRaw, mapaAlias) {
  const normalizado = String(nombreRaw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return mapaAlias[normalizado] || normalizado;
}

// ─────────────────────────────────────────────
// LEER VALORES (ciclo → {meta, valor})
// ─────────────────────────────────────────────
function cargarValores() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hVal = ss.getSheetByName(CONFIG.HOJA_VALORES);
  if (!hVal || hVal.getLastRow() <= 1) return {};
  const datos = hVal.getDataRange().getValues().slice(1);
  const mapa = {};
  datos.forEach(row => {
    const ciclo = String(row[0] || '').trim();
    if (ciclo) {
      mapa[ciclo] = {
        label: String(row[1] || '').trim(),
        meta:  parseInt(row[2]) || 11,
        valor: parseInt(row[3]) || 8000,
      };
    }
  });
  return mapa;
}

// ─────────────────────────────────────────────
// GUARDAR LOTE (con soporte chunks)
// ─────────────────────────────────────────────
function apiGuardarLote(body) {
  try {
    const { archivo, registros } = body;
    if (!archivo || !registros || !registros.length)
      return errorResponse('Faltan datos: archivo y registros requeridos');

    const esChunk    = archivo.esChunk === true;
    const chunkIndex = parseInt(archivo.chunkIndex) || 0;
    const idExistente= archivo.idArchivoExistente || '';
    const { hr, ha } = asegurarHojas();
    const mapaAlias  = cargarMapaAlias();
    const ahora      = new Date().toISOString();
    let idArch;

    if (!esChunk || chunkIndex === 0) {
      const datosArch = ha.getDataRange().getValues();
      const existe = datosArch.slice(1).find(r => r[1] === archivo.nombre);
      if (existe && !esChunk)
        return errorResponse(`"${archivo.nombre}" ya fue cargado. Elimínelo primero.`);
      if (!existe) {
        idArch = generarUUID();
        ha.appendRow([
          idArch, archivo.nombre, ahora, archivo.tamaño||'',
          archivo.mes||'', archivo.año||'', archivo.municipio||'',
          archivo.departamento||'', archivo.institucion||'',
          0, 0, 0, 'PROCESANDO',
        ]);
      } else {
        idArch = existe[0];
      }
    } else {
      idArch = idExistente || generarUUID();
    }

    const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

    const filas = registros.map(r => {
      // Resolver alias
      const vacResolved = resolverNombre(r.vacunadora, mapaAlias);
      const dStr  = String(r.dia || '').trim();
      const parts = dStr.split('-');
      const anio  = parts[0] || '';
      const mesN  = parseInt(parts[1]) || 0;
      const trim  = mesN ? 'T' + Math.ceil(mesN / 3) : '';
      const sem   = mesN ? 'S' + (mesN <= 6 ? 1 : 2) : '';
      return [
        generarUUID(), ahora, idArch, archivo.nombre,
        dStr, anio, mesN||'', MESES[mesN]||'', trim, sem,
        vacResolved,
        r.idPaciente||'', r.tipoEdad||'', r.edadNum||'', r.edadMeses||r.edadM||0,
        r.poblacion||'', r.biologico||'', r.dosis||'',
        r.ciclo||'', r.grupoCiclo||'',
        r.ciclo ? 'TRUE' : 'FALSE',
        8000, r.metaCiclo||11,
        archivo.municipio||'', archivo.departamento||'',
        archivo.institucion||'ESE Hospital Regional Noroccidental - PAI',
      ];
    });

    const BATCH = 500;
    const lastRow = hr.getLastRow();
    for (let i = 0; i < filas.length; i += BATCH) {
      const ch = filas.slice(i, i + BATCH);
      hr.getRange(lastRow + 1 + i, 1, ch.length, COLS_REGISTROS.length).setValues(ch);
    }

    const esUltimo = !esChunk || (parseInt(archivo.chunkIndex) === parseInt(archivo.totalChunks) - 1);
    if (esUltimo) {
      const todos = hr.getDataRange().getValues().slice(1).filter(r => r[2] === idArch);
      const enCiclo = todos.filter(r => r[20] === 'TRUE').length;
      const datosA  = ha.getDataRange().getValues();
      for (let i = 1; i < datosA.length; i++) {
        if (datosA[i][0] === idArch) {
          ha.getRange(i+1,10).setValue(todos.length);
          ha.getRange(i+1,11).setValue(enCiclo);
          ha.getRange(i+1,12).setValue(todos.length - enCiclo);
          ha.getRange(i+1,13).setValue('OK');
          break;
        }
      }
    }

    return jsonResponse({ ok: true, idArchivo: idArch, registrosGuardados: filas.length });
  } catch (err) {
    Logger.log('apiGuardarLote error: ' + err.toString());
    return errorResponse('Error: ' + err.message);
  }
}

// ─────────────────────────────────────────────
// GET REGISTROS
// ─────────────────────────────────────────────
function apiGetRegistros(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const { hr } = asegurarHojas();
    const datos = hr.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok: true, registros: [], total: 0 });
    const enc  = datos[0];
    const filtroArch = p.id_archivo || '';
    const filtroMes  = p.mes || '';
    const limite     = parseInt(p.limite) || 2000;
    let regs = datos.slice(1).filter(esRegistroReal)
      .filter(r => !filtroArch || r[2] === filtroArch)
      .filter(r => !filtroMes || String(r[4]).startsWith(filtroMes));
    const total = regs.length;
    regs = regs.slice(0, limite).map(row => {
      const obj = {}; enc.forEach((h,i) => obj[h] = row[i]); return obj;
    });
    return jsonResponse({ ok: true, registros: regs, total });
  } catch (err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// GET ARCHIVOS
// ─────────────────────────────────────────────
function apiGetArchivos(e) {
  try {
    const { ha } = asegurarHojas();
    const datos = ha.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok: true, archivos: [] });
    const enc = datos[0];
    const archivos = datos.slice(1).filter(r => r[0]).map(row => {
      const obj = {}; enc.forEach((h,i) => obj[h] = row[i]); return obj;
    });
    return jsonResponse({ ok: true, archivos });
  } catch (err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// GET PERÍODOS
// ─────────────────────────────────────────────
function apiGetPeriodos(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const { hr } = asegurarHojas();
    const datos = hr.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok: true, periodos: [] });
    const set = new Set();
    datos.slice(1).forEach(r => {
      // Extraer YYYY-MM del campo dia (col E = índice 4) directamente
      const d = String(r[4] || '').trim();
      if (d.length >= 7) set.add(d.substring(0, 7));
    });
    return jsonResponse({ ok: true, periodos: [...set].sort().reverse() });
  } catch (err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// GET LIQUIDACIÓN
// ─────────────────────────────────────────────
function apiGetLiquidacion(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const filtroMes  = p.mes  || '';   // YYYY-MM
    const filtroAnio = p.año  || '';   // YYYY
    const { hr } = asegurarHojas();
    const mapaAlias  = cargarMapaAlias();        // ← alias aplicados en liquidación
    const mapaValores = cargarValores();
    const datos = hr.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok: true, vacs: [], granTotal: 0, granExt: 0, periodos: [] });

    let filas = datos.slice(1).filter(esRegistroReal);  // excluye fila ejemplo

    // Filtros de período usando normalizarFecha (robusto con cualquier formato)
    if (filtroMes)  filas = filas.filter(r => normalizarFecha(r[4]).startsWith(filtroMes));
    if (filtroAnio) filas = filas.filter(r => normalizarFecha(r[4]).startsWith(filtroAnio));

    // Períodos disponibles (para poblar los selectores del frontend)
    const periodos = [...new Set(
      datos.slice(1).filter(esRegistroReal)
        .map(r => { const f = normalizarFecha(r[4]); return f.length >= 7 ? f.substring(0,7) : ''; })
        .filter(Boolean)
    )].sort().reverse();

    const conteo = {}, fueraCont = {};
    filas.forEach(r => {
      const vacRaw = String(r[10] || '').trim();
      const vac    = resolverNombre(vacRaw, mapaAlias);  // ← ALIAS aplicados aquí
      const ciclo  = String(r[18] || '').trim();
      const grp    = String(r[19] || '').trim();
      const ck     = ['VPH','VPH2','VPH3'].includes(ciclo) ? 'VPH' : ciclo;
      const vInfo  = ck ? (mapaValores[ck] || null) : null;
      const meta   = vInfo ? vInfo.meta  : (parseInt(r[22]) || 11);
      const val    = vInfo ? vInfo.valor : (parseInt(r[21]) || 8000);

      if (!vac) return;
      if (!conteo[vac]) { conteo[vac] = {}; fueraCont[vac] = 0; }
      if (ck) {
        if (!conteo[vac][ck]) conteo[vac][ck] = { ap:0, meta, valor:val, grupo:grp };
        conteo[vac][ck].ap++;
        conteo[vac][ck].meta  = meta;
        conteo[vac][ck].valor = val;
      } else {
        fueraCont[vac]++;
      }
    });

    const vacs = [];
    let granTotal = 0, granExt = 0;
    Object.keys(conteo).sort().forEach(vac => {
      const ciclos = conteo[vac];
      const detalles = [];
      let tAp=0, tEnMeta=0, tFuera=0, tVal=0, tValExt=0;
      Object.keys(ciclos).sort().forEach(ck => {
        const { ap, meta, valor, grupo } = ciclos[ck];
        const enMeta = Math.min(ap, meta);
        const fuera  = Math.max(0, ap - meta);
        const v = enMeta * valor, vExt = fuera * valor;
        tAp+=ap; tEnMeta+=enMeta; tFuera+=fuera; tVal+=v; tValExt+=vExt;
        detalles.push({ ciclo:ck, grupo, meta, valor, ap, enMeta, fuera, val:v, valExt:vExt });
      });
      const fueraSC = fueraCont[vac]||0;
      tAp+=fueraSC; tFuera+=fueraSC;
      granTotal+=tVal; granExt+=tValExt;
      vacs.push({ vac, tAp, tEnMeta, tFuera, tVal, tValExt, fueraSinCiclo:fueraSC, detalles });
    });
    return jsonResponse({ ok:true, vacs, granTotal, granExt, filtroMes, filtroAnio, periodos });
  } catch (err) { return errorResponse(err.message); }
}

// ═══════════════════════════════════════════════════════════════════════
// REEMPLAZAR SOLO LA FUNCIÓN apiGetAnalytics en Codigo_Backend.gs
// FIX COMPLETO: parsing robusto de fechas + agrupaciones por día/semana
// ═══════════════════════════════════════════════════════════════════════

// ─── HELPER: Normalizar fecha a YYYY-MM-DD sin importar el formato ────
// El campo dia puede llegar como:
//   "2025-07-09"           → string normal
//   "2025-07-09T00:00:00Z" → ISO con hora
//   Date object            → objeto Date de Apps Script
//   44756                  → número serial de Excel
//   "9"                    → solo el día (sin fecha)
function normalizarFecha(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  // Formato ISO con hora
  if (s.includes('T')) return s.substring(0, 10);
  // Formato YYYY-MM-DD ya correcto
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // Número serial de Excel (días desde 1899-12-30)
  if (/^\d{5,6}$/.test(s)) {
    const serial = parseInt(s);
    const msPerDay = 86400000;
    const epoch = new Date(1899, 11, 30).getTime();
    const d = new Date(epoch + serial * msPerDay);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // Formato DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const p = s.split('/');
    return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  }
  return s.length >= 10 ? s.substring(0, 10) : '';
}

// ─── HELPER: Obtener semana ISO de un año (YYYY-WNN) ──────────────────
function getSemanaISO(fechaStr) {
  if (!fechaStr || fechaStr.length < 10) return '';
  const d = new Date(fechaStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const semana = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(semana).padStart(2, '0')}`;
}

// ─── HELPER: Obtener clave de período según agrupación ────────────────
function getPeriodoKey(fechaStr, agrupacion) {
  const f = normalizarFecha(fechaStr);
  if (!f || f.length < 10) return '';
  const y = f.substring(0, 4);
  const m = parseInt(f.substring(5, 7)) || 0;
  const d = f.substring(8, 10);
  if (!y || !m) return '';
  switch (agrupacion) {
    case 'dia':        return f;                                           // YYYY-MM-DD
    case 'semana':     return getSemanaISO(f);                             // YYYY-WNN
    case 'mes':        return `${y}-${String(m).padStart(2,'0')}`;        // YYYY-MM
    case 'trimestre':  return `${y}-T${Math.ceil(m/3)}`;                  // YYYY-T1..4
    case 'semestre':   return `${y}-S${m<=6?1:2}`;                        // YYYY-S1/S2
    case 'año':        return y;                                           // YYYY
    default:           return `${y}-${String(m).padStart(2,'0')}`;
  }
}

function getPeriodoLabel(key, agrupacion) {
  const meses = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  switch (agrupacion) {
    case 'dia': {
      const p = key.split('-');
      return `${p[2]}/${p[1].replace(/^0/,'')}/${p[0].substring(2)}`;
    }
    case 'semana': return key.replace('-W', ' Sem ');
    case 'mes': {
      const p = key.split('-');
      return `${meses[parseInt(p[1])||0]} ${p[0]}`;
    }
    case 'año': return key;
    default: return key.replace('-', ' ');
  }
}

// ─── FUNCIÓN PRINCIPAL apiGetAnalytics ────────────────────────────────
function apiGetAnalytics(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const agrupacion  = p.agrupacion  || 'mes';
    const filtroVac   = p.vacunadora  || '';
    const filtroMun   = p.municipio   || '';
    const filtroAnio  = p.año         || '';
    const filtroMes   = p.mes         || ''; // YYYY-MM
    const filtroDesde = p.desde       || ''; // YYYY-MM-DD
    const filtroHasta = p.hasta       || ''; // YYYY-MM-DD

    const { hr } = asegurarHojas();
    const mapaAlias = cargarMapaAlias();
    const mapaAsig  = cargarMapaAsignaciones(); // vacunadora → {municipio, departamento}
    const datos = hr.getDataRange().getValues();

    if (datos.length <= 1) {
      return jsonResponse({ ok:true, agrupacion, periodos:[], vacunadoras:[],
        biologicos:[], grupos:[], municipios:[], matVac:{}, matBio:{}, matGrupo:{},
        matMun:{}, seriesDia:[], totalRegistros:0 });
    }

    let filas = datos.slice(1).filter(esRegistroReal); // excluye fila ejemplo

    // ── Helper: resolver municipio de un registro ─────────────────────
    // Prioridad: 1) asignación manual, 2) municipio del archivo (col X = índice 23)
    function getMunicipio(row) {
      const vac = resolverNombre(String(row[10]||''), mapaAlias);
      if (vac && mapaAsig[vac]) return mapaAsig[vac].municipio;
      return String(row[23]||'').trim();
    }

    // ── Aplicar filtros ──────────────────────────────────────────────
    if (filtroVac)  filas = filas.filter(r => resolverNombre(String(r[10]||''),mapaAlias) === filtroVac.toUpperCase());
    if (filtroMun)  filas = filas.filter(r => getMunicipio(r).toUpperCase().includes(filtroMun.toUpperCase()));
    if (filtroMes)  filas = filas.filter(r => normalizarFecha(r[4]).startsWith(filtroMes));
    if (filtroAnio) filas = filas.filter(r => normalizarFecha(r[4]).startsWith(filtroAnio));
    if (filtroDesde)filas = filas.filter(r => normalizarFecha(r[4]) >= filtroDesde);
    if (filtroHasta)filas = filas.filter(r => normalizarFecha(r[4]) <= filtroHasta);

    // ── Extraer dimensiones únicas ───────────────────────────────────
    const vacSet = new Set(), bioSet = new Set(), munSet = new Set();
    filas.forEach(r => {
      const vac = resolverNombre(String(r[10]||''), mapaAlias);
      if (vac) vacSet.add(vac);
      const bio = String(r[16]||'').trim(); if (bio) bioSet.add(bio);
      const mun = getMunicipio(r); if (mun) munSet.add(mun);
    });
    const vacunadoras = [...vacSet].sort();
    const biologicos  = [...bioSet].sort();
    const municipios  = [...munSet].sort();

    // ── Períodos ─────────────────────────────────────────────────────
    const periodos = [...new Set(filas.map(r => getPeriodoKey(r[4], agrupacion)).filter(Boolean))].sort();

    const grupoOrden = ['2 meses','4 meses','6 meses','7 meses','1 año','18 meses',
                        '5 años','COVID 19','VPH','Influenza Adultos','Recién Nacido'];

    // ── Inicializar matrices ──────────────────────────────────────────
    const matVac = {}, matBio = {}, matGrupo = {}, matMun = {};
    vacunadoras.forEach(v => { matVac[v] = {}; periodos.forEach(p => matVac[v][p] = 0); });
    biologicos.forEach(b  => { matBio[b] = {}; periodos.forEach(p => matBio[b][p]  = 0); });
    grupoOrden.forEach(g  => { matGrupo[g]= {}; periodos.forEach(p => matGrupo[g][p]= 0); });
    municipios.forEach(m  => { matMun[m]  = {}; periodos.forEach(p => matMun[m][p]  = 0); });

    // ── Llenar matrices ───────────────────────────────────────────────
    filas.forEach(r => {
      const pk = getPeriodoKey(r[4], agrupacion);
      if (!pk) return;
      const vac = resolverNombre(String(r[10]||''), mapaAlias);
      const bio = String(r[16]||'').trim();
      const grp = String(r[19]||'').trim();
      const mun = getMunicipio(r);
      if (vac && matVac[vac])    matVac[vac][pk]    = (matVac[vac][pk]    ||0) + 1;
      if (bio && matBio[bio])    matBio[bio][pk]     = (matBio[bio][pk]    ||0) + 1;
      if (grp && matGrupo[grp])  matGrupo[grp][pk]  = (matGrupo[grp][pk]  ||0) + 1;
      if (mun && matMun[mun])    matMun[mun][pk]     = (matMun[mun][pk]    ||0) + 1;
    });

    // ── Serie diaria total ────────────────────────────────────────────
    const diasSet = new Set(filas.map(r => normalizarFecha(r[4])).filter(d=>d.length===10));
    const diasOrden = [...diasSet].sort();
    const seriesDia = diasOrden.map(d => ({
      dia: d,
      total: filas.filter(r => normalizarFecha(r[4]) === d).length
    }));

    return jsonResponse({
      ok: true,
      agrupacion, filtros:{vacunadora:filtroVac,municipio:filtroMun,año:filtroAnio,mes:filtroMes,desde:filtroDesde,hasta:filtroHasta},
      periodos, vacunadoras, biologicos, municipios,
      grupos: grupoOrden.filter(g => periodos.some(p => (matGrupo[g]||{})[p] > 0)),
      matVac, matBio, matGrupo, matMun,
      seriesDia, totalRegistros: filas.length,
    });
  } catch (err) {
    Logger.log('apiGetAnalytics error: ' + err.toString() + ' stack: ' + err.stack);
    return errorResponse('Error analytics: ' + err.message);
  }
}


// ─────────────────────────────────────────────
// ALIAS — GET / GUARDAR / BORRAR / NORMALIZAR
// ─────────────────────────────────────────────
function apiGetAlias(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const { hAlias } = asegurarHojas();
    const datos = hAlias.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok:true, alias:[] });
    const alias = datos.slice(1)
      .filter(r => r[0] && !String(r[0]).includes('EJEMPLO'))
      .map(r => ({ raw: String(r[0]).trim(), canonical: String(r[1]).trim(), fecha: String(r[2]||'') }));

    // También devolver lista de nombres únicos en REGISTROS_PAI para comparar
    const { hr } = asegurarHojas();
    const regDatos = hr.getDataRange().getValues();
    const nombresUnicos = [...new Set(
      regDatos.slice(1).filter(esRegistroReal).map(r => String(r[10]||'').trim().toUpperCase()).filter(Boolean)
    )].sort();

    return jsonResponse({ ok:true, alias, nombresUnicos });
  } catch (err) { return errorResponse(err.message); }
}

function limpiarHojaDatos(hoja) {
  // Borra el contenido de las filas de datos (desde fila 2) sin eliminar filas físicamente.
  // Esto evita el error "No se pueden eliminar todas las filas no inmovilizadas" de Google Sheets.
  const lastRow = hoja.getLastRow();
  if (lastRow > 1) {
    hoja.getRange(2, 1, lastRow - 1, hoja.getLastColumn() || 1).clearContent();
    // Intentar compactar eliminando filas vacías (solo si hay más de 1 fila de datos)
    try {
      if (lastRow > 2) hoja.deleteRows(2, lastRow - 2);
    } catch(e) {
      // Si falla el deleteRows (hoja con filas congeladas), quedarse con clearContent
      Logger.log('deleteRows omitido: ' + e.message);
    }
  }
}

function apiGuardarAlias(body) {
  try {
    const { alias } = body;
    if (!alias || !Array.isArray(alias)) return errorResponse('Falta alias[]');
    const { hAlias } = asegurarHojas();

    limpiarHojaDatos(hAlias);

    const filas = alias
      .filter(a => a.raw && a.canonical)
      .map(a => [
        a.raw.toString().trim().toUpperCase(),
        a.canonical.toString().trim().toUpperCase(),
        new Date().toISOString()
      ]);
    if (filas.length) hAlias.getRange(2, 1, filas.length, 3).setValues(filas);
    return jsonResponse({ ok:true, guardados: filas.length });
  } catch (err) { return errorResponse(err.message); }
}

function apiBorrarAlias(body) {
  try {
    const { raw } = body;
    if (!raw) return errorResponse('Falta raw');
    const { hAlias } = asegurarHojas();
    const datos = hAlias.getDataRange().getValues();
    for (let i = datos.length - 1; i >= 1; i--) {
      if (String(datos[i][0]).trim().toUpperCase() === raw.trim().toUpperCase()) {
        hAlias.deleteRow(i + 1);
        break;
      }
    }
    return jsonResponse({ ok:true });
  } catch (err) { return errorResponse(err.message); }
}

// Normaliza los nombres en REGISTROS_PAI aplicando el mapa de alias actual
function apiNormalizarNombres(body) {
  try {
    const { hr } = asegurarHojas();
    const mapaAlias = cargarMapaAlias();
    if (Object.keys(mapaAlias).length === 0) return errorResponse('No hay alias definidos');

    const datos = hr.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok:true, actualizados:0 });

    let actualizados = 0;
    // Columna K = índice 10 (vacunadora)
    for (let i = 1; i < datos.length; i++) {
      if (!esRegistroReal(datos[i])) continue; // saltar fila ejemplo
      const raw       = String(datos[i][10] || '').trim().toUpperCase();
      const canonical = mapaAlias[raw];
      if (canonical && canonical !== raw) {
        hr.getRange(i + 1, 11).setValue(canonical);
        actualizados++;
        if (actualizados % 100 === 0) SpreadsheetApp.flush();
      }
    }
    SpreadsheetApp.flush();
    return jsonResponse({ ok:true, actualizados });
  } catch (err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// VALORES BIOLÓGICOS — GET / GUARDAR
// ─────────────────────────────────────────────
function apiGetValores(e) {
  try {
    const { hVal } = asegurarHojas();
    const datos = hVal.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok:true, valores:[] });
    const valores = datos.slice(1)
      .filter(r => r[0])
      .map(r => ({
        ciclo:  String(r[0]).trim(),
        label:  String(r[1]).trim(),
        meta:   parseInt(r[2]) || 11,
        valor:  parseInt(r[3]) || 8000,
      }));
    return jsonResponse({ ok:true, valores });
  } catch (err) { return errorResponse(err.message); }
}

function apiGuardarValores(body) {
  try {
    const { valores } = body;
    if (!valores || !Array.isArray(valores)) return errorResponse('Falta valores[]');
    const { hVal } = asegurarHojas();

    limpiarHojaDatos(hVal);

    if (valores.length > 0) {
      const filas = valores.map(v => [
        String(v.ciclo).trim(),
        String(v.label).trim(),
        parseInt(v.meta) || 11,
        parseInt(v.valor) || 8000,
      ]);
      hVal.getRange(2, 1, filas.length, 4).setValues(filas);
    }
    return jsonResponse({ ok:true, guardados: valores.length });
  } catch (err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// ASIGNACIONES VACUNADORA → MUNICIPIO
// ─────────────────────────────────────────────
function cargarMapaAsignaciones() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hAsig = ss.getSheetByName(CONFIG.HOJA_ASIGNACIONES);
  if (!hAsig || hAsig.getLastRow() <= 1) return {};
  const datos = hAsig.getDataRange().getValues().slice(1);
  const mapa = {};
  datos.forEach(row => {
    const vac = String(row[0]||'').trim().toUpperCase();
    const mun = String(row[1]||'').trim();
    if (vac && mun) mapa[vac] = { municipio: mun, departamento: String(row[2]||'').trim() };
  });
  return mapa;
}

function apiGetAsignaciones(e) {
  try {
    const { hAsig } = asegurarHojas();
    const datos = hAsig.getDataRange().getValues();
    if (datos.length <= 1) return jsonResponse({ ok:true, asignaciones:[] });
    const asig = datos.slice(1).filter(r=>r[0]).map(r=>({
      vacunadora: String(r[0]).trim(),
      municipio:  String(r[1]).trim(),
      departamento: String(r[2]).trim(),
      notas: String(r[3]||'').trim(),
    }));
    // También devolver vacunadoras únicas en REGISTROS_PAI
    const { hr } = asegurarHojas();
    const regDatos = hr.getDataRange().getValues();
    const mapaAlias = cargarMapaAlias();
    const vacsUnicas = [...new Set(
      regDatos.slice(1).filter(esRegistroReal)
        .map(r => resolverNombre(String(r[10]||''), mapaAlias))
        .filter(Boolean)
    )].sort();
    return jsonResponse({ ok:true, asignaciones:asig, vacsUnicas });
  } catch(err) { return errorResponse(err.message); }
}

function apiGuardarAsignaciones(body) {
  try {
    const { asignaciones } = body;
    if (!asignaciones || !Array.isArray(asignaciones)) return errorResponse('Falta asignaciones[]');
    const { hAsig } = asegurarHojas();

    limpiarHojaDatos(hAsig);

    const filas = asignaciones.filter(a=>a.vacunadora&&a.municipio).map(a=>[
      a.vacunadora.trim().toUpperCase(),
      a.municipio.trim(),
      (a.departamento||'').trim(),
      (a.notas||'').trim(),
    ]);
    if (filas.length) hAsig.getRange(2,1,filas.length,4).setValues(filas);
    return jsonResponse({ ok:true, guardados: filas.length });
  } catch(err) { return errorResponse(err.message); }
}

// ─────────────────────────────────────────────
// TRAZADORES PAI — indicadores por cohorte de edad
// ─────────────────────────────────────────────
const TRAZADORES_DEF = [
  { id:'RN-BCG',       cohorte:'Recién Nacidos',    label:'BCG (Tuberculosis meníngea)',       emoji:'👶', color:'#1B4FD8',
    proposito:'Indicador de captación institucional temprana. Mide si el RN fue vacunado antes del egreso hospitalario.', ciclos:['RN-BCG'] },
  { id:'MENOR1-PENTA3',cohorte:'Menores de 1 año',  label:'Pentavalente 3ª dosis (6 meses)',   emoji:'🍼', color:'#00B4A0',
    proposito:'Indica que el infante completó su esquema básico primario sin abandonar el PAI.', ciclos:['6M-Penta'] },
  { id:'MENOR1-POLIO3',cohorte:'Menores de 1 año',  label:'Polio Inyectable 3ª dosis (6 meses)',emoji:'🍼',color:'#0891B2',
    proposito:'Confirma cierre del esquema primario de polio junto con Pentavalente.', ciclos:['6M-Polio'] },
  { id:'1A-SRP',       cohorte:'Niños de 1 año',    label:'Triple Viral SRP 1ª dosis (12 m)',  emoji:'🧒', color:'#7C3AED',
    proposito:'Indicador más vigilado nacional e internacionalmente. Inicio de protección contra Sarampión, Rubéola y Paperas.', ciclos:['1A-TripleViral'] },
  { id:'5A-DPT',       cohorte:'Niños de 5 años',   label:'DPT 2° refuerzo (5 años)',          emoji:'👦', color:'#F59E0B',
    proposito:'Cierre del esquema de primera infancia. La 2ª SRP se adelantó a 18 m por actualización PAI vigente.', ciclos:['5A-DPT'] },
  { id:'5A-POLIO',     cohorte:'Niños de 5 años',   label:'Polio 2° refuerzo (5 años)',        emoji:'👦', color:'#EA580C',
    proposito:'Junto con DPT, mide el cierre efectivo del esquema antes del ingreso escolar.', ciclos:['5A-PolioOral','5A-PolioInyec'] },
];

function apiGetTrazadores(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const agrupacion  = p.agrupacion  || 'mes';
    const filtroMun   = p.municipio   || '';
    const filtroMes   = p.mes         || '';
    const filtroAnio  = p.año         || '';
    const filtroDesde = p.desde       || '';
    const filtroHasta = p.hasta       || '';

    const { hr } = asegurarHojas();
    const mapaAsig = cargarMapaAsignaciones();
    const mapaAlias = cargarMapaAlias();
    const datos = hr.getDataRange().getValues();

    // Helper municipio (igual que en analytics: asignación manual > col X)
    function getMun(row){
      const vac = resolverNombre(String(row[10]||''), mapaAlias);
      if(vac && mapaAsig[vac]) return mapaAsig[vac].municipio;
      return String(row[23]||'').trim();
    }

    if (datos.length <= 1) {
      return jsonResponse({ ok:true,
        trazadores: TRAZADORES_DEF.map(t=>({...t, total:0, porPeriodo:{}})),
        periodos:[], todosLosPeriodos:[], municipios:[], agrupacion });
    }

    const todasFilas = datos.slice(1).filter(esRegistroReal);

    // Municipios únicos (para poblar el selector, sin filtrar)
    const municipios = [...new Set(todasFilas.map(r=>getMun(r)).filter(Boolean))].sort();
    // Todos los períodos disponibles (para poblar selector de mes/año sin filtrar)
    const todosLosPeriodos = [...new Set(
      todasFilas.map(r=>{ const f=normalizarFecha(r[4]); return f.length>=7?f.substring(0,7):''; }).filter(Boolean)
    )].sort().reverse();

    // Aplicar filtros al conjunto de datos
    let filas = todasFilas;
    if (filtroMun)   filas = filas.filter(r => getMun(r).toUpperCase().includes(filtroMun.toUpperCase()));
    if (filtroMes)   filas = filas.filter(r => normalizarFecha(r[4]).startsWith(filtroMes));
    if (filtroAnio)  filas = filas.filter(r => normalizarFecha(r[4]).startsWith(filtroAnio));
    if (filtroDesde) filas = filas.filter(r => normalizarFecha(r[4]) >= filtroDesde);
    if (filtroHasta) filas = filas.filter(r => normalizarFecha(r[4]) <= filtroHasta);

    const periodos = [...new Set(filas.map(r => getPeriodoKey(r[4], agrupacion)).filter(Boolean))].sort();

    const resultado = TRAZADORES_DEF.map(traz => {
      const ciclosSet = new Set(traz.ciclos);
      const porPeriodo = {};
      periodos.forEach(p => porPeriodo[p] = 0);
      filas.forEach(r => {
        if (!ciclosSet.has(String(r[18]||'').trim())) return;
        const pk = getPeriodoKey(r[4], agrupacion);
        if (pk) porPeriodo[pk] = (porPeriodo[pk]||0) + 1;
      });
      return { id:traz.id, cohorte:traz.cohorte, label:traz.label,
               emoji:traz.emoji, color:traz.color, proposito:traz.proposito,
               total: Object.values(porPeriodo).reduce((s,v)=>s+v,0), porPeriodo };
    });

    return jsonResponse({ ok:true, trazadores:resultado, periodos,
      todosLosPeriodos, municipios, agrupacion,
      filtros:{ municipio:filtroMun, mes:filtroMes, año:filtroAnio } });
  } catch(err) {
    Logger.log('apiGetTrazadores: ' + err.toString());
    return errorResponse('Error trazadores: ' + err.message);
  }
}

function apiBorrarArchivo(body) {
  try {
    const { id_archivo, nombre_archivo } = body;
    if (!id_archivo && !nombre_archivo) return errorResponse('Falta id_archivo o nombre_archivo');
    const { hr, ha } = asegurarHojas();
    const datosA = ha.getDataRange().getValues();
    for (let i = datosA.length-1; i>=1; i--) {
      if ((id_archivo && datosA[i][0]===id_archivo)||(nombre_archivo && datosA[i][1]===nombre_archivo)) {
        ha.deleteRow(i+1); break;
      }
    }
    const datosR = hr.getDataRange().getValues();
    let borrados = 0;
    for (let i = datosR.length-1; i>=1; i--) {
      if ((id_archivo && datosR[i][2]===id_archivo)||(nombre_archivo && datosR[i][3]===nombre_archivo)) {
        hr.deleteRow(i+1); borrados++;
      }
    }
    return jsonResponse({ ok:true, registrosBorrados: borrados });
  } catch (err) { return errorResponse(err.message); }
}

function apiBorrarTodo(body) {
  try {
    if (body.confirmacion !== 'BORRAR_TODO') return errorResponse('Confirmación inválida');
    const { hr, ha } = asegurarHojas();
    limpiarHojaDatos(hr);
    limpiarHojaDatos(ha);
    return jsonResponse({ ok:true, mensaje: 'Todos los datos eliminados' });
  } catch (err) { return errorResponse(err.message); }
}

function generarUUID() { return Utilities.getUuid(); }

// ─────────────────────────────────────────────
// MENÚ
// ─────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏥 CertiVac')
    .addItem('🔧 Inicializar / Verificar Hojas', 'setupInicial')
    .addItem('🌐 Abrir Aplicativo Web', 'abrirWebApp')
    .addItem('📋 Ver URL del API', 'mostrarURLApi')
    .addSeparator()
    .addItem('⚠️ Borrar todos los datos', 'borrarTodoDesdeMenu')
    .addToUi();
}

function setupInicial() {
  asegurarHojas();
  SpreadsheetApp.getUi().alert('✅ CertiVac v5.2 inicializado',
    'Hojas creadas/verificadas:\n• REGISTROS_PAI\n• ARCHIVOS_CARGADOS\n• PARAMETROS\n• ALIAS_VACUNADORAS\n• VALORES_BIOLOGICOS\n• ASIGNACIONES_MUNICIPIO\n\n' +
    '⚠️ Si ya tiene datos cargados con fechas incorrectas (solo el número del día sin año/mes),\n' +
    'elimínelos desde Historial y vuelva a cargarlos — ahora el ETL reconstruye la fecha completa.\n\n' +
    'Publique el script como aplicación web y pegue la URL en ⚙️ Configuración.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function abrirWebApp() {
  const url = ScriptApp.getService().getUrl();
  const ui = SpreadsheetApp.getUi();
  ui.alert('🌐 URL', url || '(no publicado)', ui.ButtonSet.OK);
}

function mostrarURLApi() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert('📡 Endpoints API v5.2',
    (url||'(no publicado)') + '\n\n' +
    'GET: ?accion=ping|registros|archivos|liquidacion|analytics|periodos|alias|valores|asignaciones\n' +
    'POST payload: guardar_lote|borrar_archivo|borrar_todo|guardar_alias|borrar_alias|normalizar_nombres|guardar_valores|guardar_asignaciones',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function borrarTodoDesdeMenu() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('⚠️','¿Eliminar TODOS los datos?',ui.ButtonSet.YES_NO) === ui.Button.YES) {
    apiBorrarTodo({ confirmacion: 'BORRAR_TODO' });
    ui.alert('✅','Datos eliminados.',ui.ButtonSet.OK);
  }
}
