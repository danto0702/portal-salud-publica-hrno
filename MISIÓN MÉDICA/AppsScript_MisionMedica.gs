/**
 * ════════════════════════════════════════════════════════════════
 *  APPS SCRIPT — Misión Médica HRNO
 *  Versión: 2.0  (compatible con Gestión Emblemas + Misión Médica)
 *  Acciones soportadas:
 *    GET  → getInventory, getData
 *    POST → uploadCard, requestEmblem, updateInventory,
 *            updateStatus, sendEmail
 * ════════════════════════════════════════════════════════════════
 *
 *  INSTRUCCIONES DE INSTALACIÓN:
 *  1. Abre script.google.com
 *  2. Abre el proyecto de tu Apps Script existente
 *  3. Reemplaza TODO el contenido con este código
 *  4. Guarda (Ctrl+S)
 *  5. Ve a Implementar → Administrar implementaciones → editar (lápiz)
 *  6. Cambia la versión a "Nueva versión"
 *  7. Haz clic en "Implementar"
 *  8. Copia la URL /exec (debe ser la misma URL ya usada)
 *
 *  PERMISOS requeridos la primera vez:
 *  - Google Sheets (leer/escribir)
 *  - Gmail (enviar correos)
 */

// ── CONFIGURACIÓN ──────────────────────────────────────────────
// Reemplaza este ID con el de tu Google Sheet actual
// Lo encuentras en la URL de tu hoja:
// https://docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit
const SPREADSHEET_ID = 'PEGA_AQUÍ_EL_ID_DE_TU_GOOGLE_SHEET';

// Nombres de las hojas dentro del spreadsheet
const SHEET_TARJETAS  = 'Tarjetas';    // Hoja para solicitudes de tarjeta
const SHEET_EMBLEMAS  = 'Emblemas';    // Hoja para solicitudes de emblemas
const SHEET_INVENTARIO = 'Inventario'; // Hoja para el stock

// Correo del remitente (debe ser tu Gmail o el de la institución)
const EMAIL_REMITENTE_NOMBRE = 'Misión Médica — ESE HRNO';

// ── HELPERS ────────────────────────────────────────────────────
function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function timestamp() {
  return new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}

function corsHeaders() {
  return ContentService.createTextOutput()
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════
//  doGet — Maneja peticiones GET (lectura de datos)
// ══════════════════════════════════════════════════════════════
function doGet(e) {
  try {
    const action = e.parameter.action;

    // ── getInventory ──
    if (action === 'getInventory') {
      const sheet = getSheet(SHEET_INVENTARIO);
      // Fila 1: encabezados (Banderas, Chalecos, Petos)
      // Fila 2: valores actuales
      const data = sheet.getRange(2, 1, 1, 3).getValues()[0];
      const result = {
        banderas: data[0] || 0,
        chalecos: data[1] || 0,
        petos:    data[2] || 0
      };
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── getData ──
    if (action === 'getData') {
      const sheetT = getSheet(SHEET_TARJETAS);
      const sheetE = getSheet(SHEET_EMBLEMAS);

      const rowsT = sheetT.getDataRange().getValues();
      const rowsE = sheetE.getDataRange().getValues();

      const result = [];

      // Tarjetas (saltar fila de encabezados si existe)
      for (let i = 1; i < rowsT.length; i++) {
        const r = rowsT[i];
        if (!r[0]) continue; // fila vacía
        result.push({
          tipo:               'Tarjeta',
          nombre:             r[0] || '',
          documento:          r[1] || '',
          perfil:             r[2] || '',
          cargo:              r[3] || '',
          municipio:          r[4] || '',
          ips:                r[5] || '',
          email:              r[6] || '',
          telefono:           r[7] || '',
          estado:             r[8] || 'Pendiente',
          fecha_solicitud:    r[9] || '',
        });
      }

      // Emblemas
      for (let i = 1; i < rowsE.length; i++) {
        const r = rowsE[i];
        if (!r[0]) continue;
        result.push({
          tipo:                'Emblema',
          nombre:              r[0] || '',
          documento:           r[1] || '',
          municipio:           r[2] || '',
          ips:                 r[3] || '',
          email:               r[4] || '',
          telefono:            r[5] || '',
          tipo_emblema:        r[6] || '',
          cantidad_solicitada: r[7] || 1,
          cantidad_autorizada: r[8] || 0,
          estado:              r[9] || 'Pendiente',
          fecha_solicitud:     r[10] || '',
        });
      }

      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Acción no reconocida
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Acción no reconocida: ' + action }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ══════════════════════════════════════════════════════════════
//  doPost — Maneja peticiones POST (escritura + envío de correo)
// ══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    // ── uploadCard ── Guardar solicitud de tarjeta de identidad
    if (action === 'uploadCard') {
      const sheet = getSheet(SHEET_TARJETAS);

      // Crear encabezados si la hoja está vacía
      if (sheet.getLastRow() === 0) {
        sheet.appendRow([
          'Nombre', 'Documento', 'Perfil', 'Cargo', 'Municipio', 'IPS',
          'Correo', 'Teléfono', 'Estado', 'Fecha Solicitud',
          'Fecha Nacimiento', 'Sexo', 'Vinculación', 'RH', 'Estatura',
          'Responsable'
        ]);
      }

      sheet.appendRow([
        data.nombre            || '',
        data.documento         || '',
        data.perfil            || '',
        data.cargo             || '',
        data.municipio         || '',
        data.ips               || '',
        data.email             || '',
        data.telefono          || '',
        'Pendiente',
        timestamp(),
        data.fecha_nacimiento  || '',
        data.sexo              || '',
        data.vinculacion       || '',
        data.rh                || '',
        data.estatura          || '',
        data.responsable       || ''
      ]);

      // Notificar al solicitante
      if (data.email) {
        enviarCorreo(
          data.email,
          'Solicitud recibida — Tarjeta Misión Médica · ESE HRNO',
          `Estimado(a) ${data.nombre},\n\nHemos recibido tu solicitud de tarjeta de identificación de la Misión Médica.\n\nUna vez sea revisada y autorizada, recibirás un correo con el enlace para completar el proceso fotográfico.\n\nNúmero de documento registrado: ${data.documento}\n\nAtentamente,\nMisión Médica — ESE Hospital Regional Noroccidental`
        );
      }

      return ok('Tarjeta registrada');
    }

    // ── requestEmblem ── Guardar solicitud de emblema
    if (action === 'requestEmblem') {
      const sheet = getSheet(SHEET_EMBLEMAS);

      if (sheet.getLastRow() === 0) {
        sheet.appendRow([
          'Nombre', 'Documento', 'Municipio', 'IPS', 'Correo', 'Teléfono',
          'Tipo Emblema', 'Cantidad Solicitada', 'Cantidad Autorizada',
          'Estado', 'Fecha Solicitud'
        ]);
      }

      sheet.appendRow([
        data.nombre              || '',
        data.documento           || '',
        data.municipio           || '',
        data.ips                 || '',
        data.email               || '',
        data.telefono            || '',
        data.tipo_emblema        || '',
        data.cantidad_solicitada || 1,
        0,
        'Pendiente',
        timestamp()
      ]);

      return ok('Emblema registrado');
    }

    // ── updateInventory ── Actualizar stock de emblemas
    if (action === 'updateInventory') {
      const sheet = getSheet(SHEET_INVENTARIO);

      if (sheet.getLastRow() === 0) {
        sheet.appendRow(['Banderas', 'Chalecos', 'Petos', 'Última actualización']);
        sheet.appendRow([0, 0, 0, timestamp()]);
      }

      sheet.getRange(2, 1, 1, 4).setValues([[
        parseInt(data.banderas) || 0,
        parseInt(data.chalecos) || 0,
        parseInt(data.petos)    || 0,
        timestamp()
      ]]);

      return ok('Inventario actualizado');
    }

    // ── updateStatus ── Cambiar estado de una solicitud (Tarjeta o Emblema)
    if (action === 'updateStatus') {
      const sheetName = data.type === 'Tarjeta' ? SHEET_TARJETAS : SHEET_EMBLEMAS;
      const sheet = getSheet(sheetName);
      const colDocumento = 2; // columna B (1-indexed)
      const colEstado    = data.type === 'Tarjeta' ? 9 : 10;
      const colCantAut   = 9; // solo aplica a emblemas

      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][1]) === String(data.documento)) {
          // Mapear 'Aceptado'/'Negado' al español del estado
          const nuevoEstado = data.status === 'Aceptado' ? 'Autorizado' : 'Rechazado';
          sheet.getRange(i + 1, colEstado).setValue(nuevoEstado);

          // Cantidad autorizada (solo emblemas)
          if (data.type === 'Emblema' && data.cantidad_autorizada !== undefined) {
            sheet.getRange(i + 1, colCantAut).setValue(parseInt(data.cantidad_autorizada) || 0);
          }

          // Notificar al solicitante si fue aceptado
          const emailRow = data.type === 'Tarjeta' ? rows[i][6] : rows[i][4];
          const nombreRow = rows[i][0];
          if (data.status === 'Aceptado' && emailRow) {
            const cuerpo = data.type === 'Tarjeta'
              ? `Estimado(a) ${nombreRow},\n\nTu solicitud de tarjeta de identificación de la Misión Médica ha sido APROBADA.\n\nPróximamente recibirás instrucciones para completar el proceso.\n\nAtentamente,\nMisión Médica — ESE HRNO`
              : `Estimado(a) ${nombreRow},\n\nTu solicitud de ${rows[i][6]} (Cantidad: ${data.cantidad_autorizada}) ha sido APROBADA.\n\nEl emblema estará disponible para recogida en tu IPS.\n\nAtentamente,\nMisión Médica — ESE HRNO`;
            enviarCorreo(emailRow, 'Tu solicitud fue aprobada — Misión Médica · ESE HRNO', cuerpo);
          }
          break;
        }
      }

      return ok('Estado actualizado');
    }

    // ════════════════════════════════════════
    //  ✉️  sendEmail — NUEVA ACCIÓN
    //  Llamada desde Mision_Medica_HRNO.html
    //  cuando se autoriza un carnet digital
    // ════════════════════════════════════════
    if (action === 'sendEmail') {
      if (!data.to || !data.subject || !data.body) {
        return error('Faltan campos: to, subject, body');
      }

      enviarCorreo(data.to, data.subject, data.body);
      return ok('Correo enviado a ' + data.to);
    }

    return error('Acción no reconocida: ' + action);

  } catch (err) {
    console.error('Error en doPost:', err.message);
    return error(err.message);
  }
}

// ── UTILIDADES INTERNAS ─────────────────────────────────────────

/**
 * Envía un correo usando la cuenta Gmail del propietario del script.
 * @param {string} destinatario - Dirección de correo destino
 * @param {string} asunto       - Asunto del correo
 * @param {string} cuerpo       - Cuerpo en texto plano
 */
function enviarCorreo(destinatario, asunto, cuerpo) {
  try {
    GmailApp.sendEmail(
      destinatario,
      asunto,
      cuerpo,
      {
        name: EMAIL_REMITENTE_NOMBRE,
        replyTo: Session.getActiveUser().getEmail()
      }
    );
    console.log('Correo enviado a:', destinatario);
  } catch (err) {
    console.error('Error enviando correo a', destinatario, ':', err.message);
    // No lanzamos el error para no bloquear otras operaciones
  }
}

function ok(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', message: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

function error(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
