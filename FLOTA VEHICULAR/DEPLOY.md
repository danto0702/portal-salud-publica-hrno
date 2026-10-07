# DEPLOY.md — Flota Vehicular HRNO

> Estado al 11 sep 2026

---

## Lo que ya está hecho

| Paso | Estado |
|------|--------|
| Base de datos D1 creada en la cuenta de Cloudflare | ✅ `flota-hrno`, región ENAM |
| Esquema aplicado (23 tablas, 17 índices) | ✅ |
| Catálogos cargados (6 municipios, 17 destinos, 7 parámetros) | ✅ |
| `database_id` configurado en `worker/wrangler.toml` | ✅ |
| Código del Worker escrito y probado (76 verificaciones) | ✅ |
| **Publicar el Worker** | ⬜ pendiente — requiere el comando de abajo |

**Identificador de la base**: `b8b1f6ff-add1-446e-be38-3eec7fcb333c`

---

## Publicar el Worker

Desde la carpeta `FLOTA VEHICULAR/worker`, en el computador donde está el repositorio:

```bash
cd "FLOTA VEHICULAR/worker"

# 1. Iniciar sesión en Cloudflare (abre el navegador una sola vez)
npx wrangler login

# 2. Definir la clave de instalación. NO queda en el repositorio.
#    Pide el valor por consola; escribir una clave larga y guardarla.
npx wrangler secret put CLAVE_ADMIN_INICIAL

# 3. Publicar
npx wrangler deploy
```

El comando imprime la URL del servicio, con esta forma:

```
https://flota-hrno.<su-subdominio>.workers.dev
```

Esa URL es la que el frontend usa como `API_BASE`.

### Verificar que quedó vivo

```bash
curl https://flota-hrno.<su-subdominio>.workers.dev/api/salud
```

Debe responder algo como:

```json
{"ok":true,"servicio":"flota-hrno","rutas":41,"ts":"2026-09-11T05:40:00Z"}
```

---

## Crear el primer usuario principal

Se hace una sola vez. Después queda cerrado para siempre: si alguien vuelve a
llamar esta ruta, responde `409` aunque tenga la clave de instalación. Es
deliberado — evita que alguien se cree un administrador más adelante.

```bash
curl -X POST https://flota-hrno.<su-subdominio>.workers.dev/api/instalar \
  -H "Content-Type: application/json" \
  -d '{
        "clave_instalacion": "LA_CLAVE_DEL_PASO_2",
        "usuario": "danilo",
        "correo": "danto0702@gmail.com",
        "clave": "UnaClaveLargaYPropia"
      }'
```

El sistema exige cambiar esa clave en el primer ingreso.

Desde ahí, **todos los demás usuarios se crean desde la aplicación**, y solo el
rol principal puede hacerlo.

---

## Autorizar el dominio del frontend

`worker/wrangler.toml` trae la lista de orígenes permitidos:

```toml
ORIGENES_PERMITIDOS = "https://danto0702.github.io,http://localhost:8788,http://127.0.0.1:5500"
```

Si la aplicación se publica en otro dominio, agregarlo ahí y volver a ejecutar
`npx wrangler deploy`. Un origen que no esté en la lista recibe un bloqueo de
CORS del navegador.

---

## Probar sin desplegar

La suite de pruebas corre el Worker real contra una base SQLite en memoria, sin
tocar Cloudflare ni gastar peticiones:

```bash
node pruebas/prueba_api.mjs
```

Recorre el flujo completo: instalación, ingreso, los tres roles, adjudicación de
desplazamientos, marcación con GPS, checklist de 9 ítems, días pagables,
sincronización sin señal y dashboard. Conviene ejecutarla antes de cada deploy.

La misma suite contra el archivo que se pega en Cloudflare, para que no se
publique un paquete viejo:

```bash
node pruebas/prueba_bundle.mjs
```

Y la de instalación en el teléfono, que abre un navegador de verdad, corta la red
y comprueba que la aplicación siga abriendo:

```bash
node pruebas/prueba_pwa.mjs
```

Esta última necesita Playwright (`npm i -g playwright`); si no está, hace igual
las comprobaciones de archivos y se salta las de navegador. **No toca el Worker**,
así que basta con ejecutarla cuando se cambien `manifest.json`, `sw.js`, los
iconos o la pantalla de ingreso.

Y la del itinerario en el celular, que programa traslados con un navegador de
verdad a 412 px de ancho —adjudica, mueve sin arrastrar, pinta con un
predeterminado— y comprueba de paso que el arrastre con el ratón del escritorio
siga funcionando:

```bash
node pruebas/prueba_movil.mjs
```

Y la de la pantalla de Viajes, que recorre el período libre, los filtros, la
ficha de un viaje y la descarga:

```bash
node pruebas/prueba_viajes.mjs
```

Y la de los días fuera de servicio, que registra un período, comprueba que los
días marcados se vean en la matriz y que el conductor pueda declarar su vehículo
averiado desde el teléfono:

```bash
node pruebas/prueba_averias.mjs
```

También necesita Playwright, y se salta entera si no está. Ejecútela al tocar la
pantalla de itinerario: su matriz es la misma en el computador y en el teléfono,
así que un retoque pensado para uno puede romper el otro.

---

## Operaciones sobre la base

```bash
# Consultar
npx wrangler d1 execute flota-hrno --remote \
  --command "SELECT placa, propiedad, valor_dia FROM vehiculos"

# Respaldo a archivo local
npx wrangler d1 export flota-hrno --remote --output respaldo.sql

# Recrear desde cero (BORRA TODO)
npx wrangler d1 execute flota-hrno --remote --file schema.sql
npx wrangler d1 execute flota-hrno --remote --file seed_catalogos.sql
```

> Conviene programar un respaldo periódico: la capa gratuita de D1 no incluye
> restauración a un punto en el tiempo.

---

## Diagnóstico

`GET /api/diag` informa, sin exponer ningún secreto, si existe el enlace `DB`,
si una consulta real funciona, qué variables están definidas y qué números de
iteraciones acepta PBKDF2 en el runtime. Es el primer sitio donde mirar cuando
la aplicación responde 500.

### Límites del runtime que no aparecen en las pruebas locales

| Límite | Detalle |
|--------|---------|
| **PBKDF2: máximo 100.000 iteraciones** | Workers responde `Pbkdf2 failed: iteration counts above 100000 are not supported`. Node no tiene ese tope, así que la suite pasa igual y el fallo solo sale en producción. Ver `ITERACIONES` en `src/lib.js`. |

Las variables de entorno se leen tal como se pegaron en el panel: un espacio o
un tabulador de más queda guardado. `Number()` los ignora, pero conviene
revisarlos en `/api/diag` si algo no cuadra.

---

## Carga de conductores y vehículos

Los datos personales **no están en el repositorio** y no deben agregarse
(ver `PROJECT.md` §4.4). Se cargan desde la pantalla de administración de la
aplicación, con la plantilla de importación, o directamente:

```bash
npx wrangler d1 execute flota-hrno --remote --file mi_carga_local.sql
```

donde `mi_carga_local.sql` es un archivo que **no se versiona**.

Recordatorio del archivo `CONDUCTORES_EBS.xlsx`: 5 de los 13 conductores no
tienen cédula ni teléfono registrados. Sin cédula no se puede crear su usuario
ni firmar la planilla.

---

## Endpoints disponibles

| Método | Ruta | Roles |
|--------|------|-------|
| GET | `/api/salud` | público |
| POST | `/api/instalar` | irrepetible |
| POST | `/api/auth/login` · `/logout` · `/cambiar-clave` | según el caso |
| GET | `/api/auth/yo` | los tres |
| GET | `/api/catalogos` | los tres |
| POST/PUT | `/api/catalogos/municipios` | principal |
| POST | `/api/catalogos/destinos` | principal, coordinación |
| DELETE | `/api/catalogos/destinos/:id` | principal *(desactiva)* |
| GET | `/api/vehiculos` | los tres |
| POST/PUT | `/api/vehiculos` | principal |
| GET | `/api/personas` | principal, coordinación |
| POST/PUT | `/api/personas` | principal |
| GET/POST/PUT | `/api/usuarios` | **principal exclusivo** |
| GET | `/api/itinerario` | los tres *(el conductor solo el suyo)* |
| POST/PUT/DELETE | `/api/itinerario` | principal, coordinación |
| GET | `/api/itinerario/:id/cambios` | los tres |
| POST | `/api/itinerario/copiar` | principal, coordinación |
| GET | `/api/mi-dia` | los tres |
| POST | `/api/trayectos/salida` | los tres |
| POST | `/api/trayectos/:id/llegada` | los tres |
| PUT | `/api/trayectos/:id` | principal, coordinación *(exige motivo)* |
| GET | `/api/trayectos` | los tres *(el conductor solo los suyos)* |
| POST | `/api/sync` | los tres |
| GET/POST | `/api/checklists` | los tres |
| GET/POST | `/api/eventos` | los tres |
| PUT | `/api/eventos/:id` | principal, coordinación |
| GET | `/api/dias` | principal, coordinación |
| PUT | `/api/dias/:id` | principal *(exige motivo)* |
| GET | `/api/dashboard` | principal, coordinación |
| GET | `/api/auditoria` | principal |
| GET | `/api/parametros` | principal, coordinación |
| PUT | `/api/parametros/:clave` | principal |

---

## Parámetros configurables

Se editan desde la aplicación (rol principal) o con `PUT /api/parametros/:clave`:

| Clave | Valor actual | Qué hace |
|-------|--------------|----------|
| `checklist_bloquea_salida` | `advertir` | `bloquear` impide salir si falta un ítem |
| `dia_disponible_es_pagable` | `1` | Un día en base se paga igual **(decisión D11)** |
| `gps_obligatorio` | `1` | Exige coordenadas en salida y llegada |
| `gps_precision_maxima_m` | `100` | Por encima, la marca se señala como dudosa |
| `dias_alerta_vencimiento` | `30` | Anticipación del semáforo amarillo |
| `umbral_discrepancia_dias` | `0` | Tolerancia entre días de la app y del soporte firmado |
| `correo_alertas` | *(vacío)* | Destinatarios de las alertas |
