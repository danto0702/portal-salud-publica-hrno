# PROJECT.md — Flota Vehicular HRNO

> Borrador v1.1 · 16 sep 2026 · ESE Hospital Regional Noroccidental
> Responsable: Danilo Torrado Blanco — Coordinador de Salud Pública
> Estado: **arquitectura, roles y modelo de datos definidos.** Pendientes las preguntas de §11

---

## 1. Qué es

Aplicación **independiente** del Portal de Salud Pública para administrar la operación de los
vehículos del HRNO que trabajan bajo la figura de **Misión Médica** (protegidos por el DIH y la
Resolución 4481 de 2012).

Sustituye la matriz de Excel que hoy se usa para programar conductores (`CONDUCTORES_EBS.xlsx`)
por un **itinerario digital** con historial de cambios, y le agrega la capa que el Excel no puede
dar: la **ejecución real marcada por el conductor desde el celular con GPS**.

Cubre inventario de vehículos y conductores, itinerario semanal, trayectos con hora y coordenadas
de salida y llegada, **contabilizador de días de operación para liquidar el pago por día**,
bitácora de eventos, **checklist de distintivos y elementos**, generación e impresión de la
**planilla de tiempos para firma**, validación del soporte firmado y un **dashboard interactivo**
para comparar el desempeño entre vehículos.

El eje conceptual de toda la aplicación es la relación entre dos capas:

| Capa | Quién la produce | Para qué sirve |
|------|------------------|----------------|
| **Programado** — el itinerario | Coordinación | Planear el territorio y saber quién debía ir a dónde |
| **Ejecutado** — los trayectos | El conductor, en vivo, con GPS | Probar qué pasó realmente |

El contador de días, la planilla firmada y la liquidación salen de **contrastar ambas capas**.
Sin esa comparación la herramienta sería un Excel más bonito.

### Ubicación en el repositorio

```
portal-salud-publica-hrno/
└── FLOTA VEHICULAR/
    ├── index.html          ← aplicación (SPA, HTML/JS vanilla, PWA)
    ├── sw.js               ← service worker (offline)
    ├── manifest.json
    ├── worker/             ← backend Cloudflare (Worker + esquema D1)
    ├── PROJECT.md          ← este documento
    ├── AI.md               ← detalle técnico
    └── DESIGN.md           ← sistema visual
```

Se registra como un módulo más en `index.html` y en `index_Principal_Salud_Publica.html`.

---

## 2. Decisiones tomadas

| # | Decisión | Valor |
|---|----------|-------|
| D1 | Backend | **Cloudflare Workers + D1** (SQL en el borde, gratis, sin tarjeta) |
| D2 | Relación con el módulo de Misión Médica | **Ninguna.** Aplicación autónoma, sin leer ni escribir tablas `mm_*`, sin Supabase |
| D3 | Catálogos (municipios, IPS, personas) | **Propios y duplicados** dentro de esta aplicación |
| D4 | Checklist | **5 distintivos por posición del vehículo + 4 elementos adicionales** (ver §5.4) |
| D5 | Captura de tiempos | **El conductor marca en vivo desde el celular**, con hora del servidor y GPS |
| D6 | Escala | **Sin límites fijos** de conductores, vehículos ni traslados por día |
| D7 | Pago | **Por día de operación**, con campo `propiedad` = propio / contratista / comodato y tarifa por día |
| D8 | Planilla de tiempos | **No existe formato oficial**: la aplicación lo genera, imprimible y con espacio de firma |
| D9 | Roles | Tres: **principal**, **coordinación** y **conductor** (matriz en §5.12) |
| D10 | Itinerario | Módulo de primer nivel, reemplaza `CONDUCTORES_EBS.xlsx`, con historial visible de cambios |
| D11 | Día disponible | **Se paga igual** que un día con desplazamiento (`dia_disponible_es_pagable = 1`) |
| D12 | Destinos | **Catálogo vivo**: el municipio se registra al adjudicar el desplazamiento y el destino queda guardado para autocompletar |
| D13 | Territorio del conductor | Su municipio es **base por defecto, nunca restricción**: puede desplazarse a cualquier municipio |
| D14 | San Pablo | Se muestra con **su propio nombre**, con `municipio_padre_id` → Teorama. Catálogo editable |
| D15 | Borrar programaciones | Coordinación **cancela**; solo el administrador **borra**. Ninguno puede tocar un día con viajes registrados |
| D16 | Arrastrar | Mover con arrastre, duplicar con Ctrl. Soltar sobre una celda ocupada **intercambia** las dos |
| D17 | Predeterminados | Banco de combinaciones con nombre propio, que además son los valores válidos de la plantilla de Excel |
| D18 | Plantilla de Excel | Matriz como el archivo original, con fechas ISO, lista desplegable y **vista previa antes de aplicar** |
| D19 | Móvil | Página adaptable e **instalable** en Android e iPhone. No hay apps de tienda. El itinerario se **programa igual desde el celular**: la misma matriz, desplazable de lado, y un botón que cambia a una vista de un día con todos los vehículos |
| D20 | Banner | Imagen 2000 × 289 configurable en Ajustes, presente en el ingreso, el encabezado y el PDF. Se guarda en la base, redimensionada en el navegador |
| D21 | PDF | Todo el período en **una sola hoja**, con el tamaño de papel elegido según cuántos días haya |
| D22 | Cuentas de conductor | **Obligatorio** vincularlas a una persona: es lo que las conecta con el itinerario |
| D23 | Sincronización | Botón *Actualizar* y revisión automática cada 45 s mediante un sello del estado de los datos |
| D24 | Datos de la marca | Kilometraje, número **y nombres** de tripulantes y **fotografía** son obligatorios |
| D25 | Día operativo | Se calcula en **hora de Colombia**, no en UTC |
| D26 | Fotografía | Se toma con **Timemark** (app externa que estampa fecha, hora y GPS). La app, su identificador y si se usa son configurables en Ajustes |
| D27 | Instalación | **PWA instalable desde el navegador**, sin Play Store ni App Store. Iconos PNG propios, arranque sin señal y aviso cuando hay versión nueva |
| D28 | Permiso de ubicación | Si el conductor lo bloquea por error, la aplicación lo detecta, ofrece un botón y explica los pasos de su teléfono. **La marca se guarda igual, señalada sin GPS** |
| D29 | Sin señal | La aplicación **abre y es usable sin ninguna señal**. Copia local en IndexedDB de catálogos, parámetros, vehículos y el día; la cola guarda las marcas **con su fotografía** |
| D30 | Itinerario del conductor | Pantalla propia, **solo de consulta**, con su programación de los próximos días. El filtro por conductor lo hace el **servidor**, no la pantalla |
| D31 | Contador de días | Cuenta los días programados de **toda la operación**, no los del período visible. Se calcula en el servidor (`/api/itinerario/resumen`) |
| D32 | Mover sin arrastrar | Además del arrastre, la ventana de la programación lleva **día y vehículo de destino**. Con el dedo el arrastre exige sostener 350 ms y soltar sobre una celda que suele estar fuera de pantalla |

Consecuencia de D5: la aplicación nace como **PWA con cola offline** desde la primera fase.
No es un añadido posterior — en zona rural del Catatumbo, sin ella el registro en vivo no funciona.

Consecuencia de D2 y D3: lo único que se reutiliza del resto del repositorio es **código y
patrones**, nunca datos: `libs/chart.umd.min.js`, `libs/jspdf.umd.min.js`, `libs/xlsx.full.min.js`,
el patrón de service worker del Buscador CUPS y el estilo institucional del portal.

Consecuencia de D6: ninguna pantalla asume un número fijo de filas. El itinerario es una tabla
que crece, no una cuadrícula de 13 × 13 como el Excel actual; un vehículo puede registrar los
trayectos que necesite en un mismo día.

---

## 3. Arquitectura

```
Navegador / celular (PWA, HTML + JS vanilla, GitHub Pages)
   │
   ├── IndexedDB  ──► cola offline de marcas de tiempo y checklists
   │                   (se sincroniza automáticamente al recuperar señal)
   │
   ├── fetch JSON ──► Cloudflare Worker ──► D1 (SQLite)
   │                        │                  datos operativos
   │                        ├── autenticación por token + rol
   │                        ├── hora del servidor para cada marca
   │                        └── escritura en tabla de auditoría
   │
   └── subida de archivos ──► Apps Script "Flota HRNO" ──► Google Drive + Gmail
                                (proyecto nuevo, independiente del MM V13)
```

**Por qué Cloudflare Workers + D1**

1. SQL real: el ranking de vehículos, los promedios por etapa de tiempo y el contador de días
   se calculan en el servidor con `GROUP BY`, no trayendo todo al navegador.
2. Latencia de decenas de milisegundos (hay punto de presencia en Bogotá) — el conductor pulsa
   "salí de base" y la marca queda registrada al instante.
3. Capa gratuita sin tarjeta de crédito: ~100.000 peticiones/día en Workers, 5 GB en D1.
   El volumen esperado está órdenes de magnitud por debajo.
4. No hay proyecto que se pause por inactividad.

**Por qué los archivos van a Drive y no a R2**: Cloudflare R2 exige registrar un medio de pago
aunque la capa sea gratuita. Drive no, y además deja los soportes firmados donde el equipo
administrativo ya sabe buscarlos para auditoría y para el trámite de pago.

> Los límites de capa gratuita cambian con el tiempo. Verificar las cifras al crear la cuenta.

---

## 4. Modelo de datos

El esquema completo y ejecutable está en **[`worker/schema.sql`](worker/schema.sql)** (440 líneas,
SQLite/D1). Los catálogos no personales ya extraídos del archivo de conductores están en
**[`worker/seed_catalogos.sql`](worker/seed_catalogos.sql)**. Resumen de los diez grupos:

| Grupo | Tablas | Qué resuelve |
|-------|--------|--------------|
| Catálogos | `cat_municipios`, `cat_destinos`, `cat_ips` | Propios de esta app (D3) |
| Personas | `personas`, `documentos_persona` | Conductores y tripulación, con vigencias |
| Vehículos | `vehiculos`, `documentos_vehiculo`, `asignaciones` | Ficha, propiedad, tarifa por día, SOAT/RTM |
| **Itinerario** | `itinerarios`, `itinerario_cambios` | La matriz del Excel + historial visible de quién cambió qué |
| **Trayectos** | `trayectos` | Salida y llegada marcadas en vivo, con GPS |
| Checklist | `checklists`, `checklist_items` | 5 distintivos + 4 elementos |
| Planilla | `planillas` | Generación, impresión, firma, carga y validación |
| Días y pago | `dias_operacion`, `liquidaciones` | Contador de días y liquidación mensual |
| Eventos | `eventos` | Bitácora de novedades |
| Logística | `mantenimientos`, `tanqueos` | Costos y disponibilidad |
| Gobierno | `usuarios`, `sesiones`, `auditoria`, `parametros` | Tres roles, trazabilidad, configuración |

### 4.1 Por qué `trayectos` tiene solo dos marcas

El conductor marca **salida** y **llegada** (D5), no seis hitos. Un día puede tener varios
trayectos: la ida a la vereda y el regreso a la base son dos registros, no uno con seis marcas.
Es más simple de operar en un celular y refleja cómo funciona realmente la ruta.

Cada marca guarda seis datos, no uno:

```
ts_salida          hora del SERVIDOR          ← la que vale
ts_salida_disp     hora del celular           ← referencia forense
origen_salida      en_linea | offline_sincronizado | digitado
lat_salida         latitud
lon_salida         longitud
precision_salida   metros reportados por el GPS
```

La hora del servidor es lo que hace defendible el registro: si valiera la del teléfono, bastaría
con cambiar la hora del dispositivo para alterar un soporte de pago. `precision_salida` importa
porque en zona montañosa el GPS puede reportar 500 m de error; por encima del umbral configurado
(`gps_precision_maxima_m`, por defecto 100 m) la marca se señala como dudosa en lugar de darla
por buena en silencio.

### 4.2 Por qué el itinerario tiene su propia tabla de cambios

`auditoria` registra todo técnicamente, pero coordinación necesita ver el historial **en la
pantalla del itinerario**, no en un log de sistema. `itinerario_cambios` guarda por cada celda
modificada el campo, el valor anterior, el nuevo, quién lo hizo, cuándo y el motivo — y se muestra
como un historial desplegable en la propia celda.

### 4.3 Catálogos vivos, no listas cerradas (D12, D13, D14)

Tres reglas que salieron de cómo opera realmente el territorio:

**El destino se crea al adjudicar, no antes.** Coordinación escribe el destino al asignar el
desplazamiento y elige su municipio en ese momento. Si ya se usó antes, aparece por autocompletado
ordenado por frecuencia (`veces_usado`, `ultimo_uso`); si es nuevo, se crea sobre la marcha. Los
17 destinos del archivo actual entran solo como semilla de ese autocompletado, con el municipio
sin asignar.

**Un destino usado nunca se borra.** Solo se desactiva (`activo = 0`). Si se eliminara, los
itinerarios y trayectos históricos que lo referencian quedarían apuntando al vacío y la
liquidación de meses anteriores dejaría de cuadrar.

**El municipio del conductor no restringe nada.** `personas.municipio_id` es únicamente el valor
que se propone por defecto al programar. Un conductor de Ábrego puede ir a El Carmen sin que el
sistema se lo impida ni lo marque como anomalía. Por eso `LA SIERRA` es un solo lugar aunque lo
atiendan conductores de tres bases distintas.

**San Pablo** se muestra con su propio nombre, como se usa en la práctica, y queda trazada su
pertenencia real a Teorama en `municipio_padre_id`. Municipios y destinos se editan desde la
pantalla de administración sin tocar código.

### 4.4 Datos personales fuera del repositorio

El archivo `CONDUCTORES_EBS.xlsx` trae nombres, cédulas, teléfonos y placas. **Nada de eso se
versiona en git.** Son datos personales bajo la Ley 1581 de 2012 y, en el contexto de Misión
Médica, identifican a personas expuestas en zona de conflicto junto con el vehículo y la vereda a
la que se dirigen. El repositorio es público y su propio README ya excluye los datos operativos
por esta razón.

Lo que sí quedó versionado es el catálogo no personal: 6 municipios y 17 destinos.
Los 13 conductores y sus 13 vehículos se cargan desde la pantalla de administración, en la fase 1,
con una plantilla de importación de estas columnas:

```
MUNICIPIO · TERRITORIO · NOMBRE · TIPO DOC · CÉDULA · TELÉFONO · PLACA ·
PROPIEDAD (propio/contratista) · CONTRATISTA · VALOR DÍA · TIPO VEHÍCULO
```

> En el archivo actual **5 de los 13 conductores no tienen cédula ni teléfono registrados**.
> Sin cédula no se puede crear su usuario ni firmar la planilla; conviene completarlos antes de
> la carga inicial.

---

## 5. Módulos funcionales

### 5.1 Itinerario (reemplaza `CONDUCTORES_EBS.xlsx`)

La misma vista de matriz que ya se usa —vehículo/conductor en las filas, días en las columnas—
pero con lo que el Excel no da:

- **Adjudicación del desplazamiento**: al asignar un día, coordinación elige vehículo,
  conductor, tipo de jornada, **municipio y destino**. El destino se busca por autocompletado
  entre los ya usados, o se crea en el momento indicando su municipio (D12). No hay que
  preconfigurar un catálogo completo antes de empezar a usar la herramienta.
- **Sin restricción por territorio**: cualquier conductor puede adjudicarse a cualquier
  municipio (D13). El municipio de su ficha solo precarga el formulario.
- **Celda enriquecida**: cada día no es texto libre sino `tipo_jornada` + `destino`.
  Del archivo actual se deducen seis tipos:

  | Tipo | Ejemplo en el Excel | Significado |
  |------|---------------------|-------------|
  | `ebs` | `SANTA INÉS` | Salida rutinaria del Equipo Básico de Salud |
  | `jornada` | `JORNADA ASERRÍO` | Jornada extramural programada |
  | `vacunacion` | `VACUNACIÓN HONDURAS` | Jornada de vacunación (PAI) |
  | `disponible` | `DISPONIBLE ABREGO` | En base, sin destino asignado |
  | `traslado_ciudad` | `CÚCUTA` | Salida fuera del territorio |
  | `administrativo` | `IPS SAN PABLO`, `PARQUE PRINCIPAL` | Apoyo o trámite |

  Separar el tipo del lugar es lo que permite contar: hoy `DISPONIBLE ABREGO` y `SANTA INÉS` son
  dos textos indistinguibles para una fórmula.

- **Historial por celda** (§4.2): al abrir una celda modificada se ve quién la cambió, cuándo,
  qué decía antes y por qué. Es el requisito explícito del rol de coordinación.
- **Semáforo programado vs ejecutado**: la celda cambia de color cuando el conductor cerró el
  trayecto de ese día. Un vistazo muestra qué se cumplió y qué no.
- **Copiar semana anterior**, para no reprogramar desde cero cada lunes.
- **Detección de choques**: un vehículo con dos destinos el mismo día, o un conductor asignado a
  dos vehículos, se marca en rojo al guardar.
- **Importar y exportar Excel**, para la transición desde el archivo actual y para quien prefiera
  seguir trabajando en hoja de cálculo.

### 5.1.0 El contador de días junto a cada placa (D31)

Al lado de cada vehículo va «N día(s) · M con salida». **Contaba los días del período visible**, y
por eso cambiaba al mover la ventana: con dos semanas a la vista un vehículo «tenía» 10 días y con
una semana, 5. Para lo único que sirve ese contador —comparar qué vehículos están trabajando más
que otros, que fue el objetivo original de la herramienta— un número que depende de cuánto se esté
mirando no vale nada.

Ahora el total lo calcula el servidor sobre **todos** los itinerarios, en `/api/itinerario/resumen`,
y el período visible pasa al texto emergente. La media que decide el color del contador se calcula
sobre esos mismos totales: mezclar el total de un vehículo con la media del período haría que el
desvío no significara nada.

El endpoint acepta `desde` y `hasta`, sin usar por ahora: **la cuenta es de toda la operación**. Si
algún día hay que acotarla a un año o a un contrato, es un parámetro.

### 5.1.1 Edición rápida del itinerario (D15 a D18)

**Arrastrar.** Una celda se mueve arrastrándola; con **Ctrl** se duplica. Si se suelta sobre
una celda ocupada, las dos se intercambian — reorganizar dos conductores es un solo gesto.
Los días ya ejecutados aparecen rayados y no se pueden arrastrar.

**Banco de predeterminados.** Las combinaciones que se repiten se guardan con un nombre
("Vacunación Honduras") y se aplican con un clic. El mismo nombre es lo que se escribe en la
plantilla de Excel, de modo que una celda del archivo significa exactamente una cosa.

**Plantilla de Excel.** Se descarga la matriz del período, se llena en Excel y se vuelve a
cargar. Tres cosas la hacen reversible sin pérdida:

| | |
|---|---|
| Fecha en formato ISO (`2026-09-14`) en la fila de encabezado | No depende del idioma ni del formato de fecha de Excel |
| Prefijo de jornada cuando no es ruta EBS (`VACUNACIÓN: HONDURAS`) | Sin él, descargar y volver a cargar convertía en ruta EBS decenas de días de vacunación |
| Hoja OPCIONES + lista desplegable en cada celda | El valor de una celda siempre se puede resolver a una programación concreta |

Descargar la plantilla y volver a cargarla sin tocarla produce **cero cambios**; es la prueba
que se ejecuta en cada revisión.

Al cargar, la aplicación muestra **qué va a crear, cambiar y borrar** y no aplica nada hasta que
se confirma. Los días en los que el conductor ya marcó salida aparecen listados como intocables.

**Borrar.** Coordinación cancela una programación (queda registrada); el administrador puede
además borrarla del todo. Ninguno de los dos puede tocar un día con viajes registrados: el
contador de días y la liquidación quedarían descuadrados sin que nadie se entere.

### 5.1.2 Programar más rápido

**Pincel.** Se escoge un predeterminado de la barra y se arrastra sobre los días: en un trazo
se programa una semana entera. Sustituye trece aperturas de formulario por un gesto.

**Deshacer** devuelve el último arrastre a su sitio, o borra el duplicado que acaba de crearse.

**Resumen por fila.** Cada vehículo muestra cuántos días lleva programados en el período y
cuántos con desplazamiento, en color cuando se aparta del promedio de la flota. Sirve para
repartir la carga mientras se programa, en vez de descubrir el desbalance después en el dashboard.

**Aviso de vencimientos.** Al adjudicar, si el vehículo tiene el SOAT vencido, está en
mantenimiento, o el conductor no tiene vigente el curso de Misión Médica, sale la advertencia
en ese momento. No bloquea: queda a criterio de quien programa.

**Período** de una semana, dos o un mes, y el PDF y el Excel siguen el período elegido.

### 5.1.3 En el celular (D19)

El arrastre usa Pointer Events, no la API de arrastre de HTML5: así el mismo código funciona
con el ratón y con el dedo. En táctil, mover exige **sostener el dedo 350 ms**, porque de lo
contrario el gesto sería indistinguible de desplazar la tabla.

Los campos usan letra de 16 px para que iOS no haga zoom al enfocar, y los márgenes respetan
el *notch*.

**El itinerario se programa desde el celular igual que desde el computador.** Por debajo de
700 px hay dos presentaciones del mismo itinerario, y se alterna entre ellas con un botón de la
cabecera; la elección se recuerda en el aparato:

- **Matriz** — la misma tabla del escritorio, con la columna de placas fija y desplazamiento
  lateral *dentro de su marco*, no de la página. Trae las casillas libres con su `+`, que es lo
  que permite adjudicar. Arranca en **una semana** en vez de dos: con 13 vehículos y 14 días la
  tabla mide unos 1 700 px y en un teléfono de 412 px se verían dos días y medio a la vez.
- **Por día** — se escoge el día en una tira deslizante, que además dice cuántos vehículos
  tiene cada uno, y debajo salen **todos** los vehículos: los programados con su destino y los
  libres como una ranura *+ Asignar*. No hay desplazamiento lateral, y es la forma rápida de
  llenar un día con una sola mano.

> **El defecto que esto corrige.** Antes, por debajo de 700 px la matriz se reemplazaba por una
> lista de solo lectura que únicamente listaba los días **ya programados**. Los vehículos libres
> no aparecían por ninguna parte, así que desde el celular no había dónde tocar para adjudicar un
> traslado: solo se podía modificar lo que ya existía. Se reportó como «la visual del teléfono no
> permite modificar itinerarios».

**El pincel también funciona en el celular**, por toques: se escoge el predeterminado y cada
toque programa un día. Con el dedo **no** se pinta arrastrando — sería el mismo gesto que
desplazar la pantalla, y `preventDefault` dejaría la tabla pegada mientras el pincel estuviera
encendido. Con el ratón se sigue pintando de las dos formas.

**Mover sin arrastrar (D32).** La ventana de la programación lleva un bloque *Mover a otro día o
a otro vehículo* con los dos campos. No es un capricho del móvil: el arrastre es el único camino
que había, y con el dedo exige sostener 350 ms y soltar sobre una celda que casi siempre está
fuera de pantalla. Por debajo usa el mismo `POST /api/itinerario/mover` que el arrastre, así que
queda en el historial exactamente igual, y el movimiento se puede deshacer con el mismo botón.
Como ese endpoint **intercambia** las dos programaciones cuando el destino está ocupado —cosa que
arrastrando se ve venir, porque la celda se pinta de ámbar—, el bloque avisa antes de guardar:
libre, ocupado (se intercambian) o con viajes registrados (no se puede).

Se prueba con `node worker/pruebas/prueba_movil.mjs`, en un navegador de verdad a 412 px: adjudica
un traslado, lo mueve sin arrastrarlo, pinta con un predeterminado y comprueba que el arrastre con
el ratón del escritorio siga funcionando — la matriz es la misma en los dos sitios.

### 5.1.4 Instalación en el teléfono del conductor (D27)

La aplicación se instala **desde el propio navegador**: no pasa por Play Store ni por App Store,
no hay que publicar nada en ninguna tienda, no hay revisiones ni cuotas anuales de desarrollador,
y cada cambio publicado llega solo. Para el conductor la diferencia es que la abre desde un icono,
a pantalla completa, y —lo que de verdad importa en el Catatumbo— **abre aunque no haya señal**.

Lo que lo hace posible:

| Pieza | Para qué |
|---|---|
| `manifest.json` | Nombre, icono, color y modo `standalone`. Sin él el navegador no ofrece instalar |
| `iconos/logo-original.png` | El logotipo tal como lo entregó diseño. Todos los iconos son este dibujo, entero |
| `iconos/*.png` | Iconos **PNG reales** de 192 y 512 px, más `apple-touch-icon.png` de 180 px para iPhone |
| `sw.js` | Guarda el armazón en el teléfono; es lo que permite abrir sin cobertura |
| Franja y botón *Instalar* | El ofrecimiento propio de la aplicación, en el ingreso y dentro |
| Instructivo por sistema | iPhone no permite instalar por código: allí solo cabe explicar los pasos |

Tres cosas que un navegador **no puede** hacer, y que condicionan el diseño:

1. **iPhone no tiene evento de instalación.** Safari no ofrece nada y no existe forma de
   instalar por código: hay que explicarle al conductor los tres toques del menú *Compartir*.
   Además solo funciona desde Safari, no desde el navegador incrustado de WhatsApp.
2. **El aviso de Android es de un solo uso.** Chrome entrega el evento `beforeinstallprompt`
   una vez; si el usuario dice que no, no lo vuelve a ofrecer en unos días. Por eso el evento se
   intercepta y se guarda, en lugar de dejar el globo del navegador, y por eso hay instructivo
   de respaldo.
3. **Una aplicación instalada no se recarga con F5.** Si sale una versión nueva hay que
   avisarlo dentro de la aplicación, o el conductor se queda meses con la vieja. De ahí la
   franja verde *Actualizar*, que pide el relevo al service worker y recarga sola.

Los datos **nunca** se guardan en el teléfono: un itinerario viejo sería peor que ninguno. Lo que
sí se guarda son las marcas tomadas sin cobertura, que la aplicación envía sola al volver la señal.

> **No cambiar `id` ni `scope` del manifiesto.** El `id` (`flota-hrno`) es lo que identifica la
> aplicación instalada. Si cambia, cada teléfono ya instalado se queda con una aplicación
> huérfana que no vuelve a recibir actualizaciones, y hay que desinstalar e instalar a mano
> celular por celular. Lo mismo si se mueve la carpeta `FLOTA VEHICULAR/`.

**El logotipo no se toca.** `iconos/logo-original.png` es el que entregó diseño —cuadro azul, la
muesca de *By PascalIA* arriba a la derecha, el emblema en el centro y la palabra FLOTA abajo— y
**todos los iconos son ese mismo dibujo, entero**. Lo único que cambia entre uno y otro es el
tamaño. `iconos/generar.mjs` solo hace una cosa más: **redondea las esquinas** al mismo radio que
ya tiene el cuadro azul, para quitar el blanco que el archivo lleva por fuera de la curva. Sin eso,
en el escritorio del teléfono se verían cuatro esquinas blancas alrededor del icono.

> **No se declara icono con máscara (`purpose: "maskable"`), a propósito.** Android recorta esos
> iconos en un círculo. Para que el círculo no se comiera la muesca de PascalIA ni la palabra
> FLOTA había que encoger el logotipo y dejarlo pequeño en mitad de un cuadro azul — y así se vio
> en un teléfono de verdad: reducido al centro, con las esquinas del logotipo marcadas por dentro.
> Sin icono con máscara, Android usa el normal y el logotipo sale entero y a su tamaño, que es lo
> correcto aquí porque **el archivo ya viene con forma de icono**: su cuadro azul y sus esquinas
> redondeadas. Volver a añadir uno con máscara reintroduce el defecto.

La firma *By PascalIA* del pie de cada pantalla (`iconos/pascalia.png`) es lo único que no sale de
ese archivo: viene de `iconos/pascalia-fuente.png`, la marca de PascalIA en horizontal, que es
como se lee bien en una línea de texto.

Si cambia el logotipo se reemplaza `logo-original.png`, se comprueba que el radio de sus esquinas
siga siendo el de `RADIO` y se vuelve a ejecutar `node iconos/generar.mjs iconos`. Ojo: como los
archivos conservan el nombre, un teléfono que ya tuviera la aplicación instalada puede tardar en
cambiar el icono del escritorio; lo seguro es desinstalar e instalar de nuevo.

El instructivo para repartir a los conductores está en `INSTALAR_EN_EL_CELULAR.md`. Los iconos se
regeneran con `node iconos/generar.mjs iconos` y todo lo anterior se comprueba con
`node worker/pruebas/prueba_pwa.mjs`, que incluye cortar la red y recargar.

### 5.2 Maestro de vehículos
Ficha y hoja de vida, con **`propiedad` = propio / contratista / comodato** y `valor_dia` (D7),
que es lo que alimenta la liquidación. Foto y **QR pegado en el parabrisas** que abre el checklist
móvil de ese vehículo. Semáforo de vencimientos: verde (> 30 días), amarillo (≤ 30 días), rojo
(vencido), configurable en `parametros`.

### 5.3 Personas
Conductores y tripulación en una sola tabla con banderas de rol. Vigencia de licencia por
categoría, **curso de Misión Médica** (exigido por la Res. 4481), APH, exámenes ocupacionales y
ARL, con el mismo semáforo.

### 5.3.1 Mi itinerario: lo que el conductor consulta (D30)

El conductor necesitaba ver más allá de hoy: con qué vehículo sale mañana, si el domingo le toca,
cuándo tiene una jornada de vacunación. Es una pantalla **aparte**, no la matriz de §5.1:

- **Solo de consulta.** La matriz de Coordinación trae todos los vehículos y sirve para editar
  arrastrando; en un teléfono no se usa, y un conductor no debe cambiar su propia programación.
- **Una tarjeta por día, en una columna**, incluidos los días **sin programación** — que un día
  salga en blanco es información («ese día no me toca»). Si solo se pintaran los días programados,
  el conductor no sabría si es que descansa o si falta cargarlo.
- **El filtro lo hace el servidor.** `/api/mi-itinerario` consulta por `sesion.persona_id`; filtrar
  en la pantalla no serviría de nada, porque basta con pedir la dirección a mano para ver la
  programación de los compañeros. La prueba comprueba que solo aparezca su propio vehículo.
- **Funciona sin señal**, con la copia local, avisando que puede estar desactualizada.

### 5.4 Trayectos: marcación en vivo con GPS (D5)

La pantalla del conductor tiene dos botones grandes y nada más:

```
┌───────────────────────────────┐   ┌───────────────────────────────┐
│      REGISTRAR SALIDA         │   │     REGISTRAR LLEGADA         │
│  municipio · lugar · GPS      │   │  municipio · lugar · GPS      │
└───────────────────────────────┘   └───────────────────────────────┘
```

Al pulsar: el municipio y el lugar vienen precargados desde el itinerario del día (editables si
cambió el destino), el teléfono pide la ubicación, y el Worker sella la hora. Si no hay señal, la
marca se guarda en IndexedDB y se sincroniza sola al recuperar cobertura, quedando etiquetada como
`offline_sincronizado` para que el dashboard no la confunda con una marca en tiempo real.

Si el conductor niega el permiso de ubicación, la marca se registra igual pero **sin coordenadas y
señalada como tal** — es preferible a perder el registro, y queda visible en la validación.

### 5.4.1 Lo que exige cada marca (D24)

| Al salir | Al llegar |
|---|---|
| Municipio y lugar | Municipio y lugar |
| **Kilometraje inicial** | **Kilometraje final**, que no puede ser menor que el inicial |
| **Cuántas personas van a bordo** | |
| **Nombres de los tripulantes** | |
| **Fotografía** | **Fotografía** |

Las fotografías se reducen a 1280 px y se comprimen en el propio teléfono antes de subirlas:
una foto de varios megabytes queda en unos 100 KB. Se hace ahí porque en el Catatumbo la
subida es el cuello de botella, y porque la base de datos las guarda y crecería sin control.
Sin señal, la marca se encola pero la fotografía no —unas pocas llenarían el almacenamiento
del navegador— y se agrega al recuperar la cobertura.

#### La fotografía se toma en Timemark (D26)

Coordinación pidió que la foto no la tome la cámara del teléfono sino
**[Timemark](https://play.google.com/store/apps/details?id=com.oceangalaxy.camera.new)**
(OCEAN GALAXY PTE. LTD.), que estampa fecha, hora y coordenadas sobre la propia imagen.

Dos límites del navegador determinan el flujo, y conviene tenerlos escritos:

1. **Una página web no puede saber si una aplicación está instalada.** Lo que sí existe en
   Android es la URL `intent:` con dirección de respaldo: Chrome abre la aplicación si está y,
   si no, lleva a la ficha de Play Store. Es exactamente el comportamiento pedido, y lo resuelve
   el navegador, no la aplicación.
2. **Una página web no puede recibir la foto de vuelta de otra aplicación.** Timemark la guarda
   en la galería. Por eso el formulario tiene dos pasos: *Abrir Timemark* y *Adjuntar la foto*.

En iPhone no existe el mecanismo `intent:`, así que el botón abre la ficha de la App Store; si la
aplicación ya está instalada, esa ficha ofrece "Abrir".

Como la foto se adjunta desde la galería, el conductor podría escoger una de otro día. No se
bloquea —puede haber una razón válida— pero si la imagen es más vieja que el umbral configurado
la aplicación lo advierte. Además, el servidor guarda su propia hora y sus propias coordenadas,
que corroboran lo estampado por Timemark.

Todo esto es configurable en Ajustes: qué aplicación, su identificador en cada tienda, y si se
usa o se vuelve a la cámara del teléfono.

Si el conductor sale **sin programación**, el formulario le pide escoger el vehículo en vez de
fallar: el viaje queda registrado y el dashboard lo muestra como ejecutado sin programar, que es
justamente la señal que sirve para detectar inconsistencias.

La exigencia de fotografía se puede apagar desde Ajustes (`foto_obligatoria`).

### 5.4.2 Funcionar sin señal, de verdad (D29)

Los conductores reportaron que «la aplicación no abre sin internet». Abría —el service worker
guardaba la pantalla— pero quedaba **inservible**, por cinco defectos encadenados:

| Defecto | Qué veía el conductor |
|---|---|
| El arranque validaba la sesión contra el servidor y **cualquier** fallo, red incluida, llamaba a `salir()`, que borra la sesión guardada | Lo echaba a la pantalla de ingreso. Y no podía entrar, porque entrar también necesita red. **Esta era la queja** |
| Catálogos, parámetros y vehículos se bajaban del servidor sin respaldo | El formulario de marca salía sin municipios ni vehículo |
| `/api/mi-dia` fallaba y se pintaba el error | Sin programación y **sin el botón de registrar salida** |
| La fotografía se **descartaba** al encolar la marca | El soporte se perdía |
| La cola vivía en `localStorage`, unos 5 MB | Con cuatro o cinco marcas se llenaba y la marca se perdía sin avisar |

Lo que hay ahora:

- **La sesión solo se cierra si el servidor lo dice.** `fetch` únicamente rechaza cuando la
  petición no llegó a ninguna parte; si el servidor respondió —aunque sea 401— no rechaza. Esa
  distinción (`esFalloDeRed`) es la que separa «no hay señal» de «su sesión expiró».
- **Copia local en IndexedDB** (`baul`), con dos almacenes: `cola` —marcas pendientes con su
  fotografía— y `caja` —la última copia buena de catálogos, parámetros, vehículos, banner y el día
  del conductor—. IndexedDB y no `localStorage` porque una fotografía ocupa cerca de 200 KB.
- **Las marcas de la cola se superponen** sobre el día guardado. Sin eso el conductor tocaba
  *Registrar salida*, no pasaba nada visible y volvía a tocarla: dos salidas del mismo viaje.
- **Al volver la señal se envía de a una y en orden.** Importa el orden: una llegada tomada sin
  señal apunta al identificador **local** de su salida, que aún no existía en el servidor. Al
  enviar la salida, el servidor devuelve su id real y la equivalencia se aplica a la llegada. Sin
  eso el `UPDATE` no encontraba el viaje y **la llegada se perdía en silencio** — por eso el
  servidor ahora responde `ok: false` cuando el update no toca ninguna fila.
- **`/api/sync` guarda las fotografías** (antes las ignoraba). Sube `VERSION_API` a **7**.

Lo que no cambió, y no debe cambiar: sin ubicación la marca se registra igual, señalada sin GPS.

### 5.4.3 Cuando el conductor bloquea la ubicación por error (D28)

Pasó en terreno: varios conductores tocaron **Bloquear** en el cuadro del permiso y después no
sabían cómo devolverse. Conviene tener claro el límite, porque manda sobre el diseño:

> Una página web **no puede volver a mostrar el cuadro del permiso** una vez se tocó *Bloquear*.
> El navegador recuerda esa decisión para el sitio y las llamadas siguientes fallan de inmediato,
> sin preguntar nada. Solo se deshace desde los ajustes del teléfono o del navegador.

Lo que sí se hace:

| Estado | Qué ve el conductor |
|---|---|
| **Permitido** | Nada en *Mi día*; en el formulario de marca, una nota verde de confirmación |
| **Sin contestar** | Un botón *Permitir ubicación ahora*. Aquí el permiso sigue en `prompt`, así que **volver a pedirlo sí muestra el cuadro otra vez**: es el caso que se arregla de un toque, y el más común —el conductor deslizó el aviso sin contestar— |
| **Bloqueado** | Franja roja con *Activar la ubicación*, que abre el instructivo con los pasos de **su** teléfono: distingue Android instalada, Android en Chrome e iPhone |

Dos detalles que hacen la diferencia en la vía:

1. **La franja se quita sola.** La aplicación vuelve a mirar el permiso cada vez que pasa al frente
   (`visibilitychange`), que es exactamente lo que ocurre cuando el conductor sale a los ajustes,
   lo permite y regresa. El evento `change` del permiso también se escucha, pero no todos los
   navegadores lo entregan; volver a la aplicación siempre ocurre.
2. **Nunca bloquea la marca.** Sin ubicación, la salida y la llegada se registran igual y quedan
   señaladas sin GPS. Un conductor en la vía no se puede quedar sin registrar por un permiso.

### 5.4.4 Georreferenciación en la pantalla de viajes

Cada marca muestra sus coordenadas con seis decimales, un botón para **copiarlas** y un enlace
al mapa. Al lado va la precisión reportada por el GPS: por encima de 100 m se pinta en ámbar,
porque en zona montañosa una lectura de 500 m no dice gran cosa. Los viajes sin ubicación se
cuentan aparte, arriba de la tabla.

### 5.5 Checklist de distintivos y elementos (D4)

Antes de salir y al regresar, sobre el trayecto concreto. Dos bloques:

**Bloque A — Distintivos del vehículo (5 posiciones)**

| # | Posición | Estados |
|---|----------|---------|
| 1 | Lateral izquierdo | bueno · deteriorado · ausente · obstruido |
| 2 | Lateral derecho | bueno · deteriorado · ausente · obstruido |
| 3 | Frontal | bueno · deteriorado · ausente · obstruido |
| 4 | Trasero | bueno · deteriorado · ausente · obstruido |
| 5 | Techo | bueno · deteriorado · ausente · obstruido |

El estado **obstruido** es deliberado: un distintivo tapado por barro, equipaje o una lona no
protege, y en términos de DIH equivale a no tenerlo. Cada posición admite foto de evidencia.

**Bloque B — Elementos adicionales (4)**

| # | Elemento | Estados | Cantidad |
|---|----------|---------|----------|
| 6 | Bandera | presente · deteriorado · ausente | 1 por vehículo |
| 7 | Chaleco | presente · deteriorado · ausente | según n° de tripulantes |
| 8 | Carnet | presente · ausente · vencido | 1 por tripulante |
| 9 | Carta de presentación | presente · ausente · vencida | 1 por trayecto |

El parámetro `checklist_bloquea_salida` decide si un faltante **bloquea** la salida o solo
**advierte** y queda registrado (pendiente de definir, ver P8). Si bloquea, la excepción la
autoriza el rol principal o coordinación con justificación escrita, que queda en auditoría.

El checklist de regreso permite comparar antes y después y detectar qué distintivo se perdió o se
dañó en ruta. Tres faltantes de la misma posición en un mes escalan como novedad de mantenimiento.

### 5.6 Planilla de tiempos imprimible y firmable (D8)

Como no existe un formato oficial, la aplicación lo define. Se genera con jsPDF, en tamaño carta y
pensado para imprimirse:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ESE HOSPITAL REGIONAL NOROCCIDENTAL                    PLT-2026-045 │
│  PLANILLA DE TIEMPOS DE OPERACIÓN — MISIÓN MÉDICA                    │
│  Vehículo: ____  Placa: ____  Propiedad: ____  Conductor: __________ │
│  Período: del __ al __ de ____________ de ____                       │
├────┬──────────┬───────────┬────────┬───────────┬────────┬────────────┤
│ Día│ Municipio│ Destino   │ Salida │ Llegada   │ Km     │ Observación│
├────┼──────────┼───────────┼────────┼───────────┼────────┼────────────┤
│ 10 │ ÁBREGO   │CAPITANLARGO│ 06:12 │ 08:40     │  47    │            │
│ …  │          │           │        │           │        │            │
├────┴──────────┴───────────┴────────┴───────────┴────────┴────────────┤
│  TOTAL DÍAS OPERADOS: ____    TOTAL KM: ____                         │
├──────────────────────────────────────────────────────────────────────┤
│  _____________________        _____________________                  │
│  Firma del conductor          Firma del coordinador                  │
│  C.C.                         Cargo                                  │
├──────────────────────────────────────────────────────────────────────┤
│  Verificación: [QR]  ·  Generada el __/__/____ por ________          │
└──────────────────────────────────────────────────────────────────────┘
```

Dos variantes del mismo documento:

1. **Prellenada** con los datos que el sistema ya tiene, para imprimir, firmar y archivar.
2. **En blanco**, con las filas vacías, para los días en que no hubo forma de registrar en el
   celular y hay que llenarla a mano.

Flujo: `generada → impresa → cargada → en revisión → validada / rechazada`. Al cargar el escaneo
firmado, el sistema **compara los días contados por la app contra los días declarados en el papel**
y marca la discrepancia. El QR del pie abre la verificación pública de esa planilla.

### 5.7 Contador de días y liquidación (D7)

Un registro por vehículo y día en `dias_operacion`, con seis estados: `operativo`, `disponible`,
`jornada_especial`, `mantenimiento`, `fuera_servicio`, `no_programado`. El día se marca
**ejecutado** si hubo al menos un trayecto cerrado, y **programado** si había itinerario.

De ahí sale la tabla que interesa para el pago:

| Métrica | Origen |
|---------|--------|
| Días programados | Itinerario |
| Días ejecutados | Trayectos cerrados |
| Días pagables | **Un día `DISPONIBLE` en base se paga igual que uno con desplazamiento** (D11) |
| Valor día | `vehiculos.valor_dia` |
| Total | Días pagables × valor día |

Que el día disponible se pague igual tiene una consecuencia de diseño que conviene tener
presente: el itinerario, no el GPS, es lo que determina si un día cuenta. Un vehículo en base
sin marcar salida igual genera día pagable siempre que estuviera programado como `disponible`.
Por eso el dashboard separa **días pagables** de **días con desplazamiento efectivo**: son dos
números distintos y ambos importan, uno para pagar y otro para saber quién está trabajando más.

Los ajustes manuales quedan marcados (`ajuste_manual`, `motivo_ajuste`, `ajustado_por`): un día
pagado sin respaldo de ejecución tiene que ser una decisión visible y firmada, no un número
editado en silencio. La liquidación mensual se cierra por vehículo y se cruza con la planilla
firmada del período.

### 5.8 Eventos y novedades
El conductor reporta desde el celular: varada, accidente, retén, bloqueo de vía, derrumbe, orden
público, negación de paso, retraso, cancelación, tanqueo o novedad de distintivo. Con gravedad,
ubicación con GPS, descripción, acciones y adjunto. Los de gravedad alta o crítica notifican de
inmediato al rol principal y a coordinación.

### 5.9 Mantenimiento, combustible y costos
Plan preventivo por kilometraje con alerta anticipada; órdenes correctivas cuyos días fuera de
servicio alimentan la disponibilidad y descuentan días pagables; tanqueos con **rendimiento
km/galón por vehículo** para detectar desviaciones; costo por trayecto, por kilómetro y por
municipio.

### 5.10 Dashboard interactivo

Tarjetas: trayectos del período, días operados, kilómetros, % de cumplimiento del itinerario,
% de checklists completos, % de planillas validadas, costo por kilómetro.

Gráficas (Chart.js, ya disponible offline en el repositorio):

- **Ranking de vehículos** por días operados, trayectos y kilómetros → responde directamente a
  *qué vehículos están trabajando más que otros*.
- **Programado vs ejecutado** por vehículo: la brecha entre lo que coordinación planeó y lo que
  el GPS confirma. Es el gráfico más importante de la herramienta.
- Serie de tiempo de trayectos por día y por semana.
- Distribución por municipio, por destino y por tipo de jornada.
- Mapa de calor vehículo × día, réplica visual del Excel actual pero calculada.
- Duración promedio de trayecto por destino, para detectar rutas que se están subestimando.
- Pareto de eventos por tipo.
- Embudo de estados de las planillas.
- Cumplimiento del checklist por vehículo, separando los 5 distintivos de los 4 elementos.
- Semáforo consolidado de vencimientos de vehículos y personas.
- Mapa de puntos de salida y llegada con Leaflet + OpenStreetMap (gratuito), aprovechando el GPS.

Filtros cruzados por fecha, municipio, vehículo, conductor y tipo de jornada; comparador lado a
lado de dos o más vehículos; exportación a Excel y PDF; informe mensual automático.

### 5.11 Portal del conductor
Vista móvil reducida: su itinerario de hoy y de la semana, los dos botones de marcación, el
checklist, el botón de novedad y sus planillas. Nada más — sin menús de administración.

### 5.12 Roles y permisos (D9)

| Acción | Principal | Coordinación | Conductor |
|--------|:---------:|:------------:|:---------:|
| Ver toda la información | ✅ | ✅ | Solo lo suyo |
| Descargar / exportar todo | ✅ | ✅ | No |
| Ver y descargar el dashboard | ✅ | ✅ | No |
| Modificar el itinerario | ✅ | ✅ *(con registro)* | No |
| Crear, editar y desactivar usuarios | ✅ **exclusivo** | No | No |
| Modificar parámetros del sistema | ✅ **exclusivo** | No | No |
| Crear y editar vehículos y personas | ✅ | No | No |
| Validar planillas y soportes | ✅ | ✅ | No |
| Ajustar manualmente días pagables | ✅ | No | No |
| Cerrar liquidaciones | ✅ | No | No |
| Registrar salida y llegada con GPS | ✅ | ✅ *(a nombre de)* | ✅ |
| Reportar novedades | ✅ | ✅ | ✅ |
| Diligenciar el checklist | ✅ | ✅ | ✅ |
| Corregir una marca ya registrada | ✅ | ✅ *(con registro)* | No |
| Ver la auditoría | ✅ | Solo la del itinerario | No |

Tres precisiones de diseño:

1. **El rol principal es el único que crea usuarios.** No hay autorregistro ni recuperación de
   contraseña por correo que pueda crear cuentas: el principal las crea y entrega una clave
   temporal que el usuario cambia al primer ingreso (`debe_cambiar_clave`).
2. **Coordinación puede modificar el itinerario pero no borrar el rastro.** Cada cambio escribe en
   `itinerario_cambios` y ese historial es de solo lectura para todos, incluido el principal.
3. **El conductor no puede corregir su propia marca.** Puede reportar el error como novedad, y la
   corrección la hace coordinación quedando registrada. Si pudiera editarla, el soporte de pago
   no probaría nada.

Sesiones con token opaco en `sesiones`, expiración configurable y registro de último acceso.

---

## 6. Complementos sugeridos

1. **Ficha pública por QR**: al escanear el QR del parabrisas, cualquier autoridad en un retén ve
   una página con el vehículo, su habilitación y el estado de sus distintivos. Es un argumento de
   protección en terreno, no solo un registro administrativo.
2. **Modo retén**: botón que registra evento, hora y ubicación, y notifica al instante.
3. **Cierre de mes asistido**: lista de lo que falta (planillas, firmas, kilometrajes) antes de
   reportar.
4. **Alerta de itinerario incumplido**: si un vehículo lleva N días programados sin marcar salida,
   avisa a coordinación en vez de descubrirlo al liquidar.
5. **Verificación de coherencia GPS**: si la llegada se marca a más de X km del destino
   programado, se señala para revisión. No acusa a nadie, solo lo pone a la vista.
6. **Exportación del consolidado de días** en el formato que exija el área financiera.

---

## 7. Marco normativo

- **Resolución 4481 de 2012** — Misión Médica, uso del emblema y distintivos.
- **Resolución 3100 de 2019** — habilitación de servicios, transporte asistencial TAB/TAM.
- **Ley 1581 de 2012** y **Decreto 1377 de 2013** — datos personales. Aplica a tres conjuntos:
  los datos de los conductores (§4.3), la **geolocalización**, que es dato personal y exige
  informar al trabajador para qué se usa y por cuánto tiempo se conserva, y cualquier dato de
  paciente, que la aplicación **no almacena**.
- **Ley 594 de 2000** — gestión documental y retención de soportes.

> Recomendación: incluir en la primera pantalla del conductor un aviso breve de tratamiento de
> datos explicando que la ubicación se registra solo al marcar salida y llegada, nunca de forma
> continua. Técnicamente la app no rastrea en segundo plano, y conviene que eso sea explícito.

---

## 8. Fases de implementación

| Fase | Alcance | Resultado |
|------|---------|-----------|
| **0** | Cuenta Cloudflare, `schema.sql` en D1, Worker con CORS, sesiones, tres roles y auditoría | Backend vivo |
| **1** | Catálogos, vehículos, personas, importación del Excel, usuarios | Inventario cargado |
| **2** | **Itinerario** con historial de cambios, importar/exportar Excel | El Excel queda reemplazado |
| **3** | **Marcación en vivo con GPS**, PWA offline, checklist de 9 ítems, novedades | Operación en terreno |
| **4** | Contador de días, planilla imprimible, carga y validación del soporte firmado | Trazabilidad para pago |
| **5** | Dashboard interactivo, programado vs ejecutado, exportaciones | Toma de decisiones |
| **6** | Liquidación mensual, mantenimiento, combustible, QR público, notificaciones | Ciclo completo |

Las fases 2 y 3 son las que dan valor visible de inmediato: la 2 le quita a coordinación el Excel
compartido, y la 3 es la que ninguna hoja de cálculo puede hacer.

---

## 9. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Conectividad intermitente en zona rural | PWA con cola offline desde la fase 3, no al final |
| Conductores con baja alfabetización digital | Dos botones grandes, checklist de toques, sin texto libre obligatorio |
| GPS impreciso en zona montañosa | Se guarda la precisión y se marca la lectura dudosa en vez de darla por buena |
| Marcas de tiempo manipulables | Hora del servidor, campo `origen`, y el conductor no puede corregir su marca |
| Resistencia al registro por percepción de vigilancia | Aviso explícito: la ubicación se toma solo en los dos momentos, nunca en continuo |
| Datos personales en zona de conflicto | Fuera del repositorio, cargados en la app, acceso por rol (§4.3) |
| Que el Excel siga usándose en paralelo | Importar y exportar en la fase 2, para que la migración no sea a ciegas |
| Límites de capa gratuita | 13 vehículos generan del orden de cientos de peticiones diarias frente a un tope de ~100.000 |

---

## 10. Datos ya extraídos del archivo de conductores

De `CONDUCTORES_EBS.xlsx` (programación del 10 al 22 de septiembre):

- **13 conductores**, cada uno con **una placa asignada** — relación 1 a 1 conductor ↔ vehículo.
- **4 municipios base**: Ábrego (4), El Carmen (3), Convención (3), San Pablo (3).
- **17 destinos distintos**, ya cargados en `seed_catalogos.sql`.
- **6 tipos de jornada** deducidos de los textos de las celdas (§5.1).
- **5 de 13 conductores sin cédula ni teléfono** registrados.
- Celdas vacías = días sin programación, que es justamente lo que el contador debe distinguir de
  un día programado y no ejecutado.

Inconsistencias detectadas y ya resueltas:

| Hallazgo | Resolución |
|----------|-----------|
| `SAN PABLO` figura como municipio, pero es corregimiento de Teorama | Se usa con su nombre propio, con pertenencia trazada a Teorama (D14) |
| El municipio de la fila es la base del conductor, no el del destino | El municipio del destino se registra al adjudicar (D12) |
| `LA SIERRA` la atienden conductores de tres municipios distintos | Es un solo lugar; el municipio base no restringe (D13) |
| `CAMPOR ALEGRE` parece error de digitación | Normalizado a `CAMPO ALEGRE`, editable desde administración |

---

## 11. Preguntas abiertas

### Sobre el territorio
1. **¿San Pablo se maneja como municipio propio o como corregimiento de Teorama?** El módulo de
   Misión Médica usa Ábrego, Convención, El Carmen y Teorama; el archivo de conductores usa
   Ábrego, Convención, El Carmen y San Pablo.
2. ¿A qué municipio pertenece cada uno de los 17 destinos? Es necesario para agrupar el dashboard
   por municipio.
3. ¿`LA SIERRA` es un solo lugar compartido o son veredas homónimas en municipios distintos?
4. ¿`CAMPOR ALEGRE` es `CAMPO ALEGRE`?

### Sobre el pago y la planilla
5. ¿La tarifa por día es la misma para todos los vehículos o varía por contrato o municipio?
6. **¿Un día `DISPONIBLE` en base se paga igual que un día con desplazamiento?** Es la regla que
   más afecta la liquidación.
7. ¿La planilla se firma por período mensual, quincenal o semanal?
8. ¿Quién firma además del conductor: coordinación, el supervisor del contrato, ambos?
9. ¿Qué diferencia entre días contados por la app y días del soporte firmado es aceptable?
10. ¿La liquidación debe salir en algún formato específico que exija el área financiera?

### Sobre la operación
11. ¿Se bloquea la salida cuando falta un distintivo, o solo se advierte y se registra?
12. ¿El checklist se hace por cada trayecto, una vez al día, o solo en la primera salida?
13. ¿Se registra kilometraje hoy? ¿Los odómetros son confiables?
14. ¿Hay control de combustible, con vale, tarjeta o factura?
15. ¿Existe plan de mantenimiento preventivo, por kilómetros o por tiempo?
16. ¿Hay GPS instalado en los vehículos? Si lo hay, ¿de qué proveedor y expone alguna API?
17. ¿Los vehículos son ambulancias, camionetas o mixtos? El archivo solo trae placas.

### Sobre los usuarios
18. ¿Los 13 conductores tienen teléfono inteligente con datos? ¿Qué operador y qué cobertura?
19. ¿Cuántas personas habría en el rol de coordinación?
20. ¿Se completan las 5 cédulas y teléfonos faltantes antes de la carga inicial?
21. ¿A qué correos deben llegar las alertas y con qué frecuencia?
22. ¿Hay fecha límite o compromiso institucional asociado a esta herramienta?

---

*Documento de planeación — ESE Hospital Regional Noroccidental · Coordinación de Salud Pública*
