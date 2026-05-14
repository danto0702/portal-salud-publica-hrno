# Guía de Módulos — CertiVac v5.2
## Manual de uso para el coordinador PAI

---

## 📊 Dashboard General

Pantalla de inicio con resumen general:
- **Dosis en BD** — total de dosis registradas en Google Sheets
- **Vacunadoras** — personal activo detectado
- **Archivos en BD** — XLS importados
- **A Pagar (en meta)** — subtotal de liquidación del período seleccionado
- **Fuera de Meta** — dosis aplicadas que superan la meta (no se pagan)

El selector **"Todos los períodos"** en la barra superior filtra todas las vistas.

---

## 📂 Cargar Archivos

Importa archivos XLS del sistema PAI colombiano:
1. Arrastrar el archivo o hacer clic para seleccionar
2. El sistema detecta automáticamente: municipio, mes, año, institución
3. Parsea las 3 hojas: Niños y Niñas, Adultos, Recién Nacidos
4. Envía los datos a Google Sheets en lotes de 200

**Archivos soportados:** `.xls` y `.xlsx` del Registro Diario de Vacunación del MSPS colombiano.

> ⚠️ Si el mismo archivo ya fue cargado, el sistema lo rechaza automáticamente.

---

## 🗂️ Historial de Archivos

Lista todos los archivos cargados en la BD con:
- Fecha y hora de carga
- Período del archivo
- Total de registros, dosis en ciclo, dosis fuera de ciclo
- Botón 🗑️ para eliminar el archivo y todos sus registros

---

## 💵 Liquidaciones

Calcula el pago mensual para cada auxiliar de vacunación.

**Filtros disponibles:**
- **Año** — filtrar por año
- **Mes** — filtrar por mes específico

**Columnas:**
| Columna | Descripción |
|---------|-------------|
| Dosis aplicadas | Total de dosis registradas |
| En meta | MIN(aplicadas, meta_mensual) |
| Fuera meta | Excedente sobre la meta |
| Eficiencia | % de cumplimiento |
| A Pagar | Valor a liquidar en COP |
| Fuera (ref.) | Valor fuera de meta (NO se paga) |

**Botón 📄 Cert.** — genera el certificado de liquidación individual.

### Certificado de liquidación
El certificado muestra el detalle completo por ciclo del contrato.

**Campos editables antes de imprimir:**
- Período (ej: "Marzo 2026")
- Número de contrato
- Nombre y CC de la vacunadora
- Nombre, cargo y CC del coordinador

**Acciones:** 🖨️ Imprimir | ⬇️ Descargar PDF

---

## 🎯 Tabla de Metas

Muestra el contrato completo con todas las metas por ciclo y el subtotal máximo de vacunación. Referencia para el contrato CPSESEHRNO-0064-2026.

---

## 📈 Gráficas & Análisis

### Filtros disponibles
- **Agrupar por:** Día / Semana / Mes / Trimestre / Semestre / Año
- **Vacunadora** — filtrar por auxiliar específica
- **Municipio** — filtrar por municipio
- **Mes** — filtrar por mes
- **Año** — filtrar por año
- **Desde / Hasta** — rango de fechas exacto

### Pestañas de análisis

#### 👩‍⚕️ Por Vacunadora
- Línea de evolución temporal por vacunadora
- Barras de total de dosis
- Torta de distribución porcentual
- Tabla pivot completa

#### 💉 Por Biológico
- Barras de dosis por biológico (de mayor a menor)
- Evolución de los 5 biológicos más aplicados
- Tabla por biológico y período

#### 🎯 Por Ciclo de Edad
- Barras y dona por ciclo (2 meses, 4 meses... 5 años, COVID, VPH)
- Evolución temporal de ciclos
- Tabla por ciclo y período

#### 📍 Por Municipio
- Barras de dosis por municipio
- Evolución temporal por municipio

#### 📅 Tendencia Diaria
- Gráfica de área con tendencia diaria
- Barras de volumen diario

#### 🔬 Trazadores PAI
*(Ver sección dedicada abajo)*

#### 🏆 Ranking
- Ranking horizontal de vacunadoras por dosis en meta
- Curva comparativa de todas las vacunadoras
- Tabla de posiciones con medallas 🥇🥈🥉

---

## 🔬 Trazadores PAI

Análisis de los biológicos indicadores del PAI colombiano:

| Cohorte | Trazador | Propósito |
|---------|----------|-----------|
| Recién Nacidos | BCG | Captación institucional al nacer |
| Menores 1 año | Pentavalente 3ª dosis | Esquema básico completado |
| Menores 1 año | Polio 3ª dosis | Esquema primario de polio completo |
| Niños 1 año | Triple Viral SRP 1ª | Indicador OPS/OMS (sarampión, rubéola) |
| Niños 5 años | DPT 2° refuerzo | Cierre de esquema primera infancia |
| Niños 5 años | Polio 2° refuerzo | Complemento del cierre |

> **Nota normativa:** La 2ª dosis de SRP se adelantó a 18 meses. Para 5 años, el trazador vigente es DPT + Polio.

**Filtros propios:** Municipio / Mes / Año (independientes de los filtros globales)

**Visualizaciones:** Stats cards, radar comparativo, línea temporal, barras, torta, tabla detallada

---

## 👥 Unificar Vacunadoras

Normaliza variantes de nombre de una misma vacunadora:

1. Los nombres únicos en la BD aparecen como etiquetas
2. Clic en cualquier nombre para pre-asignarlo como alias
3. Columna izquierda: variación (como aparece en los datos)
4. Columna derecha: nombre canónico oficial
5. **💾 Guardar todos los alias** — guarda en Google Sheets
6. **⚡ Normalizar en Google Sheets** — aplica los aliases a TODOS los registros históricos

---

## 📍 Vacunadora → Municipio

Asigna manualmente el municipio de trabajo de cada vacunadora:

- **Prioridad:** Asignación manual > Municipio del archivo XLS
- Los filtros por municipio en Analytics y Trazadores usan esta asignación
- Campos: Municipio, Departamento, Notas/Localidad

---

## 💲 Editar Valores/Metas

Permite modificar la meta mensual y el valor por dosis de cada ciclo:

- Editar la cantidad en el campo "Meta mensual"
- Editar el valor en el campo "Valor por dosis ($)"
- El "Valor Total máximo" se recalcula en tiempo real
- **💾 Guardar** aplica a todas las liquidaciones futuras

---

## ⬇️ Exportar Excel

Descarga los datos como archivo `.xlsx`:

| Opción | Contenido |
|--------|-----------|
| Registros Completos | Una fila por dosis con todos los campos |
| Liquidación | Resumen por vacunadora |
| Análisis por Período | Pivots por vacunadora, biológico y ciclo |
| Libro Completo | Todas las hojas anteriores + Tabla de Metas |

---

## ⚙️ Configuración API

Panel para conectar el frontend con el backend:

1. Pegar la URL de Apps Script
2. **💾 Guardar y conectar** — valida la conexión
3. **🔌 Probar** — diagnóstico detallado con log de respuesta
4. La URL se guarda en `localStorage` del navegador (persiste entre sesiones)
