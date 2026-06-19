# AI.md — Misión Médica HRNO · Documentación de automatización e IA

> Módulo: `Mision_Medica_HRNO.html`  
> Proyecto: ESE Hospital Regional Noroccidental  
> Responsable: Danilo Torrado Blanco — Coordinador Salud Pública  
> Última actualización: 19 jun 2026

---

## Descripción general

Este módulo es una aplicación web de página única (`Mision_Medica_HRNO.html`) que gestiona los procesos del programa Misión Médica del HRNO. Funciona completamente en el navegador sin servidor propio, usando Supabase como base de datos y Google Apps Script como backend de correo/Excel.

---

## Arquitectura técnica

```
Navegador (HTML/CSS/JS)
     │
     ├── Supabase JS SDK  →  PostgreSQL (us-east-1)
     │     └── Proyecto: kukauvbqosizlxrapmim
     │
     └── Google Apps Script (MM V13)  →  Gmail + Google Sheets
           └── URL /exec (Web App, acceso: Cualquier usuario)
```

### Librerías (CDN, sin framework)

| Librería | Uso |
|----------|-----|
| Supabase JS | Base de datos en tiempo real |
| Tailwind CSS | Estilos utilitarios |
| Chart.js | Gráficas estadísticas en el panel admin |
| jsPDF + html2canvas | Generación de carnets en PDF |
| QRCode.js | Código QR en carnet digital |
| Lucide | Íconos SVG |

---

## Supabase — Base de datos

**Proyecto ID:** `kukauvbqosizlxrapmim`  
**URL:** `https://kukauvbqosizlxrapmim.supabase.co`  
**Región:** us-east-1

### Tablas

| Tabla | Descripción |
|-------|-------------|
| `mm_infracciones` | Reportes de infracciones e incidentes DIH |
| `mm_solicitudes_carnet` | Solicitudes de tarjeta de identidad Misión Médica |
| `mm_solicitudes_emblemas` | Solicitudes de chaleco, bandera, peto |
| `mm_stock_emblemas` | Inventario actual de emblemas |
| `mm_capacitaciones` | Sesiones de capacitación registradas |
| `mm_asistencia` | Asistentes por sesión |
| `mm_prepostest` | Resultados de evaluaciones pre/postest |

---

## Google Apps Script — MM V13

**Proyecto ID:** `1T_MPdav64hGhM89FTgSDERouQZu4M97mbaUevVdVKWGsOc6KM7IZu3Wl`  
**Google Sheet ID:** `1YXcFzbr6k3xowbDBSsZ8qYuTjkZSRJLHExFQcR5cbY0`  
**Versión en producción:** V3 (desplegada el 19 jun 2026)

### Acciones soportadas

#### GET
| `action` | Descripción |
|----------|-------------|
| `getData` | Lee todas las solicitudes de tarjetas y emblemas del Sheet |
| `getInventory` | Lee el stock actual de emblemas (banderas, chalecos, petos) |

#### POST
| `action` | Descripción |
|----------|-------------|
| `uploadCard` | Registra solicitud de carnet en la hoja `Tarjetas` |
| `requestEmblem` | Registra solicitud de emblema en la hoja `Emblemas` |
| `updateInventory` | Actualiza el stock de emblemas |
| `updateStatus` | Cambia el estado de una solicitud (Autorizado / Rechazado) y envía correo |
| `sendEmail` | Envía un correo arbitrario desde la cuenta del propietario del script |

### Envío de correos

El script usa `GmailApp.sendEmail()` bajo la cuenta `danto0702@gmail.com`. Los correos automáticos se disparan en dos momentos:

1. **Al registrar solicitud de carnet** — confirmación de recepción al solicitante.
2. **Al autorizar/rechazar** (`updateStatus`) — notificación de resultado al solicitante.

El campo remitente visible es: `Misión Médica — ESE HRNO`.

### CORS — nota técnica

Las llamadas al Apps Script desde el HTML usan:

```js
fetch(url, { method: 'POST', mode: 'no-cors', body: JSON.stringify(payload) })
```

`mode: 'no-cors'` evita el preflight OPTIONS que Google rechaza. La respuesta no es legible desde JS (opaque), pero la operación se ejecuta correctamente en el servidor.

---

## Vistas del módulo

| Vista | Ruta (`#`) | Acceso |
|-------|-----------|--------|
| Inicio / Bienvenida | `#inicio` | Público |
| Información DIH | `#informacion` | Público |
| Reporte de infracciones | `#infracciones` | Público |
| Solicitar carnet | `#carnet` | Público |
| Solicitar emblema | `#emblemas` | Público |
| Capacitaciones | `#capacitaciones` | Público |
| Panel Administrativo | `#admin` | Requiere contraseña `HRNO2026` |

---

## Panel Admin — funcionalidades

- Estadísticas en tiempo real (tarjetas, emblemas, infracciones, capacitaciones)
- Gestión de solicitudes de carnet: Autorizar / Rechazar con notificación por correo
- Gestión de solicitudes de emblema: Autorizar cantidad / Rechazar
- Actualización de stock de emblemas
- Visualización de registros de infracciones
- Gestión de sesiones de capacitación y asistencia

---

## Municipios cubiertos

- Ábrego
- El Carmen
- Convención
- Teorama

---

## Archivo de referencia Apps Script

`AppsScript_MisionMedica.gs` — copia local del código del script para versionado en Git. El código en producción está en `script.google.com` (proyecto MM V13).

---

## Historial de versiones del despliegue

| Versión | Fecha | Cambios |
|---------|-------|---------|
| V1 | 28 ene 2026 | Versión inicial |
| V2 | 28 ene 2026 | Ajustes de estructura |
| V3 | 19 jun 2026 | Acción `sendEmail` + handler `enviarCorreo()` con GmailApp; corrección CORS en `callAppsScript` |

---

## Archivos del módulo

```
MISIÓN MÉDICA/
├── Mision_Medica_HRNO.html              ← App principal (HTML + CSS + JS, ~2400 líneas)
├── AppsScript_MisionMedica.gs           ← Copia de referencia del Apps Script (MM V13)
├── Formulario de Reporte de Infracciones e Incidentes.html  ← Versión standalone del formulario
├── Gestion emblemas.html                ← Módulo anterior de gestión de emblemas
├── Pre y Postest.html                   ← Módulo standalone de evaluaciones
├── Modulo_Identificacion_Mision_Medica.html  ← Módulo de identificación
└── AI.md                                ← Este archivo
```
