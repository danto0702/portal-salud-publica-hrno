/**
 * ════════════════════════════════════════════════════════════════════════
 *  BACKEND — SEGUIMIENTO DE RECURSOS DE TRANSFERENCIAS (SER124DREC)
 *  ESE Hospital Regional Noroccidental · PISIS / SISPRO
 * ────────────────────────────────────────────────────────────────────────
 *  Google Sheets es la FUENTE DE VERDAD de los registros. El aplicativo:
 *    - push : guarda/actualiza registros por 'uid' (borradores y cargados).
 *    - pull : descarga todos los registros para trabajar desde varios equipos.
 *  Cada registro lleva estado BORRADOR o CARGADO. Los CARGADOS quedan
 *  bloqueados en el aplicativo y no se vuelven a incluir en el archivo plano.
 * ────────────────────────────────────────────────────────────────────────
 *  Instalación:
 *   1. Abre la hoja de respaldo en Google Sheets.
 *   2. Extensiones → Apps Script. Borra todo y pega ESTE código. Guarda.
 *   3. (Opcional) cambia TOKEN por una clave secreta (misma en el app).
 *   4. Implementar → Nueva implementación → Aplicación web:
 *        - Ejecutar como:      Yo
 *        - Quién tiene acceso:  Cualquier usuario
 *   5. Autoriza permisos, copia la URL /exec y pégala en Ajustes del app.
 *  IMPORTANTE: si ya tenías una versión anterior desplegada, usa
 *  "Implementar → Gestionar implementaciones → Editar → Nueva versión".
 * ════════════════════════════════════════════════════════════════════════
 */

const TOKEN = '';  // '' = sin token

// Orden de campos por tipo (coincide con el aplicativo y la plantilla Excel)
const CAMPOS = {
  2: ['idRecurso','nit','indicador','tipoActo','numActo','fecha','valor'],
  3: ['idRecurso','nit','indicador','tipoActo','numActo','fecha','fechaFin','objeto','valor','tipoIdContratista','numIdContratista','nomContratista','tipoIdSuperv','numIdSuperv','nomSuperv'],
  4: ['idRecurso','nit','indicador','tipoActo','numActo','numPoliza','fecha'],
  5: ['idRecurso','nit','indicador','tipoActo','numActo','tipoActa','noActa','fecha','valorObligado','valorPagado','pctTecnica','conclusiones'],
  6: ['idRecurso','nit','indicador','tipoActo','numActo','fecha','codEntidad','nitBanco','numCuenta','valor','fechaConsig','portafolio'],
  7: ['idRecurso','nit','indicador','tipoActo','numActo','fecha','codEntidad','nitBanco','numCuenta','valor','fechaConsig','portafolio']
};
const HOJA = { 2:'INCORPORACION', 3:'CONTRATOS', 4:'POLIZAS', 5:'SEGUIMIENTO', 6:'REINT_RECURSOS', 7:'REINT_RENDIM' };
const CTRL = ['uid','estado','periodo','updatedAt'];           // columnas de control (antes de los campos)
const H_ENVIOS = ['FechaHora','NombreArchivo','Periodo','TipoIdEntidad','NumIdEntidad','IDRecurso','NITBeneficiaria','FechaIni','FechaFin','TotalCargados'];
// Clave del anexo por tipo (para detectar duplicados). Debe coincidir con SCHEMA[t].key del aplicativo.
const KEY = {
  2: ['idRecurso','nit','tipoActo','numActo','fecha'],
  3: ['idRecurso','nit','tipoActo','numActo'],
  4: ['idRecurso','nit','tipoActo','numActo','numPoliza'],
  5: ['idRecurso','nit','tipoActo','numActo','tipoActa','noActa','fecha'],
  6: ['idRecurso','nit','tipoActo','numActo','fecha'],
  7: ['idRecurso','nit','tipoActo','numActo','fecha']
};

function doGet(e)  { return json({ ok:true, msg:'API SER124DREC activa', metodo:'GET' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (TOKEN && body.token !== TOKEN) return json({ ok:false, error:'Token invalido' });
    switch (body.action) {
      case 'ping':          return json({ ok:true, msg:'pong', version:'2.1' });
      case 'push':          return pushRegistros(body);
      case 'pull':          return pullRegistros(body);
      case 'dedup':         return dedupHoja(body);
      case 'guardarEnvio':  return guardarEnvio(body);
      default:              return json({ ok:false, error:'Accion no reconocida: ' + body.action });
    }
  } catch (err) {
    return json({ ok:false, error:String(err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// Cabecera completa de la hoja de un tipo
function headersDe(t){ return CTRL.concat(CAMPOS[t]); }

// Inserta/actualiza registros por uid en su hoja de tipo
function pushRegistros(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const registros = body.registros || [];
  const ahora = new Date().toISOString();
  const porTipo = {};
  registros.forEach(function(r){ var t = parseInt(r.tipo,10); if (CAMPOS[t]) (porTipo[t] = porTipo[t] || []).push(r); });

  var total = 0;
  Object.keys(porTipo).forEach(function(t){
    const headers = headersDe(t);
    const sh = getSheet(ss, HOJA[t], headers);
    const last = sh.getLastRow();
    // mapa uid -> fila
    const uidCol = last > 1 ? sh.getRange(2,1,last-1,1).getValues().map(function(x){return String(x[0]);}) : [];
    const idx = {}; uidCol.forEach(function(u,i){ idx[u] = i + 2; });
    const nuevas = [];
    porTipo[t].forEach(function(r){
      const uid = String(r.uid || '');
      const fila = fila_de(t, r, ahora);
      if (uid && idx[uid]) {
        sh.getRange(idx[uid], 1, 1, headers.length).setValues([fila]);
      } else {
        nuevas.push(fila);
      }
      total++;
    });
    if (nuevas.length) sh.getRange(sh.getLastRow()+1, 1, nuevas.length, headers.length).setValues(nuevas);
  });
  return json({ ok:true, filas: total });
}

function fila_de(t, r, ahora){
  const ctrl = [ r.uid || '', (r.estado === 'CARGADO' ? 'CARGADO' : 'BORRADOR'), r.periodo || '', r.updatedAt || ahora ];
  return ctrl.concat(CAMPOS[t].map(function(k){ return r[k] != null ? r[k] : ''; }));
}

// Devuelve todos los registros de todas las hojas de tipo
function pullRegistros(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = [];
  Object.keys(HOJA).forEach(function(t){
    const sh = ss.getSheetByName(HOJA[t]); if (!sh) return;
    const last = sh.getLastRow(); if (last < 2) return;
    const headers = headersDe(t);
    const vals = sh.getRange(2, 1, last-1, headers.length).getValues();
    vals.forEach(function(row){
      if (!String(row[0]).trim()) return;                 // sin uid -> ignora
      const rec = { tipo: parseInt(t,10) };
      headers.forEach(function(h, i){ rec[h] = row[i]; });
      out.push(rec);
    });
  });
  return json({ ok:true, registros: out });
}

// Elimina filas duplicadas en cada hoja de tipo (misma clave del anexo + periodo + tipo de accion),
// conservando una fila por grupo: prefiere estado CARGADO y, si no, la de updatedAt mas reciente.
function dedupHoja(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  var removed = 0, porTipo = {};
  Object.keys(HOJA).forEach(function(t){
    const sh = ss.getSheetByName(HOJA[t]); if (!sh) return;
    const last = sh.getLastRow(); if (last < 3) return;   // encabezado + <2 filas: nada que deduplicar
    const headers = headersDe(t);
    const width = headers.length;
    const col = {}; headers.forEach(function(h,i){ col[h] = i; });
    const vals = sh.getRange(2, 1, last-1, width).getValues();
    const keyFields = KEY[t] || ['idRecurso','nit'];
    const seen = {}, keep = [];
    vals.forEach(function(row){
      if (!String(row[0]).trim()) return;   // sin uid: se descarta
      const periodo = row[col['periodo']];
      const indicador = row[col['indicador']];
      const kparts = keyFields.map(function(f){ return String(row[col[f]] != null ? row[col[f]] : '').toUpperCase(); });
      const key = t + '|' + kparts.join('~') + '|' + (periodo||'') + '|' + (indicador === 'E' ? 'E' : 'X');
      if (seen[key] === undefined) { seen[key] = keep.length; keep.push(row); }
      else {
        const idx = seen[key], cur = keep[idx];
        const rowCargado = String(row[col['estado']]) === 'CARGADO';
        const curCargado = String(cur[col['estado']]) === 'CARGADO';
        const rowUpd = String(row[col['updatedAt']] || ''), curUpd = String(cur[col['updatedAt']] || '');
        const win = (rowCargado && !curCargado) ? row : (!rowCargado && curCargado) ? cur : (rowUpd >= curUpd ? row : cur);
        keep[idx] = win; removed++;
      }
    });
    if (keep.length < vals.length) {
      sh.getRange(2, 1, vals.length, width).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep);
      porTipo[HOJA[t]] = vals.length - keep.length;
    }
  });
  return json({ ok:true, removed: removed, detalle: porTipo });
}

// Bitácora de cargas confirmadas
function guardarEnvio(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ent = body.entidad || {};
  const sh = getSheet(ss, 'ENVIOS', H_ENVIOS);
  sh.appendRow([ new Date(), body.archivo || '', body.periodo || '', ent.tipoId || '', ent.numId || '',
                 ent.idRecurso || '', ent.nitBenef || '', ent.fechaIni || '', ent.fechaFin || '', body.total || 0 ]);
  return json({ ok:true });
}

function getSheet(ss, nombre, headers) {
  let sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
