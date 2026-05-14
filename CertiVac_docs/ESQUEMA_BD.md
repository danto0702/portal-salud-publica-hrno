# Esquema de Base de Datos — CertiVac v5.2
## Google Sheets como base de datos relacional

---

## Hoja: REGISTROS_PAI
**Propósito:** Almacena una fila por cada dosis aplicada. Es la tabla principal del sistema.  
**Máximo recomendado:** ~200,000 filas (equivale a ~2 años de registros)

| Col | Campo | Tipo | Descripción | Ejemplo |
|-----|-------|------|-------------|---------|
| A | id_registro | UUID | Identificador único generado por Apps Script | `a1b2c3d4-e5f6-...` |
| B | fecha_carga | ISO DateTime | Cuándo se guardó el registro | `2026-03-15T10:30:00Z` |
| C | id_archivo | UUID | ID del archivo XLS fuente | `uuid-arch-001` |
| D | nombre_archivo | Texto | Nombre del XLS original | `REGISTROS_JULIO_2025.xls` |
| E | dia | Fecha | Fecha de vacunación YYYY-MM-DD | `2025-07-09` |
| F | año | Número | Año extraído de `dia` | `2025` |
| G | mes_num | Número | Mes 1-12 | `7` |
| H | mes_nombre | Texto | Nombre del mes | `Julio` |
| I | trimestre | Texto | T1/T2/T3/T4 | `T3` |
| J | semestre | Texto | S1/S2 | `S2` |
| K | vacunadora | Texto | Nombre canónico (alias aplicado) | `TORCOROMA NAVARRO` |
| L | id_paciente | Texto | Número de identificación del paciente | `1094585774` |
| M | tipo_edad | Texto | M=Meses, A=Años, D=Días | `M` |
| N | edad_num | Número | Edad como número | `2` |
| O | edad_meses | Número | Edad convertida a meses | `2` |
| P | poblacion | Texto | Niños y Niñas / Adultos / Recién Nacidos | `Niños y Niñas` |
| Q | biologico | Texto | Nombre del biológico según XLS | `PENTAVALENTE (DPT,HIB,HB)` |
| R | texto_dosis | Texto | Texto de la dosis según XLS | `Primera Dosis` |
| S | ciclo | Texto | Clave del ciclo del contrato | `2M-Penta` |
| T | grupo_ciclo | Texto | Grupo de edad del contrato | `2 meses` |
| U | en_ciclo | Boolean | TRUE si está dentro del contrato | `TRUE` |
| V | valor_unitario | Número | Valor por dosis en COP | `8000` |
| W | meta_ciclo | Número | Meta mensual del ciclo | `11` |
| X | municipio | Texto | Municipio del archivo fuente | `Abrego` |
| Y | departamento | Texto | Departamento | `Norte de Santander` |
| Z | institucion | Texto | IPS vacunadora | `ESE Hospital Regional Noroccidental - PAI` |

---

## Hoja: ARCHIVOS_CARGADOS
**Propósito:** Registro histórico de cada archivo XLS importado.

| Col | Campo | Descripción |
|-----|-------|-------------|
| A | id_archivo | UUID único del archivo |
| B | nombre_archivo | Nombre del XLS |
| C | fecha_carga | Timestamp ISO |
| D | tamaño | Tamaño en MB/KB |
| E | mes_archivo | Mes del archivo (Enero, Febrero...) |
| F | año_archivo | Año del archivo |
| G | municipio | Municipio detectado |
| H | departamento | Departamento detectado |
| I | institucion | Institución detectada |
| J | total_registros | Total de dosis guardadas |
| K | en_ciclo | Dosis dentro del contrato |
| L | fuera_ciclo | Dosis fuera del contrato |
| M | estado | OK / PROCESANDO / ERROR |

---

## Hoja: ALIAS_VACUNADORAS
**Propósito:** Mapa de normalización de nombres de vacunadoras.  
**Uso:** Cuando una vacunadora aparece con múltiples variantes de nombre en los XLS.

| Col | Campo | Descripción | Ejemplo |
|-----|-------|-------------|---------|
| A | alias_raw | Nombre tal como aparece en los datos | `VIRGELINA` |
| B | nombre_canonical | Nombre canónico oficial | `VIRGELINA PICON` |
| C | fecha_creacion | Cuándo se creó el alias | `2026-03-15T...` |

---

## Hoja: VALORES_BIOLOGICOS
**Propósito:** Define la meta mensual y el valor por dosis para cada ciclo del contrato.  
**Efecto:** Cambia los cálculos de liquidación en tiempo real.

| Col | Campo | Descripción | Ejemplo |
|-----|-------|-------------|---------|
| A | ciclo | Clave del ciclo | `2M-Penta` |
| B | biologico_label | Etiqueta legible | `Pentavalente 2 meses` |
| C | meta | Meta mensual de dosis | `11` |
| D | valor_unitario | Valor por dosis en COP | `8000` |

**Ciclos definidos (29 total):**
```
2M-Polio, 2M-Penta, 2M-Rota, 2M-Neumo
4M-Polio, 4M-Penta, 4M-Rota, 4M-Neumo
6M-Polio, 6M-Penta, 6M-Influ, 7M-Influ
1A-HepA, 1A-Varicela, 1A-TripleViral, 1A-FA, 1A-Neumo
18M-Penta, 18M-Polio, 18M-TripleViral
5A-DPT, 5A-PolioOral, 5A-PolioInyec, 5A-Varicela
COVID, VPH, InfluAdultos, RN-BCG, RN-HepB
```

---

## Hoja: ASIGNACIONES_MUNICIPIO
**Propósito:** Asigna a cada vacunadora (por nombre canónico) su municipio de trabajo.  
**Efecto:** Permite filtrar y analizar por municipio incluso cuando el XLS no trae esa información.

| Col | Campo | Descripción |
|-----|-------|-------------|
| A | vacunadora_canonical | Nombre canónico de la vacunadora |
| B | municipio_asignado | Municipio donde trabaja |
| C | departamento | Departamento |
| D | notas | Vereda, corregimiento, notas adicionales |

---

## Hoja: PARAMETROS
**Propósito:** Configuración general del sistema.

| Clave | Valor por defecto |
|-------|-------------------|
| schema_version | 1.2 |
| institucion | ESE Hospital Regional Noroccidental - PAI |
| municipio | Abrego |
| departamento | Norte de Santander |
| contrato | CPSESEHRNO-0064-2026 |

---

## Regla de liquidación

```
Para cada vacunadora y cada ciclo:
  dosis_en_meta  = MIN(dosis_aplicadas, meta_mensual)
  dosis_fuera    = MAX(0, dosis_aplicadas - meta_mensual)
  valor_pagado   = dosis_en_meta × valor_unitario
  valor_fuera    = dosis_fuera × valor_unitario  (referencia, NO se paga)

Subtotal vacunadora = SUM(valor_pagado por todos los ciclos)
Subtotal máximo contrato CPSESEHRNO-0064-2026 = $2.232.000/mes
```
