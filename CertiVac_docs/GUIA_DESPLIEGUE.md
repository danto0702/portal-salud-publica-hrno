# Guía de Despliegue — CertiVac v5.2

## Requisitos previos

- Cuenta de Google (Gmail o Google Workspace)
- Navegador Chrome o Edge (recomendado)
- Archivos XLS del sistema PAI colombiano (Registros Diarios de Vacunación)

---

## PASO 1 — Crear la base de datos en Google Sheets

1. Abrir Google Drive → "+ Nuevo" → "Subir archivo"
2. Subir `CertiVac_BD_Template.xlsx`
3. Hacer clic derecho sobre el archivo → **"Abrir con Google Sheets"**
4. Guardar como Google Sheets (Archivo → Guardar como Google Sheets)
5. Renombrar el archivo como `CertiVac-PAI`

**El archivo tiene 4 hojas de referencia:**
- `INSTRUCCIONES` — guía de uso
- `REGISTROS_PAI` — fila de ejemplo (Apps Script la reemplaza con datos reales)
- `ARCHIVOS_CARGADOS` — registro de archivos importados
- `PARAMETROS` — configuración del sistema

---

## PASO 2 — Crear el backend en Apps Script

1. En el Google Sheets creado: **Extensiones → Apps Script**
2. Eliminar todo el contenido del editor (Ctrl+A → Suprimir)
3. Abrir el archivo `backend/Codigo_Backend.gs` con cualquier editor de texto
4. Copiar TODO el contenido (Ctrl+A → Ctrl+C)
5. Pegarlo en el editor de Apps Script (Ctrl+V)
6. Guardar (Ctrl+S) — dar nombre al proyecto: `CertiVac-API`

---

## PASO 3 — Inicializar las hojas

1. En Apps Script, seleccionar la función `setupInicial` en el menú desplegable
2. Hacer clic en **▶ Ejecutar**
3. Autorizar los permisos cuando se solicite (necesario para leer/escribir el Sheets)
4. Verificar el mensaje de confirmación: **"✅ CertiVac v5.2 inicializado"**

**Esto crea automáticamente las hojas:**
- `REGISTROS_PAI` — una fila por dosis aplicada
- `ARCHIVOS_CARGADOS` — historial de archivos
- `PARAMETROS` — configuración
- `ALIAS_VACUNADORAS` — unificación de nombres
- `VALORES_BIOLOGICOS` — valores y metas por ciclo
- `ASIGNACIONES_MUNICIPIO` — vacunadora → municipio

---

## PASO 4 — Publicar como aplicación web

1. En Apps Script: **Implementar → Nueva implementación**
2. Clic en ⚙️ junto a "Tipo" → seleccionar **"Aplicación web"**
3. Configurar:
   - **Descripción:** CertiVac PAI v5.2
   - **Ejecutar como:** Yo (tu cuenta de Google)
   - **Quién tiene acceso:** Cualquier usuario, incluso anónimos
4. Clic en **"Implementar"**
5. Autorizar permisos nuevamente si se solicita
6. **Copiar la URL** generada (formato: `https://script.google.com/macros/s/AKfycbx.../exec`)

> ⚠️ IMPORTANTE: Guardar esta URL — es la que conecta el frontend con la base de datos

---

## PASO 5 — Configurar y usar el frontend

1. Abrir `frontend/index.html` en Chrome/Edge (doble clic o arrastrar al navegador)
2. En el sidebar izquierdo: **⚙️ Configuración API**
3. Pegar la URL copiada en el paso 4
4. Clic en **"💾 Guardar y conectar"**
5. Verificar que aparece **"✅ Conexión establecida"**

---

## PASO 6 — Cargar el primer archivo PAI

1. Sidebar → **📂 Cargar Archivos**
2. Arrastrar un archivo XLS de Registros Diarios de Vacunación
3. El sistema parsea el archivo localmente y envía los datos a Google Sheets
4. Verificar en **🗂️ Historial de Archivos** que aparece el archivo con estado "OK"

---

## Actualización de versiones

Cuando se entregue una nueva versión del código:

1. En Apps Script: **Implementar → Administrar implementaciones**
2. Clic en ✏️ editar → cambiar versión a "Nueva versión"
3. Clic en **"Implementar"** — la URL NO cambia
4. Reemplazar `index.html` con la nueva versión

> La URL del API es permanente — no cambia entre versiones, solo cambia si se elimina la implementación.

---

## Solución de problemas comunes

| Problema | Causa | Solución |
|---|---|---|
| "Failed to fetch" | URL mal configurada o sin permisos | Re-publicar con acceso "Cualquier usuario" |
| "No se encontró archivo index" | Apps Script intenta servir HTML inexistente | Actualizar `Codigo_Backend.gs` a v5.2 |
| Gráficas en cero | Fechas en formato incorrecto en BD | Borrar registros y re-cargar los XLS |
| Error al guardar alias | Sheets no puede eliminar filas congeladas | Actualizar backend (ya corregido en v5.2) |
| Datos de ejemplo en gráficas | Fila de ejemplo en REGISTROS_PAI | Borrar fila 2 manualmente en el Sheets |
