# Historial de Versiones — CertiVac

## v5.2 (Abril 2026) — versión actual
- **FIX CRÍTICO:** Error "No se encontró archivo HTML index" en trazadores → `doGet` ahora blindado
- **FIX:** Error "No se pueden eliminar filas no inmovilizadas" en alias/valores/asignaciones → `limpiarHojaDatos()` con `clearContent()`
- Acceso seguro a `e.parameter` en todas las funciones API (previene NullPointerException)
- Módulo 🔬 Trazadores PAI: filtros propios de municipio, mes y año
- Módulo 💵 Liquidaciones: filtros propios de año y mes con selectores automáticos

## v5.1 (Marzo 2026)
- **FIX CRÍTICO:** Gráficas mostraban datos en cero → `esRegistroReal()` excluye fila de ejemplo
- **FIX CRÍTICO:** Campo `dia` llegaba como número "2" sin año/mes → `construirFecha()` reconstruye `YYYY-MM-DD`
- Módulo 🔬 Trazadores PAI con 6 trazadores según normativa vigente
- Módulo 👥 Unificar Vacunadoras también aplica en liquidaciones
- Módulo 📍 Vacunadora → Municipio (nueva hoja ASIGNACIONES_MUNICIPIO)
- Filtro de mes en Gráficas & Análisis
- `normalizarFecha()` maneja objetos Date, seriales Excel, ISO con hora, DD/MM/YYYY

## v5.0 (Febrero 2026)
- **NUEVO:** Backend en Google Apps Script + Google Sheets como BD persistente
- **NUEVO:** Panel ⚙️ Configuración API con URL guardada en localStorage
- Módulo 👥 Unificar Vacunadoras con normalización histórica
- Módulo 💲 Editar Valores/Metas por ciclo
- Módulo 📈 Gráficas & Análisis con 6 pestañas (vacunadora, biológico, ciclo, municipio, tendencia, ranking)
- Agrupaciones: día, semana, mes, trimestre, semestre, año
- Filtros cruzados en analytics
- Exportación a Excel (4 opciones)
- POST como form-urlencoded para evitar preflight CORS en Apps Script
- Lotes de 200 registros para archivos grandes

## v4.0 (Noviembre 2025)
- Módulo de análisis y gráficas con Chart.js
- Exportación a Excel con SheetJS
- Certificado editable: período, contrato, firmas

## v3.0 (Septiembre 2025)
- Multi-archivo (múltiples XLS simultáneos)
- Identificación automática de ciclo por edad+biológico+dosis
- Certificado con doble subtotal (en meta / fuera de meta)

## v2.0 (Agosto 2025)
- ETL completo para las 3 hojas del XLS PAI colombiano
- Liquidación por vacunadora con contrato CPSESEHRNO-0064-2026

## v1.0 (Julio 2025)
- Primera versión funcional
- Carga de archivo XLS, tabla de liquidación, certificado básico
