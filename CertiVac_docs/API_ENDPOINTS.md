# Documentación API REST — CertiVac v5.2
## Google Apps Script Web App

**URL Base:** `https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec`

---

## Consideraciones técnicas

- Todos los endpoints GET devuelven `Content-Type: application/json`
- Los POST usan `Content-Type: application/x-www-form-urlencoded` con el JSON en el campo `payload`
- No requiere autenticación (acceso público configurado en la implementación)
- Tiempo máximo de respuesta: 30 segundos (límite de Apps Script)

---

## Endpoints GET

### `?accion=ping`
Verifica que la API esté activa.

**Respuesta:**
```json
{ "ok": true, "ts": "2026-03-15T10:30:00.000Z" }
```

---

### `?accion=registros`
Devuelve registros de REGISTROS_PAI.

**Parámetros opcionales:**
| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `mes` | `YYYY-MM` | Filtrar por mes |
| `id_archivo` | UUID | Filtrar por archivo fuente |
| `limite` | Número | Máximo de registros (default: 2000, max: 50000) |

---

### `?accion=archivos`
Devuelve el historial de archivos cargados.

---

### `?accion=periodos`
Devuelve los meses disponibles en la BD.

**Respuesta:**
```json
{ "ok": true, "periodos": ["2026-02", "2025-07"] }
```

---

### `?accion=liquidacion`
Calcula la liquidación de pago por vacunadora.

**Parámetros opcionales:**
| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `mes` | `YYYY-MM` | Filtrar por mes específico |
| `año` | `YYYY` | Filtrar por año |

**Respuesta:**
```json
{
  "ok": true,
  "vacs": [
    {
      "vac": "TORCOROMA NAVARRO",
      "tAp": 492, "tEnMeta": 220, "tFuera": 272,
      "tVal": 1760000, "tValExt": 1056000,
      "detalles": [
        { "ciclo": "2M-Penta", "grupo": "2 meses", "meta": 11,
          "ap": 15, "enMeta": 11, "fuera": 4,
          "val": 88000, "valExt": 32000 }
      ]
    }
  ],
  "granTotal": 8800000,
  "granExt": 4200000,
  "periodos": ["2026-02", "2025-07"]
}
```

---

### `?accion=analytics`
Calcula matrices de análisis por período.

**Parámetros opcionales:**
| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `agrupacion` | `dia/semana/mes/trimestre/semestre/año` | Agrupación temporal (default: mes) |
| `vacunadora` | Texto | Filtrar por vacunadora |
| `municipio` | Texto | Filtrar por municipio |
| `mes` | `YYYY-MM` | Filtrar por mes |
| `año` | `YYYY` | Filtrar por año |
| `desde` | `YYYY-MM-DD` | Fecha inicio |
| `hasta` | `YYYY-MM-DD` | Fecha fin |

---

### `?accion=trazadores`
Calcula indicadores de biológicos trazadores PAI.

**Parámetros opcionales:** municipio, mes, año, desde, hasta, agrupacion

**Trazadores incluidos:**
- RN-BCG (Recién Nacidos)
- 6M-Penta, 6M-Polio (Menores 1 año)
- 1A-TripleViral (Niños 1 año)
- 5A-DPT, 5A-PolioOral/Inyec (Niños 5 años)

---

### `?accion=alias`
Devuelve aliases definidos + nombres únicos en REGISTROS_PAI.

---

### `?accion=valores`
Devuelve metas y valores por ciclo de VALORES_BIOLOGICOS.

---

### `?accion=asignaciones`
Devuelve asignaciones vacunadora→municipio + vacunadoras únicas en BD.

---

## Endpoints POST

Todos reciben el cuerpo como `application/x-www-form-urlencoded`:
```
payload={"accion":"nombre_accion", ...campos}
```

---

### `{ accion: "guardar_lote" }`
Guarda un lote de registros en REGISTROS_PAI.

```json
{
  "accion": "guardar_lote",
  "archivo": {
    "nombre": "REGISTROS_JULIO_2025.xls",
    "tamaño": "21.1 MB",
    "mes": "Julio",
    "año": "2025",
    "municipio": "Abrego",
    "departamento": "Norte de Santander",
    "institucion": "ESE Hospital Regional Noroccidental - PAI",
    "esChunk": true,
    "chunkIndex": 0,
    "totalChunks": 4,
    "idArchivoExistente": ""
  },
  "registros": [
    {
      "dia": "2025-07-09",
      "vacunadora": "TORCOROMA NAVARRO",
      "idPaciente": "1094585774",
      "tipoEdad": "M",
      "edadNum": 2,
      "edadMeses": 2,
      "poblacion": "Niños y Niñas",
      "biologico": "PENTAVALENTE (DPT,HIB,HB)",
      "dosis": "Primera Dosis",
      "ciclo": "2M-Penta",
      "grupoCiclo": "2 meses",
      "metaCiclo": 11
    }
  ]
}
```

---

### `{ accion: "borrar_archivo" }`
```json
{ "accion": "borrar_archivo", "id_archivo": "uuid", "nombre_archivo": "nombre.xls" }
```

---

### `{ accion: "borrar_todo", "confirmacion": "BORRAR_TODO" }`
Borra TODOS los registros. Requiere confirmación exacta.

---

### `{ accion: "guardar_alias" }`
```json
{ "accion": "guardar_alias", "alias": [{ "raw": "VIRGELINA", "canonical": "VIRGELINA PICON" }] }
```

---

### `{ accion: "normalizar_nombres" }`
Aplica los aliases a todos los registros históricos en REGISTROS_PAI.

---

### `{ accion: "guardar_valores" }`
```json
{ "accion": "guardar_valores", "valores": [{ "ciclo": "2M-Penta", "label": "...", "meta": 11, "valor": 8000 }] }
```

---

### `{ accion: "guardar_asignaciones" }`
```json
{ "accion": "guardar_asignaciones", "asignaciones": [{ "vacunadora": "TORCOROMA NAVARRO", "municipio": "Abrego", "departamento": "Norte de Santander", "notas": "" }] }
```
