# Arquitectura Técnica — CertiVac v5.2

## Diagrama general

```
┌─────────────────────────────────────────────────────────────┐
│                     NAVEGADOR (Chrome/Edge)                  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              index.html (frontend único)              │   │
│  │                                                        │   │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────────────────┐ │   │
│  │  │ SheetJS │  │ Chart.js │  │  JavaScript vanilla  │ │   │
│  │  │ (ETL)   │  │ (Charts) │  │  (App logic/state)   │ │   │
│  │  └────┬────┘  └──────────┘  └──────────┬───────────┘ │   │
│  │       │                                 │              │   │
│  │  Parsea XLS localmente             fetch() GET/POST   │   │
│  └───────┼─────────────────────────────────┼─────────────┘   │
└──────────┼─────────────────────────────────┼─────────────────┘
           │                                 │
           │ Registros JSON                  │ form-urlencoded
           │ (lotes de 200)                  │ (sin preflight CORS)
           ▼                                 ▼
┌──────────────────────────────────────────────────────────────┐
│              GOOGLE APPS SCRIPT (Backend/API)                 │
│                                                              │
│  doGet(?accion=xxx) ──────────────────────────────────────   │
│  doPost(payload=JSON) ────────────────────────────────────   │
│                                                              │
│  Endpoints GET:          Endpoints POST:                     │
│  ├── ping                ├── guardar_lote (chunks 200)       │
│  ├── registros           ├── borrar_archivo                  │
│  ├── archivos            ├── borrar_todo                     │
│  ├── liquidacion         ├── guardar_alias                   │
│  ├── analytics           ├── normalizar_nombres              │
│  ├── periodos            ├── guardar_valores                 │
│  ├── alias               ├── guardar_asignaciones            │
│  ├── valores             └── (más en desarrollo)            │
│  ├── asignaciones                                            │
│  └── trazadores                                              │
└──────────────────────────────┬───────────────────────────────┘
                               │ Sheets API (SpreadsheetApp)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    GOOGLE SHEETS (Base de datos)              │
│                                                              │
│  ┌─────────────────┐  ┌──────────────────┐                  │
│  │  REGISTROS_PAI  │  │ ARCHIVOS_CARGADOS│                  │
│  │  (1 fila/dosis) │  │ (historial XLS)  │                  │
│  └─────────────────┘  └──────────────────┘                  │
│  ┌─────────────────┐  ┌──────────────────┐                  │
│  │ALIAS_VACUNADORAS│  │VALORES_BIOLOGICOS│                  │
│  │(normalización)  │  │(metas y precios) │                  │
│  └─────────────────┘  └──────────────────┘                  │
│  ┌─────────────────┐  ┌──────────────────┐                  │
│  │  ASIGNACIONES   │  │   PARAMETROS     │                  │
│  │  MUNICIPIO      │  │  (configuración) │                  │
│  └─────────────────┘  └──────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

---

## Flujo de datos — Carga de archivo XLS

```
1. Usuario arrastra XLS al navegador
        ↓
2. SheetJS parsea el archivo LOCALMENTE (sin subir a internet)
   - Detecta hojas: Niños y Niñas, Adultos, Recién Nacidos
   - Extrae metadatos: municipio, mes, año, institución
   - Construye fecha completa YYYY-MM-DD (día + mes + año del metadata)
   - Identifica ciclo de contrato por: biológico + texto de dosis + edad en meses
        ↓
3. Frontend divide registros en lotes de 200
        ↓
4. Envía cada lote via POST form-urlencoded (evita preflight CORS)
   payload = JSON({accion: "guardar_lote", archivo: {...}, registros: [...]})
        ↓
5. Apps Script recibe, resuelve alias, guarda en REGISTROS_PAI
        ↓
6. Frontend refresca dashboard automáticamente
```

## Flujo — Liquidación

```
GET ?accion=liquidacion&mes=2026-02
        ↓
Backend lee REGISTROS_PAI + ALIAS_VACUNADORAS + VALORES_BIOLOGICOS
        ↓
Por cada fila:
  - Resuelve alias: "TORCO" → "TORCOROMA NAVARRO"
  - Agrupa por vacunadora → ciclo de contrato
  - Calcula: enMeta = MIN(aplicadas, meta)
  - Calcula: valor  = enMeta × valor_unitario
        ↓
Devuelve JSON con array de vacunadoras + detalles por ciclo
        ↓
Frontend renderiza tabla + permite generar certificado PDF
```

---

## Decisiones técnicas clave

### ¿Por qué form-urlencoded en lugar de JSON en POST?
Apps Script no responde al preflight OPTIONS de CORS que disparan las peticiones con `Content-Type: application/json`. Al usar `application/x-www-form-urlencoded` con el JSON en el campo `payload`, se evita el preflight y las peticiones funcionan desde cualquier origen.

### ¿Por qué lotes de 200 registros?
Un archivo XLS típico del PAI colombiano tiene entre 500-1500 dosis. El límite de tamaño de payload de Apps Script es ~50MB, pero el tiempo de ejecución es de 30 segundos. Lotes de 200 registros toman ~3-5 segundos cada uno, manteniéndose bajo el límite.

### ¿Por qué clearContent() en lugar de deleteRows()?
Google Sheets lanza "No se pueden eliminar todas las filas no inmovilizadas" cuando se intenta `deleteRows()` en hojas con `setFrozenRows(1)`. `clearContent()` borra el contenido sin eliminar filas físicamente, evitando el error.

### ¿Por qué construirFecha() en el frontend?
El XLS PAI colombiano tiene el día como número entero en col B (no como fecha completa). El mes y año están en las celdas de metadatos de la hoja. La función `construirFecha(día, mesNum, año)` reconstruye `YYYY-MM-DD` correctamente para todos los formatos posibles.

---

## Limitaciones conocidas

| Limitación | Impacto | Estado |
|---|---|---|
| Apps Script: 30 seg por ejecución | Archivos >2000 dosis tardan en guardarse | Mitigado con lotes de 200 |
| Google Sheets: 10M celdas máximo | ~380,000 registros PAI máx. | Suficiente para varios años |
| Sin autenticación de usuario | Cualquiera con la URL puede leer datos | Aceptable para uso interno hospitalario |
| Conexión requerida | No funciona offline | Por diseño (BD en la nube) |
