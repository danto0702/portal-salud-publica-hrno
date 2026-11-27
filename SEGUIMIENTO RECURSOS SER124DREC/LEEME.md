# Seguimiento de Recursos de Transferencias — SER124DREC

Aplicativo local (offline) para generar el archivo plano `.TXT` complementario de la **ejecución de recursos recibidos por transferencias** que se carga en **PISIS**, según el Anexo Técnico CVSF05 v02 (Resolución 2361 de 2016), fuente de información **SER124DREC**.

> Referente: Danilo Torrado Blanco · Coordinación de Salud Pública · ESE HRNO

---

## Archivos de esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `Seguimiento_Recursos_SER124DREC.html` | **El aplicativo.** Ábrelo con doble clic (Chrome/Edge). |
| `xlsx.full.min.js` | Librería para leer/generar Excel sin internet. **No borrar.** |
| `Apps_Script_Backend.gs` | Código del backend de Google Sheets (Apps Script). |
| `LEEME.md` | Este documento. |

---

## Flujo de uso

1. **Entidad y período (pestaña 1).** Diligencia una sola vez: tipo y número de identificación de la entidad, **ID Recurso**, NIT de la beneficiaria y las fechas inicial/final del mes. Guarda. Cada archivo corresponde a **un solo ID Recurso**.
2. **Registros de detalle (pestañas 2 a 7).** Agrega uno a uno, o usa la pestaña **Excel** para cargar en bloque.
   - **Tipo 2** Incorporación · **Tipo 3** Contratos y actos · **Tipo 4** Pólizas · **Tipo 5** Seguimiento técnico-financiero · **Tipo 6** Reintegro de recursos no ejecutados · **Tipo 7** Reintegro de rendimientos financieros.
   - El **Indicador** de cada registro: **I** insertar (nuevo), **A** actualizar (corrige uno previo), **E** anular (elimina uno previo), **NA** no aplica (omite el registro; los demás campos van vacíos).
   - El botón **"Usar datos del encabezado"** copia el ID Recurso y el NIT de la pestaña 1.
3. **Excel (pestaña).** Descarga la plantilla, diligénciala (una hoja por tipo) y cárgala. También puedes **exportar** los datos actuales.
4. **Generar y enviar (pestaña).** Valida la estructura, muestra el **nombre del archivo** y la **vista previa** con colores por tipo de registro. Descarga el `.TXT`, firma y sube a PISIS y, cuando la validación de PISIS sea exitosa, pulsa **Confirmar carga** para marcar esos registros como CARGADO (ver sección "Sincronización y estados").

> **Importante:** antes de subir el archivo a PISIS debe **firmarse digitalmente** con un certificado de una entidad certificadora aprobada. Este aplicativo genera el `.TXT`; la firma se hace aparte.

---

## Contratos (Tipo 3): supervisor único y cargue masivo

En la pestaña **Contratos** hay un bloque arriba con dos herramientas:

- **Supervisor del contrato (único para todos):** registras una sola vez el tipo y número de identificación y el nombre del supervisor/interventor. Al pulsar **Guardar y aplicar a todos**, ese supervisor se asigna a todos los contratos (los ya CARGADOS no se tocan). Por eso el supervisor ya no se pide contrato por contrato.
- **Cargar contratos (Excel del sistema):** carga masiva de contratistas leyendo el **export del sistema de contratación** tal cual. El aplicativo reconoce las columnas por su nombre:

  | Columna del export | Se usa como |
  |---|---|
  | `CÓDIGOCONTRATO` | Número de contrato (prefijo **CPS-** + año: 0483 → CPS-0483-2026) |
  | `OBJETOCONTRATO` | Objeto |
  | `VALOR INIC. HIDECONTRATO` | Valor del contrato |
  | `CONTRATISTAS` | Se separa en documento (primer número) y nombre |
  | `FECHA ACTAINICIO` | Fecha del contrato |
  | `TIEMPO EJECUCIÓN` | Días para calcular la **fecha de terminación** (inicio + días) |

  Cada contrato se crea como Tipo 3 con indicador **I**, tipo de contrato **1 (Contrato)**, tipo de identificación del contratista **CC**, y toma el **supervisor** de arriba y el **ID Recurso / NIT / período** del encabezado (pestaña 1). Los que coincidan con un contrato ya **CARGADO** del mismo período se omiten; si vuelves a cargar el mismo contrato en borrador, se actualiza en vez de duplicarse.

  > Antes de cargar: guarda la **entidad y el período** (pestaña 1) y el **supervisor**.

## Cargar un archivo plano corregido (.TXT)

En **Generar y enviar** está el botón **"Cargar plano corregido (.TXT)"**. Sirve para tomar un archivo plano SER124DREC ya ajustado por fuera y **actualizar los registros del aplicativo** con esas correcciones.

- **Fusiona por clave** del anexo + período: los registros del archivo que coincidan con los existentes los actualizan; los nuevos se agregan; lo que no venga en el archivo se conserva.
- Los registros importados quedan como **BORRADOR** (para revisarlos y regenerar).
- Si una corrección coincide con un registro que estaba **CARGADO**, lo **reabre** (queda en borrador con los datos corregidos).
- **No** cambia el encabezado (pestaña 1); el período de cada registro se toma del registro de control (Tipo 1) del archivo.
- El archivo se lee como **ANSI** (conserva la Ñ). El aplicativo informa cuántos registros actualizó, reabrió y agregó.

## Módulo Administrador · informe financiero (.docx)

La pestaña **Administrador** (contraseña opcional, se configura al final de esa misma pestaña) permite:

1. **Rubros de la resolución:** define los rubros presupuestales y su **valor asignado**. Puedes editarlos o eliminarlos.
2. **Asignar rubro a contratos:** a cada contrato (Tipo 3) le asignas su rubro, uno a uno o **en bloque** (a todos, o solo a los que no tienen). El rubro también aparece en el formulario y en la tabla de Contratos. *(El rubro es un dato interno del aplicativo; no forma parte del archivo plano.)*
3. **Informe financiero:** eliges el rango de períodos (**un mes** con el atajo, o **un rango** entre dos fechas de corte) y generas un **Word .docx nativo** con, por cada rubro: **Asignado · Contratado · Pagado · Saldo · % Ejecución**, más totales y el valor de reintegros del período.

Fórmulas: Contratado = Σ valor de contratos (Tipo 3) · Pagado = Σ valor pagado del seguimiento (Tipo 5, enlazado al contrato) · Saldo = Asignado − Contratado · % Ejec. = Pagado / Asignado. El filtro por período usa la fecha de corte de cada registro.

## Sincronización y estados (borrador → cargado)

Google Sheets es la **fuente de verdad**. Cada registro tiene un estado:

- **BORRADOR:** en proceso. Se puede editar, se incluye en la generación del `.TXT` y se puede guardar en la nube para no perder el avance.
- **CARGADO:** ya reportado a PISIS. Queda **bloqueado** (no editable) y **se excluye** de los archivos que generes después, para no volver a cargar la misma información.

Botones (en **Generar y enviar** y en **Ajustes**):

- **Guardar avance en la nube:** sube **todas las resoluciones** registradas en este equipo —no solo la activa— con sus registros (borradores y cargados) y el **listado de resoluciones**. Puedes cerrar y seguir después, incluso desde otro equipo.
- **Descargar de la nube:** trae el **listado de resoluciones** de la hoja (las creadas en otros equipos aparecen aquí) y los registros de **todas** ellas, repartiéndolos a cada resolución. Fusiona por identificador único; un CARGADO siempre gana; si no, gana el más reciente.
- **Confirmar carga:** disponible solo cuando la estructura es válida. Marca los borradores como **CARGADO** (local y en la nube). Hazlo **después** de subir y validar el archivo en PISIS.

> **Sincronización multi-resolución.** Cada registro viaja etiquetado con su resolución (`rid`), y la hoja tiene una pestaña **RESOLUCIONES** con el listado. Así, una resolución creada en un equipo aparece en los demás al **Descargar de la nube** (al crearla también se registra automáticamente si hay conexión). Dos resoluciones distintas nunca se mezclan aunque compartan números de contrato.

**Antiduplicados:** dos registros son "el mismo" si comparten la clave única del anexo **y el mismo período (fecha de corte)**. Así puedes volver a reportar el mismo contrato en meses distintos (seguimiento mensual), pero no duplicar uno ya cargado del mismo período. Al cargar por Excel o desde la nube, los que coincidan con un CARGADO del mismo período se omiten.

En **Ajustes** puedes activar **"Descargar automáticamente al abrir"** para que el aplicativo se sincronice solo al iniciar.

## Backend en Google Sheets (Apps Script)

Hoja ya creada en tu Google Drive:
**"SER124DREC - Backend Seguimiento de Recursos (HRNO)"**
`https://docs.google.com/spreadsheets/d/1KaJdjPTVV3nzOjchme0jgEI8ZZ9eig4VGuvxZ_5McHM/edit`

Pasos para activarlo:

1. Abre la hoja → **Extensiones → Apps Script**.
2. Borra el contenido y pega el código de `Apps_Script_Backend.gs`. Guarda.
3. (Opcional) define un `TOKEN` secreto y ponlo igual en el aplicativo.
4. **Implementar → Nueva implementación → Aplicación web**:
   - *Ejecutar como:* **Yo**
   - *Quién tiene acceso:* **Cualquier usuario**
5. Autoriza los permisos y copia la **URL /exec**.
6. En el aplicativo → pestaña **Ajustes** → pega la URL → **Guardar** → **Probar conexión**.

> **Si ya tenías una versión anterior desplegada** (la primera versión del backend), debes publicar la nueva: **Implementar → Gestionar implementaciones → (editar, ícono lápiz) → Versión: Nueva versión → Implementar**. Si no, el aplicativo seguirá usando el código viejo y fallarán "Descargar/Confirmar".

El script crea automáticamente: `ENVIOS` (bitácora de cargas), `RESOLUCIONES` (listado de resoluciones de todos los equipos) y una hoja por cada tipo de registro (`INCORPORACION`, `CONTRATOS`, `POLIZAS`, `SEGUIMIENTO`, `REINT_RECURSOS`, `REINT_RENDIM`), cada una con columnas de control (`uid`, `rid`, `estado`, `periodo`, `updatedAt`) más los campos del anexo.

> **Si ya tenías datos cargados con una versión anterior** (sin la columna `rid`): al republicar el Apps Script (v2.5) y descargar/guardar, el backend **añade la columna `rid` automáticamente** sin perder tus datos; los registros antiguos quedan asociados a la resolución inicial (Resolución 0272 de 2026).

---

## Estructura del archivo plano (resumen del anexo)

**Nombre:** `SER124DREC` + `AAAAMMDD` (fecha de corte = fecha final) + `XX` (tipo id entidad) + `999999999999` (nº entidad, 12 díg. con ceros a la izquierda) + `IDXXXXXXXXXX` (ID Recurso, 12) + `.TXT` — **48 caracteres**.

**Reglas:** texto ANSI · MAYÚSCULAS sin tildes (conserva la Ñ) · separador `|` · fechas `AAAA-MM-DD` · sin comillas · numéricos sin separador de miles · decimales con punto (máx. 2) · un salto de línea (ENTER) por registro · sin justificación con ceros ni espacios en los registros.

| Registro | Descripción | Reporte |
|---|---|---|
| **Tipo 1** | Control: identifica a la entidad reportadora y el período (1 solo). | Obligatorio |
| **Tipo 2** | Detalle de la incorporación. | Obligatorio |
| **Tipo 3** | Contratos y actos administrativos. | Obligatorio |
| **Tipo 4** | Pólizas que respaldan los actos. | Obligatorio |
| **Tipo 5** | Seguimiento técnico y financiero (parciales/finales). | Obligatorio |
| **Tipo 6** | Reintegro de recursos no ejecutados. | Obligatorio |
| **Tipo 7** | Reintegro de rendimientos financieros. | Obligatorio |

- El **consecutivo** corre continuo desde el primer registro de detalle (Tipo 2) hasta el último (Tipo 7).
- El **total** del Tipo 1 = número de todos los registros de detalle del archivo.
- El **número de identificación** va **sin ceros de relleno** en el registro de control, pero **con ceros a la izquierda** (12 dígitos) en el nombre del archivo (el aplicativo lo hace solo).

---

## Periodicidad

El envío es **mensual**. La información se reporta desde el **día 6** hasta el **último día del mes siguiente** a la fecha de corte.

---

## Notas

- Todos los datos se guardan en el **navegador de este equipo** (localStorage). Usa **Ajustes → Exportar respaldo** para hacer copia o pasar a otro equipo.
- La **Ñ** se conserva; solo se eliminan las tildes (á→A, é→E, …). El carácter `|` se reemplaza por espacio porque está reservado como separador.
- Sin servidor, sin dependencias de CDN obligatorias: funciona con doble clic aunque no haya internet (el envío a Google Sheets sí requiere conexión).
- Cada archivo es de **un solo ID Recurso**. Si reportas varios recursos, genera un archivo por cada uno (cambia el ID Recurso del encabezado y filtra sus registros).
