/**
 * AGENTE DE CORREO · Seguimiento Oficina de Salud Pública · ESE HRNO
 * ------------------------------------------------------------------
 * Corre dentro de la cuenta saludpublica@esehrno.gov.co (Google Apps Script).
 * Cada mañana (lunes a viernes) lee los correos nuevos y, por reglas:
 *   - radica los oficios / derechos de petición en el Radicador (Google Sheets),
 *   - crea reuniones en la agenda y tareas en el dashboard (Supabase),
 *   - deja constancia de cada correo revisado en "Registros del correo".
 * Solo registra: no responde, no reenvía ni borra correos. Únicamente agrega
 * la etiqueta "Seguimiento/Procesado" para que se vea qué revisó.
 *
 * INSTALACIÓN (una sola vez):
 *  1. Entre a script.google.com con saludpublica@esehrno.gov.co → Nuevo proyecto.
 *  2. Pegue este código completo y guarde (nombre: "Agente Seguimiento Oficina").
 *  3. Configuración del proyecto (engranaje) → Propiedades de la secuencia de comandos →
 *     Agregar propiedad:  AGENTE_TOKEN  =  (la clave que le entregó el coordinador).
 *  4. Seleccione la función  probarConexion  → Ejecutar → autorice los permisos.
 *  5. Seleccione la función  instalar  → Ejecutar. Queda programado a las 7 a. m.
 *  Para correrlo a mano en cualquier momento: función  ejecutarAhora .
 */

var CONFIG = {
  SUPA_URL: 'https://wttljozqyaxlzilomnef.supabase.co',
  SUPA_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0dGxqb3pxeWF4bHppbG9tbmVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDg5NTEsImV4cCI6MjA5NDg4NDk1MX0.kAQkgGq7RmZxTM9KlwI6KI7BjhEBy-8w6OdHVkOPBDM',
  RADICADOR_URL: 'https://script.google.com/macros/s/AKfycbxmK-803QUbEO0Xy5BPEdj2OSFqK6pv_IcgYmE_qnc-fEjv548tI9aJvqZE1-WmATM/exec',
  DIAS_ATRAS: 4,                       // ventana de búsqueda (cubre fines de semana y festivos)
  ETIQUETA_RADICAR: 'Radicar',         // si usted etiqueta un correo así, se radica sí o sí
  ETIQUETA_PROCESADO: 'Seguimiento/Procesado',
  HORA: 7,
  ZONA: 'America/Bogota'
};

/* ============================ REGLAS ============================ */

// Remitentes oficiales o de control (dominio o nombre visible)
var REMITENTES_OFICIALES = [
  /\.gov\.co\b/i, /\.gob\.co\b/i, /ramajudicial/i, /supersalud/i, /minsalud/i, /\bins\.gov/i,
  /secretar[ií]a/i, /instituto departamental de salud/i, /\bids\b/i, /alcald[ií]a/i, /personer[ií]a/i,
  /procuradur[ií]a/i, /contralor[ií]a/i, /defensor[ií]a/i, /fiscal[ií]a/i, /juzgado/i, /\beps\b/i,
  /nueva eps/i, /sanitas/i, /coosalud/i, /asmet/i, /famisanar/i, /salud total/i, /mutual ser/i
];
// Palabras que convierten un correo en un oficio por radicar
var PALABRAS_OFICIO = /(derecho\s+de\s+petici[oó]n|\boficio\b|\bradicad[oa]\b|requerimiento|solicitud\s+de\s+informaci[oó]n|\bcircular\b|\btutela\b|\bresoluci[oó]n\b|\bmemorando\b)/i;
// Señales de citación a reunión
var PALABRAS_REUNION = /(citaci[oó]n|convocatoria|invitaci[oó]n|\breuni[oó]n\b|mesa\s+t[eé]cnica|\bcomit[eé]\b|asistencia\s+t[eé]cnica|capacitaci[oó]n|\btaller\b|videoconferencia|meet\.google\.com|teams\.microsoft\.com|zoom\.us)/i;
// Señales de que piden un entregable
var PALABRAS_TAREA = /(solicit[oa]mos|se\s+solicita|le\s+solicito|favor\s+(enviar|remitir|allegar)|remitir|allegar|a\s+m[aá]s\s+tardar|plazo|fecha\s+l[ií]mite|informe|reporte|consolidado|base\s+de\s+datos|sivigila|pisis|siaps|winsisvan|soportes)/i;
// Correos automáticos que nunca se registran
var REMITENTES_IGNORADOS = /(no-?reply|noreply|mailer-daemon|notifications?@|newsletter|marketing|facebook|linkedin|google\.com$|accounts\.google)/i;

var PROGRAMAS = [
  ['PAI', /(\bpai\b|vacun|inmuniza|biol[oó]gico|cadena\s+de\s+fr[ií]o)/i],
  ['EBS', /(\bebs\b|equipos?\s+b[aá]sicos)/i],
  ['PIC', /(\bpic\b|intervenciones\s+colectivas)/i],
  ['Jóvenes en Paz', /(j[oó]venes\s+en\s+paz|\bjep\b)/i],
  ['Misión Médica', /(misi[oó]n\s+m[eé]dica|\bdih\b|derecho\s+internacional\s+humanitario)/i],
  ['SIVIGILA', /(sivigila|vigilancia\s+epidemiol|notificaci[oó]n\s+de\s+eventos|\beisp\b|silencio\s+epidemiol)/i],
  ['Salud Mental', /(salud\s+mental|suicid|\bsrq\b|consumo\s+de\s+sustancias)/i],
  ['Nutrición', /(nutrici|winsisvan|desnutri|\bdnt\b)/i]
];

var MESES = {enero:0,febrero:1,marzo:2,abril:3,mayo:4,junio:5,julio:6,agosto:7,septiembre:8,setiembre:8,octubre:9,noviembre:10,diciembre:11};

/* ======================= CLASIFICACIÓN ======================= */

/** Devuelve {clase, ...datos}. Funciones puras: se pueden probar sin Gmail. */
function clasificar(c, hoy) {
  var texto = (c.asunto || '') + '\n' + (c.cuerpo || '');
  var remitente = c.remitente || '';
  if (REMITENTES_IGNORADOS.test(remitente) && !c.etiquetaRadicar) return {clase: 'ignorado', motivo: 'Correo automático'};

  var oficial = REMITENTES_OFICIALES.some(function (r) { return r.test(remitente); });
  var asuntoOficio = PALABRAS_OFICIO.test(c.asunto || '');
  var cuerpoOficio = PALABRAS_OFICIO.test(c.cuerpo || '');
  var reunion = PALABRAS_REUNION.test(texto) || c.esInvitacion;

  if (c.etiquetaRadicar || asuntoOficio || (oficial && cuerpoOficio && !reunion)) {
    return {clase: 'oficio', tipo: tipoOficio(texto), radicado: numeroRadicado(texto)};
  }
  if (reunion) {
    var f = buscarFecha(texto, hoy, false);
    if (f) return {clase: 'reunion', fecha: f, hora: buscarHora(texto), enlace: buscarEnlace(texto),
                   lugar: buscarLugar(texto), modalidad: buscarEnlace(texto) ? 'Virtual' : 'Presencial'};
    return {clase: 'tarea', titulo: 'Revisar citación: ' + (c.asunto || '(sin asunto)'), prioridad: 'alta',
            fechaLimite: null, programa: programa(texto), nota: 'El agente no encontró la fecha de la reunión; agéndela a mano.'};
  }
  // Tarea: el asunto anuncia un entregable, o un remitente oficial/interno lo pide en el cuerpo
  var pideEnCuerpo = /(solicit|favor\s+(enviar|remitir|allegar)|remitir|allegar|a\s+m[aá]s\s+tardar|plazo)/i.test(c.cuerpo || '');
  var interno = /esehrno\.gov\.co/i.test(remitente);
  if (PALABRAS_TAREA.test(c.asunto || '') || ((oficial || interno) && pideEnCuerpo)) {
    var limite = buscarFecha(texto, hoy, true);
    var diasPlazo = limite ? Math.round((limite - hoy) / 86400000) : null;
    return {clase: 'tarea', titulo: c.asunto || '(sin asunto)', fechaLimite: limite, programa: programa(texto),
            prioridad: diasPlazo !== null && diasPlazo <= 3 ? 'alta' : 'media'};
  }
  return {clase: 'ignorado', motivo: 'Sin oficio, citación ni pedido'};
}

function tipoOficio(t) {
  if (/derecho\s+de\s+petici[oó]n/i.test(t)) return 'Derecho de petición';
  if (/requerimiento|tutela/i.test(t)) return 'Requerimiento';
  if (/\bcircular\b/i.test(t)) return 'Circular';
  if (/\bresoluci[oó]n\b/i.test(t)) return 'Resolución';
  if (/\bmemorando\b/i.test(t)) return 'Memorando';
  return 'Oficio';
}

function numeroRadicado(t) {
  var m = t.match(/(?:radicad[oa]|rad\.?|n[uú]mero|no\.?)\s*(?:n[oº°.]*\s*)?[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{5,30}\d)/i);
  if (m) return m[1].trim();
  m = t.match(/\b(\d{12,20})\b/);
  return m ? m[1] : null;
}

function programa(t) {
  for (var i = 0; i < PROGRAMAS.length; i++) if (PROGRAMAS[i][1].test(t)) return PROGRAMAS[i][0];
  return 'Coordinación Salud Pública';
}

/** Busca la primera fecha útil del texto. soloFutura: para plazos (descarta fechas pasadas). */
function buscarFecha(t, hoy, esPlazo) {
  var cands = [], m, re;
  var base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  // En plazos, prioriza la fecha que sigue a "a más tardar", "plazo", "hasta el", "antes del"
  if (esPlazo) {
    var trozo = t.match(/(a\s+m[aá]s\s+tardar|plazo[^.\n]{0,20}|hasta\s+el|antes\s+del?|fecha\s+l[ií]mite[^.\n]{0,10})([^\n]{0,60})/i);
    if (trozo) { var f0 = buscarFecha(trozo[2], hoy, false); if (f0) return f0; }
  }
  re = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g;
  while ((m = re.exec(t))) {
    var y = +m[3]; if (y < 100) y += 2000;
    cands.push(new Date(y, +m[2] - 1, +m[1]));
  }
  re = /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)\s+(\d{4}))?/gi;
  while ((m = re.exec(t))) {
    var mes = MESES[m[2].toLowerCase()], anio = m[3] ? +m[3] : base.getFullYear();
    var d = new Date(anio, mes, +m[1]);
    if (!m[3] && d < new Date(base.getTime() - 30 * 86400000)) d = new Date(anio + 1, mes, +m[1]);
    cands.push(d);
  }
  if (/\bma[nñ]ana\b/i.test(t) && !cands.length) cands.push(new Date(base.getTime() + 86400000));
  if (/\bhoy\b/i.test(t) && !cands.length) cands.push(base);
  var validas = cands.filter(function (d) { return !isNaN(d) && d >= base && d < new Date(base.getTime() + 400 * 86400000); });
  validas.sort(function (a, b) { return a - b; });
  return validas.length ? validas[0] : null;
}

function buscarHora(t) {
  var m = t.match(/\b(\d{1,2})(?::|\.|h)(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm|m\.)?/i)
       || t.match(/\b(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)\b/i);
  if (!m) return null;
  var h = +m[1], min = m[2] && /^\d+$/.test(m[2]) ? +m[2] : 0, suf = (m[3] || (m[2] && !/^\d+$/.test(m[2]) ? m[2] : '') || '').toLowerCase();
  if (/p/.test(suf) && h < 12) h += 12;
  if (/a/.test(suf) && h === 12) h = 0;
  if (!suf && h >= 1 && h <= 6) h += 12;   // "a las 2:00" en horario laboral = 2 p. m.
  if (h > 23 || min > 59) return null;
  return ('0' + h).slice(-2) + ':' + ('0' + min).slice(-2);
}

function buscarEnlace(t) {
  var m = t.match(/https?:\/\/(?:meet\.google\.com|[\w.-]*teams\.microsoft\.com|[\w.-]*zoom\.us)\/[^\s<>"')]+/i);
  return m ? m[0] : null;
}

function buscarLugar(t) {
  var m = t.match(/(?:lugar|sitio|direcci[oó]n|sede)\s*:\s*([^\n]{3,120})/i);
  return m ? m[1].trim() : null;
}

/* ========================= EJECUCIÓN ========================= */

function ejecutarAhora() { procesar_(true); }
function ejecucionProgramada() { procesar_(false); }

function procesar_(manual) {
  var ahora = new Date();
  var dia = +Utilities.formatDate(ahora, CONFIG.ZONA, 'u'); // 1 = lunes ... 7 = domingo
  if (!manual && dia > 5) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var hoy = fechaLocal_(ahora);
    var etqProc = GmailApp.getUserLabelByName(CONFIG.ETIQUETA_PROCESADO) || GmailApp.createLabel(CONFIG.ETIQUETA_PROCESADO);
    var hilos = GmailApp.search('in:inbox newer_than:' + CONFIG.DIAS_ATRAS + 'd -category:promotions -category:social -from:me', 0, 100);

    // Mensajes candidatos (cada mensaje de cada hilo dentro de la ventana)
    var desde = new Date(ahora.getTime() - CONFIG.DIAS_ATRAS * 86400000), lista = [];
    hilos.forEach(function (h) {
      var etqs = h.getLabels().map(function (l) { return l.getName(); });
      h.getMessages().forEach(function (m) {
        if (m.getDate() >= desde && !m.isInTrash()) lista.push({hilo: h, msg: m, radicar: etqs.indexOf(CONFIG.ETIQUETA_RADICAR) >= 0});
      });
    });
    if (!lista.length) { Logger.log('Sin correos nuevos.'); return; }

    var ya = rpc_('ya_procesados', {ids: lista.map(function (x) { return x.msg.getId(); })}) || [];
    var nuevos = lista.filter(function (x) { return ya.indexOf(x.msg.getId()) < 0; });
    var cfg = leerPlazos_();
    var radicados = radicadosExistentes_();
    var resumen = {oficio: 0, reunion: 0, tarea: 0, ignorado: 0, error: 0};

    nuevos.forEach(function (x) {
      var m = x.msg, id = m.getId();
      try {
        var c = {
          asunto: m.getSubject() || '', remitente: m.getFrom() || '', cuerpo: (m.getPlainBody() || '').slice(0, 6000),
          etiquetaRadicar: x.radicar,
          esInvitacion: m.getAttachments().some(function (a) { return /\.ics$/i.test(a.getName()) || /calendar/i.test(a.getContentType()); })
        };
        var r = clasificar(c, hoy), destino = r.motivo || '';
        var fechaLlegada = fechaLocal_(m.getDate());

        if (r.clase === 'oficio') {
          var rad = r.radicado || ('CORREO-' + Utilities.formatDate(m.getDate(), CONFIG.ZONA, 'yyyyMMdd') + '-' + id.slice(-6).toUpperCase());
          if (radicados.indexOf(rad) >= 0) {
            destino = 'Ya estaba en el radicador (' + rad + ')';
          } else {
            var plazo = cfg[r.tipo] || cfg._defecto || 7;
            var limite = sumarHabiles_(fechaLlegada, plazo);
            var resp = radicador_({
              action: 'agregarRecibido', radicadoRem: rad, remitente: nombreRemitente_(c.remitente).toUpperCase(),
              fechaRecepcion: dmy_(fechaLlegada), tipo: r.tipo, asunto: c.asunto.slice(0, 200),
              fechaLimite: dmy_(limite), responsable: 'POR ASIGNAR', observaciones: 'Registrado por el agente de correo'
            });
            if (!resp || !resp.exito) throw new Error('El radicador no aceptó el registro');
            rpc_('oficio_meta', {radicado_rem: rad, tipo: r.tipo, correo_id: id});
            radicados.push(rad);
            destino = 'Radicado ' + rad + ' · ' + r.tipo + ', vence ' + dmy_(limite);
          }
        } else if (r.clase === 'reunion') {
          rpc_('reunion', {titulo: c.asunto.slice(0, 250) || 'Reunión', fecha: iso_(r.fecha), hora: r.hora, lugar: r.lugar,
                           modalidad: r.modalidad, convoca: nombreRemitente_(c.remitente), enlace: r.enlace,
                           notas: 'Creada desde el correo. Revise los insumos a preparar.', correo_id: id});
          destino = 'Reunión ' + dmy_(r.fecha) + (r.hora ? ' ' + r.hora : '');
        } else if (r.clase === 'tarea') {
          rpc_('tarea', {titulo: r.titulo.slice(0, 250), descripcion: (r.nota ? r.nota + ' ' : '') + 'Correo de ' + nombreRemitente_(c.remitente) + '.',
                         programa: r.programa, prioridad: r.prioridad, fecha_limite: r.fechaLimite ? iso_(r.fechaLimite) : null,
                         correo_id: id, correo_remitente: c.remitente});
          destino = 'Tarea' + (r.fechaLimite ? ', límite ' + dmy_(r.fechaLimite) : ', sin fecha límite') + ' · ' + r.programa;
        }

        rpc_('correo', {correo_id: id, asunto: c.asunto, remitente: c.remitente, fecha_correo: m.getDate().toISOString(),
                        clasificacion: r.clase, destino: destino});
        if (r.clase !== 'ignorado') x.hilo.addLabel(etqProc);
        resumen[r.clase]++;
      } catch (e) {
        resumen.error++;
        Logger.log('Error con un correo: ' + e.message);   // sin contenido del correo en el registro
      }
    });
    Logger.log('Revisados ' + nuevos.length + ' · oficios ' + resumen.oficio + ' · reuniones ' + resumen.reunion +
               ' · tareas ' + resumen.tarea + ' · sin acción ' + resumen.ignorado + ' · errores ' + resumen.error);
  } finally {
    lock.releaseLock();
  }
}

/* ========================= SERVICIOS ========================= */

function rpc_(accion, fila) {
  var token = PropertiesService.getScriptProperties().getProperty('AGENTE_TOKEN');
  if (!token) throw new Error('Falta la propiedad AGENTE_TOKEN (paso 3 de la instalación).');
  return llamarSupa_('seg_agente', {p_token: token, p_accion: accion, p_fila: fila});
}

function llamarSupa_(fn, args) {
  var r = UrlFetchApp.fetch(CONFIG.SUPA_URL + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {apikey: CONFIG.SUPA_KEY, Authorization: 'Bearer ' + CONFIG.SUPA_KEY},
    payload: JSON.stringify(args)
  });
  var txt = r.getContentText(), j = txt ? JSON.parse(txt) : null;
  if (r.getResponseCode() >= 300) throw new Error((j && j.message) || ('Supabase ' + r.getResponseCode()));
  return j;
}

function leerPlazos_() {
  var r = UrlFetchApp.fetch(CONFIG.SUPA_URL + '/rest/v1/seg_config?clave=in.(plazos,festivos,no_habiles_extra)&select=clave,valor',
    {headers: {apikey: CONFIG.SUPA_KEY, Authorization: 'Bearer ' + CONFIG.SUPA_KEY}, muteHttpExceptions: true});
  var filas = JSON.parse(r.getContentText() || '[]'), plazos = {_defecto: 7};
  NO_HABILES_ = [];
  filas.forEach(function (f) {
    if (f.clave === 'plazos') plazos = f.valor;
    else NO_HABILES_ = NO_HABILES_.concat(f.valor || []);
  });
  return plazos;
}

var NO_HABILES_ = [];
function sumarHabiles_(desde, n) {
  var d = new Date(desde.getTime()), k = 0;
  while (k < n) {
    d.setDate(d.getDate() + 1);
    var w = d.getDay();
    if (w !== 0 && w !== 6 && NO_HABILES_.indexOf(iso_(d)) < 0) k++;
  }
  return d;
}

function radicador_(params) {
  var q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k] == null ? '' : params[k]); }).join('&');
  var r = UrlFetchApp.fetch(CONFIG.RADICADOR_URL + '?' + q, {followRedirects: true, muteHttpExceptions: true});
  try { return JSON.parse(r.getContentText()); } catch (e) { return null; }
}

function radicadosExistentes_() {
  var r = radicador_({action: 'listarRecibidos'});
  return ((r && r.entradas) || []).map(function (e) { return String(e.radicadoRem || ''); });
}

/* ========================= UTILIDADES ========================= */

function fechaLocal_(d) {
  var s = Utilities.formatDate(d, CONFIG.ZONA, 'yyyy-MM-dd').split('-');
  return new Date(+s[0], +s[1] - 1, +s[2]);
}
function iso_(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function dmy_(d) { return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear(); }
function nombreRemitente_(f) {
  var m = String(f).match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/);
  return m ? m[1].trim() + ' (' + m[2] + ')' : String(f).trim();
}

/* ======================= INSTALACIÓN ======================= */

function instalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ejecucionProgramada') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ejecucionProgramada').timeBased().everyDays(1).atHour(CONFIG.HORA).inTimezone(CONFIG.ZONA).create();
  Logger.log('Listo: el agente correrá de lunes a viernes cerca de las ' + CONFIG.HORA + ' a. m.');
}

function desinstalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Programación eliminada.');
}

function probarConexion() {
  var cuenta = Session.getActiveUser().getEmail();
  Logger.log('Cuenta: ' + cuenta);
  Logger.log('Correos en la bandeja (últimos días): ' + GmailApp.search('in:inbox newer_than:2d', 0, 20).length);
  Logger.log('Supabase y token: ' + (Array.isArray(rpc_('ya_procesados', {ids: []})) ? 'OK' : 'revisar'));
  Logger.log('Radicador: ' + radicadosExistentes_().length + ' oficios recibidos registrados');
  Logger.log('Plazo por defecto: ' + (leerPlazos_()._defecto || 7) + ' días hábiles · días no hábiles cargados: ' + NO_HABILES_.length);
}

/* Para pruebas fuera de Google (Node): exporta las funciones puras */
if (typeof module !== 'undefined') module.exports = {clasificar: clasificar, buscarFecha: buscarFecha, buscarHora: buscarHora, numeroRadicado: numeroRadicado, tipoOficio: tipoOficio, programa: programa};
