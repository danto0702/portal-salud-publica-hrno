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
const CTRL = ['uid','rid','estado','periodo','updatedAt'];      // columnas de control (antes de los campos); 'rid' = id de la resolución
const H_ENVIOS = ['FechaHora','NombreArchivo','Periodo','TipoIdEntidad','NumIdEntidad','IDRecurso','NITBeneficiaria','FechaIni','FechaFin','TotalCargados'];
const RES_HEADERS = ['id','nombre','vigencia','creada','updatedAt'];   // hoja RESOLUCIONES (registro de resoluciones de todos los equipos)
// Clave del anexo por tipo (para detectar duplicados). Debe coincidir con SCHEMA[t].key del aplicativo.
const KEY = {
  2: ['idRecurso','nit','tipoActo','numActo','fecha'],
  3: ['idRecurso','nit','tipoActo','numActo'],
  4: ['idRecurso','nit','tipoActo','numActo','numPoliza'],
  5: ['idRecurso','nit','tipoActo','numActo','tipoActa','noActa','fecha'],
  6: ['idRecurso','nit','tipoActo','numActo','fecha'],
  7: ['idRecurso','nit','tipoActo','numActo','fecha']
};
// ¿el período forma parte de la identidad? No para incorporación/contratos/pólizas; sí para seguimiento/reintegros
const PERKEY = { 2:false, 3:false, 4:false, 5:true, 6:true, 7:true };

function doGet(e)  { return json({ ok:true, msg:'API SER124DREC activa', metodo:'GET' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (TOKEN && body.token !== TOKEN) return json({ ok:false, error:'Token invalido' });
    switch (body.action) {
      case 'ping':          return json({ ok:true, msg:'pong', version:'2.5' });
      case 'push':          return pushRegistros(body);
      case 'pull':          return pullRegistros(body);
      case 'dedup':         return dedupHoja(body);
      case 'borrarUids':    return borrarUids(body);
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

// Normalizacion para deduplicar (igual que el aplicativo): sin guiones/espacios, periodo a fin de mes
function keyNormG(v){ return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function fechaTxtG(v){
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(String(v == null ? '' : v));
  return m ? (m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2)) : String(v == null ? '' : v);
}
function monthEndG(v){
  var s = fechaTxtG(v), m = /^(\d{4})-(\d{2})/.exec(s);
  if (!m) return s;
  var d = new Date(parseInt(m[1],10), parseInt(m[2],10), 0).getDate();
  return m[1] + '-' + m[2] + '-' + ('0' + d).slice(-2);
}

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
  // Registro de resoluciones (para que todas las resoluciones de un equipo aparezcan en los demás)
  if (body.resoluciones) pushResoluciones(ss, body.resoluciones);
  return json({ ok:true, filas: total });
}

function fila_de(t, r, ahora){
  const ctrl = [ r.uid || '', r.rid || '', (r.estado === 'CARGADO' ? 'CARGADO' : 'BORRADOR'), r.periodo || '', r.updatedAt || ahora ];
  return ctrl.concat(CAMPOS[t].map(function(k){ return r[k] != null ? r[k] : ''; }));
}

// Inserta/actualiza el registro de resoluciones por 'id'
function pushResoluciones(ss, arr){
  if (!arr || !arr.length) return;
  const sh = getSheet(ss, 'RESOLUCIONES', RES_HEADERS);
  const last = sh.getLastRow();
  const idCol = last > 1 ? sh.getRange(2,1,last-1,1).getValues().map(function(x){return String(x[0]);}) : [];
  const idx = {}; idCol.forEach(function(u,i){ idx[u] = i + 2; });
  const ahora = new Date().toISOString();
  const nuevas = [];
  arr.forEach(function(r){
    const id = String(r.id || ''); if (!id) return;
    const fila = [ id, r.nombre || '', r.vigencia || '', r.creada || '', r.updatedAt || ahora ];
    if (idx[id]) sh.getRange(idx[id], 1, 1, RES_HEADERS.length).setValues([fila]);
    else nuevas.push(fila);
  });
  if (nuevas.length) sh.getRange(sh.getLastRow()+1, 1, nuevas.length, RES_HEADERS.length).setValues(nuevas);
}

// Devuelve el registro de resoluciones
function pullResoluciones(ss){
  const sh = ss.getSheetByName('RESOLUCIONES'); if (!sh) return [];
  const last = sh.getLastRow(); if (last < 2) return [];
  const vals = sh.getRange(2, 1, last-1, RES_HEADERS.length).getValues();
  const out = [];
  vals.forEach(function(row){
    if (!String(row[0]).trim()) return;
    out.push({ id:String(row[0]), nombre:String(row[1]), vigencia:String(row[2]), creada:String(row[3]), updatedAt:String(row[4]) });
  });
  return out;
}

// Devuelve todos los registros de todas las hojas de tipo (leyendo por nombre de columna, robusto ante migraciones)
function pullRegistros(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = [];
  Object.keys(HOJA).forEach(function(t){
    const sh = ss.getSheetByName(HOJA[t]); if (!sh) return;
    ensureHeaders(sh, headersDe(t));                      // añade la columna 'rid' si venía de una versión anterior
    const last = sh.getLastRow(); if (last < 2) return;
    const lastCol = sh.getLastColumn();
    const hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(x){ return String(x); });
    const uidIdx = hdr.indexOf('uid');
    const vals = sh.getRange(2, 1, last-1, lastCol).getValues();
    vals.forEach(function(row){
      if (uidIdx < 0 || !String(row[uidIdx]).trim()) return;   // sin uid -> ignora
      const rec = { tipo: parseInt(t,10) };
      hdr.forEach(function(h, i){ if (h) rec[h] = row[i]; });
      out.push(rec);
    });
  });
  return json({ ok:true, registros: out, resoluciones: pullResoluciones(ss) });
}

// Elimina filas duplicadas en cada hoja de tipo (misma clave del anexo + periodo + tipo de accion),
// conservando una fila por grupo: prefiere estado CARGADO y, si no, la de updatedAt mas reciente.
function dedupHoja(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  var removed = 0, porTipo = {};
  Object.keys(HOJA).forEach(function(t){
    const sh = ss.getSheetByName(HOJA[t]); if (!sh) return;
    ensureHeaders(sh, headersDe(t));                       // asegura la columna 'rid'
    const last = sh.getLastRow(); if (last < 3) return;   // encabezado + <2 filas: nada que deduplicar
    const headers = headersDe(t);
    const width = headers.length;
    const col = {}; headers.forEach(function(h,i){ col[h] = i; });
    const vals = sh.getRange(2, 1, last-1, width).getValues();
    const keyFields = KEY[t] || ['idRecurso','nit'];
    const seen = {}, keep = [];
    vals.forEach(function(row){
      if (!String(row[0]).trim()) return;   // sin uid: se descarta
      const periodo = PERKEY[t] ? monthEndG(row[col['periodo']]) : '';
      const indicador = String(row[col['indicador']]);
      const rid = keyNormG(row[col['rid']]);              // la resolución forma parte de la identidad
      const kparts = keyFields.map(function(f){ return keyNormG(row[col[f]]); });
      const key = t + '|' + rid + '|' + kparts.join('~') + '|' + periodo + '|' + (indicador === 'E' ? 'E' : 'X');
      if (seen[key] === undefined) { seen[key] = keep.length; keep.push(row); }
      else {
        const idx = seen[key], cur = keep[idx];
        const rc = String(row[col['estado']]) === 'CARGADO', cc = String(cur[col['estado']]) === 'CARGADO';
        var win;
        if (rc && !cc) win = row;
        else if (!rc && cc) win = cur;
        else {
          var rp = monthEndG(row[col['periodo']]), cp = monthEndG(cur[col['periodo']]);
          if (rp !== cp) win = rp > cp ? row : cur;
          else win = String(row[col['updatedAt']] || '') >= String(cur[col['updatedAt']] || '') ? row : cur;
        }
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

// Elimina de todas las hojas de tipo las filas cuyo uid esté en la lista (borrado sincronizado)
function borrarUids(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const set = {}; (body.uids || []).forEach(function(u){ set[String(u)] = true; });
  var removed = 0;
  Object.keys(HOJA).forEach(function(t){
    const sh = ss.getSheetByName(HOJA[t]); if (!sh) return;
    ensureHeaders(sh, headersDe(t));                       // asegura la columna 'rid'
    const last = sh.getLastRow(); if (last < 2) return;
    const width = headersDe(t).length;
    const vals = sh.getRange(2, 1, last-1, width).getValues();
    const keep = vals.filter(function(row){ if (set[String(row[0])]) { removed++; return false; } return true; });
    if (keep.length < vals.length) {
      sh.getRange(2, 1, vals.length, width).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep);
    }
  });
  return json({ ok:true, removed: removed });
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
  if (!sh) sh = ss.insertSheet(nombre);
  ensureHeaders(sh, headers);
  return sh;
}

// Asegura que la fila de encabezados sea 'headers'. Si la hoja venía de una versión
// anterior (columna 'uid' sin 'rid'), inserta la columna 'rid' tras 'uid' SIN perder datos:
// insertColumnAfter corre las columnas existentes a la derecha, conservando la alineación.
function ensureHeaders(sh, headers) {
  const lastCol = sh.getLastColumn();
  const cur = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(x){ return String(x); }) : [];
  if (cur.length && cur[0] === 'uid' && cur.indexOf('rid') === -1 && headers.indexOf('rid') === 1) {
    sh.insertColumnAfter(1);                 // nueva columna en blanco en la posición 2 (los datos se corren a la derecha)
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
