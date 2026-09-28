-- ============================================================================
-- FLOTA VEHICULAR HRNO — esquema Cloudflare D1 (SQLite)
-- Borrador v0.3 · 11 sep 2026
--
-- Convenciones:
--   * Todas las marcas de tiempo se guardan en ISO-8601 UTC ('2026-09-11T14:03:00Z').
--     La hora la pone SIEMPRE el Worker, nunca el dispositivo del usuario.
--   * ts_dispositivo guarda la hora del celular solo como referencia forense.
--   * Ningun dato personal (cedula, telefono) se versiona en git: se carga
--     desde la pantalla de administracion. Ver PROJECT.md seccion 4.7.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. CATALOGOS
-- ---------------------------------------------------------------------------

-- Editable en pantalla por el rol principal: agregar, renombrar o desactivar.
-- municipio_padre_id permite registrar un corregimiento que en la practica se
-- maneja como municipio propio (caso SAN PABLO, corregimiento de TEORAMA):
-- se muestra con su propio nombre pero queda trazada su pertenencia real.
CREATE TABLE cat_municipios (
  id                 INTEGER PRIMARY KEY,
  nombre             TEXT NOT NULL UNIQUE,
  codigo_dane        TEXT,
  municipio_padre_id INTEGER REFERENCES cat_municipios(id),
  es_base            INTEGER NOT NULL DEFAULT 0,  -- 1 si desde alli opera la flota
  activo             INTEGER NOT NULL DEFAULT 1,
  creado_en          TEXT,
  actualizado_por    INTEGER,
  actualizado_en     TEXT
);

-- Catalogo VIVO, no cerrado. El municipio del destino se registra en el momento
-- de adjudicar el desplazamiento; a partir de ahi el destino queda guardado y se
-- sugiere por autocompletado en las siguientes adjudicaciones.
--
-- Un destino NUNCA se borra si ya fue usado: solo se desactiva (activo = 0), para
-- no romper los itinerarios y trayectos historicos que lo referencian.
--
-- Los conductores pueden ir a cualquier municipio: el municipio base de la
-- persona es solo un valor por defecto, jamas una restriccion.
CREATE TABLE cat_destinos (
  id            INTEGER PRIMARY KEY,
  municipio_id  INTEGER REFERENCES cat_municipios(id),  -- se fija al primer uso
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL DEFAULT 'vereda',
                -- vereda | corregimiento | ips | puesto_salud | cabecera |
                -- ciudad | otro
  lat           REAL,
  lon           REAL,
  veces_usado   INTEGER NOT NULL DEFAULT 0,   -- alimenta el orden del autocompletado
  ultimo_uso    TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_por    INTEGER,
  creado_en     TEXT,
  UNIQUE (municipio_id, nombre)
);
CREATE INDEX idx_dest_uso ON cat_destinos(activo, veces_usado DESC);

CREATE TABLE cat_ips (
  id            INTEGER PRIMARY KEY,
  municipio_id  INTEGER NOT NULL REFERENCES cat_municipios(id),
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL DEFAULT 'ips',  -- ips | puesto_salud | centro_salud | hospital
  codigo_reps   TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (municipio_id, nombre)
);

-- ---------------------------------------------------------------------------
-- 2. PERSONAS Y VEHICULOS
-- ---------------------------------------------------------------------------

CREATE TABLE personas (
  id            INTEGER PRIMARY KEY,
  tipo_doc      TEXT DEFAULT 'CC',
  numero_doc    TEXT UNIQUE,                  -- puede quedar nulo al inicio
  nombres       TEXT NOT NULL,
  apellidos     TEXT,
  telefono      TEXT,
  correo        TEXT,
  cargo         TEXT DEFAULT 'CONDUCTOR',
  vinculacion   TEXT,                         -- planta | contrato | ops | tercero
  municipio_id  INTEGER REFERENCES cat_municipios(id),  -- base por defecto,
                -- NO restringe: un conductor puede desplazarse a cualquier municipio
  territorio    TEXT,
  foto_url      TEXT,
  es_conductor  INTEGER NOT NULL DEFAULT 0,
  es_tripulante INTEGER NOT NULL DEFAULT 0,
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL
);

CREATE TABLE documentos_persona (
  id            INTEGER PRIMARY KEY,
  persona_id    INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,
                -- licencia_conduccion | curso_mision_medica | aph |
                -- examen_ocupacional | arl | eps | otro
  numero        TEXT,
  categoria     TEXT,                         -- C1, C2, ...
  expedicion    TEXT,
  vencimiento   TEXT,
  archivo_url   TEXT
);
CREATE INDEX idx_docper_venc ON documentos_persona(vencimiento);

CREATE TABLE vehiculos (
  id                INTEGER PRIMARY KEY,
  placa             TEXT NOT NULL UNIQUE,
  numero_interno    TEXT,
  tipo              TEXT NOT NULL DEFAULT 'camioneta',
                    -- ambulancia | camioneta | moto | fluvial | otro
  subtipo           TEXT,                     -- TAB | TAM (si ambulancia)
  marca             TEXT,
  linea             TEXT,
  modelo_anio       INTEGER,
  color             TEXT,
  capacidad         INTEGER,
  municipio_base_id INTEGER REFERENCES cat_municipios(id),
  ips_asignada_id   INTEGER REFERENCES cat_ips(id),
  propiedad         TEXT NOT NULL DEFAULT 'propio',   -- propio | contratista | comodato
  contratista       TEXT,                     -- razon social, si propiedad='contratista'
  valor_dia         REAL,                     -- tarifa pactada por dia de operacion
  estado            TEXT NOT NULL DEFAULT 'activo',
                    -- activo | mantenimiento | fuera_servicio | taller | reserva
  km_actual         INTEGER,
  foto_url          TEXT,
  qr_token          TEXT UNIQUE,              -- para la ficha publica de verificacion
  activo            INTEGER NOT NULL DEFAULT 1,
  creado_en         TEXT NOT NULL
);

CREATE TABLE documentos_vehiculo (
  id            INTEGER PRIMARY KEY,
  vehiculo_id   INTEGER NOT NULL REFERENCES vehiculos(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,
                -- soat | rtm | tarjeta_propiedad | poliza | habilitacion_reps |
                -- desinfeccion | extintor | botiquin | kit_carretera | otro
  numero        TEXT,
  expedicion    TEXT,
  vencimiento   TEXT,
  archivo_url   TEXT
);
CREATE INDEX idx_docveh_venc ON documentos_vehiculo(vencimiento);

-- Asignacion conductor <-> vehiculo con vigencia (permite relevos y cambios)
CREATE TABLE asignaciones (
  id            INTEGER PRIMARY KEY,
  vehiculo_id   INTEGER NOT NULL REFERENCES vehiculos(id),
  persona_id    INTEGER NOT NULL REFERENCES personas(id),
  rol           TEXT NOT NULL DEFAULT 'conductor',
  desde         TEXT NOT NULL,
  hasta         TEXT,
  creado_por    INTEGER,
  creado_en     TEXT NOT NULL
);
CREATE INDEX idx_asig_vig ON asignaciones(vehiculo_id, desde, hasta);

-- ---------------------------------------------------------------------------
-- 3. ITINERARIO  (la matriz conductor x dia que hoy vive en Excel)
-- ---------------------------------------------------------------------------

CREATE TABLE itinerarios (
  id            INTEGER PRIMARY KEY,
  fecha         TEXT NOT NULL,                -- 'YYYY-MM-DD'
  vehiculo_id   INTEGER NOT NULL REFERENCES vehiculos(id),
  conductor_id  INTEGER REFERENCES personas(id),
  municipio_id  INTEGER REFERENCES cat_municipios(id),
  destino_id    INTEGER REFERENCES cat_destinos(id),
  destino_texto TEXT,                         -- destino libre si aun no esta en catalogo
  tipo_jornada  TEXT NOT NULL DEFAULT 'ebs',
                -- ebs | jornada | vacunacion | disponible | traslado_ciudad |
                -- administrativo | no_programado
  observaciones TEXT,
  estado        TEXT NOT NULL DEFAULT 'programado',
                -- programado | ejecutado | no_ejecutado | cancelado
  creado_por    INTEGER NOT NULL,
  creado_en     TEXT NOT NULL,
  UNIQUE (fecha, vehiculo_id)
);
CREATE INDEX idx_itin_fecha ON itinerarios(fecha);
CREATE INDEX idx_itin_cond  ON itinerarios(conductor_id, fecha);

-- Banco de predeterminados: combinaciones de jornada y destino que se repiten,
-- guardadas con un nombre para adjudicar con un solo clic. El nombre es tambien
-- el valor que se escribe en la plantilla de Excel, de modo que una celda del
-- archivo siempre significa exactamente una cosa.
CREATE TABLE itinerario_predeterminados (
  id            INTEGER PRIMARY KEY,
  nombre        TEXT NOT NULL UNIQUE,
  tipo_jornada  TEXT NOT NULL DEFAULT 'ebs',
  municipio_id  INTEGER REFERENCES cat_municipios(id),
  destino_id    INTEGER REFERENCES cat_destinos(id),
  observaciones TEXT,
  veces_usado   INTEGER NOT NULL DEFAULT 0,
  ultimo_uso    TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_por    INTEGER,
  creado_en     TEXT NOT NULL
);
CREATE INDEX idx_pred_uso ON itinerario_predeterminados(activo, veces_usado DESC);

-- Historial visible de cambios del itinerario: quien modifico y cuando.
-- Se muestra en la interfaz, no solo en la auditoria tecnica.
CREATE TABLE itinerario_cambios (
  id            INTEGER PRIMARY KEY,
  itinerario_id INTEGER NOT NULL REFERENCES itinerarios(id) ON DELETE CASCADE,
  ts            TEXT NOT NULL,
  usuario_id    INTEGER NOT NULL,
  campo         TEXT NOT NULL,
  valor_antes   TEXT,
  valor_despues TEXT,
  motivo        TEXT
);
CREATE INDEX idx_itincam ON itinerario_cambios(itinerario_id, ts);

-- ---------------------------------------------------------------------------
-- 4. TRAYECTOS  (lo que el conductor marca en vivo: salida y llegada)
-- ---------------------------------------------------------------------------

CREATE TABLE trayectos (
  id                  INTEGER PRIMARY KEY,
  consecutivo         TEXT UNIQUE,            -- TR-2026-000123
  itinerario_id       INTEGER REFERENCES itinerarios(id),
  vehiculo_id         INTEGER NOT NULL REFERENCES vehiculos(id),
  conductor_id        INTEGER NOT NULL REFERENCES personas(id),
  fecha_operacion     TEXT NOT NULL,          -- 'YYYY-MM-DD', dia al que se imputa

  -- SALIDA
  municipio_salida_id INTEGER REFERENCES cat_municipios(id),
  lugar_salida        TEXT,
  ts_salida           TEXT,                   -- hora del SERVIDOR
  ts_salida_disp      TEXT,                   -- hora del celular (referencia)
  origen_salida       TEXT,                   -- en_linea | offline_sincronizado | digitado
  lat_salida          REAL,
  lon_salida          REAL,
  precision_salida    REAL,                   -- metros reportados por el GPS

  -- LLEGADA
  municipio_llegada_id INTEGER REFERENCES cat_municipios(id),
  lugar_llegada       TEXT,
  ts_llegada          TEXT,
  ts_llegada_disp     TEXT,
  origen_llegada      TEXT,
  lat_llegada         REAL,
  lon_llegada         REAL,
  precision_llegada   REAL,

  km_inicial          INTEGER,
  km_final            INTEGER,
  num_tripulantes     INTEGER,
  tripulantes         TEXT,        -- nombres de quienes van a bordo
  tipo_jornada        TEXT,
  observaciones       TEXT,
  estado              TEXT NOT NULL DEFAULT 'en_curso',
                      -- en_curso | cerrado | anulado
  creado_por          INTEGER NOT NULL,
  creado_en           TEXT NOT NULL,
  cerrado_en          TEXT
);
CREATE INDEX idx_tray_fecha ON trayectos(fecha_operacion);
CREATE INDEX idx_tray_veh   ON trayectos(vehiculo_id, fecha_operacion);
CREATE INDEX idx_tray_cond  ON trayectos(conductor_id, fecha_operacion);

-- Fotografías de salida y de llegada.
--
-- Se guardan en la base como base64, igual que el banner, y no en un almacén
-- aparte: el respaldo de la base se lleva todo consigo y no hace falta montar
-- nada más. A cambio hay que comprimirlas fuerte en el navegador (1280 px de
-- ancho, ~120 KB) para que la base no crezca sin control.
CREATE TABLE trayecto_fotos (
  id           INTEGER PRIMARY KEY,
  trayecto_id  INTEGER NOT NULL REFERENCES trayectos(id) ON DELETE CASCADE,
  momento      TEXT NOT NULL,          -- salida | llegada
  mime         TEXT NOT NULL,
  datos        TEXT NOT NULL,
  bytes        INTEGER,
  lat          REAL,
  lon          REAL,
  ts           TEXT NOT NULL,
  subido_por   INTEGER,
  UNIQUE (trayecto_id, momento)
);
CREATE INDEX idx_fotos_tray ON trayecto_fotos(trayecto_id);

-- ---------------------------------------------------------------------------
-- 5. CHECKLIST  (5 distintivos del vehiculo + 4 elementos)
-- ---------------------------------------------------------------------------

CREATE TABLE checklists (
  id            INTEGER PRIMARY KEY,
  trayecto_id   INTEGER REFERENCES trayectos(id) ON DELETE CASCADE,
  vehiculo_id   INTEGER NOT NULL REFERENCES vehiculos(id),
  momento       TEXT NOT NULL,                -- presalida | regreso
  ts            TEXT NOT NULL,
  registrado_por INTEGER NOT NULL,
  completo      INTEGER NOT NULL DEFAULT 0,
  excepcion_autorizada INTEGER NOT NULL DEFAULT 0,
  justificacion TEXT,
  autorizado_por INTEGER
);

CREATE TABLE checklist_items (
  id            INTEGER PRIMARY KEY,
  checklist_id  INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  bloque        TEXT NOT NULL,                -- distintivo_vehiculo | elemento
  item          TEXT NOT NULL,
                -- distintivo_vehiculo: lateral_izquierdo | lateral_derecho |
                --                      frontal | trasero | techo
                -- elemento:            bandera | chaleco | carnet | carta_presentacion
  estado        TEXT NOT NULL,
                -- distintivo: bueno | deteriorado | ausente | obstruido
                -- elemento:   presente | deteriorado | ausente | vencido
  cantidad      INTEGER,
  foto_url      TEXT,
  observacion   TEXT
);
CREATE INDEX idx_chkit ON checklist_items(checklist_id);

-- ---------------------------------------------------------------------------
-- 6. PLANILLA DE TIEMPOS Y SOPORTES FIRMADOS
-- ---------------------------------------------------------------------------

CREATE TABLE planillas (
  id                INTEGER PRIMARY KEY,
  consecutivo       TEXT NOT NULL UNIQUE,     -- PLT-2026-000045
  vehiculo_id       INTEGER NOT NULL REFERENCES vehiculos(id),
  conductor_id      INTEGER NOT NULL REFERENCES personas(id),
  periodo_desde     TEXT NOT NULL,
  periodo_hasta     TEXT NOT NULL,
  generada_en       TEXT NOT NULL,
  generada_por      INTEGER NOT NULL,
  pdf_url           TEXT,                     -- version en blanco, para imprimir y firmar
  soporte_url       TEXT,                     -- escaneo/foto ya firmado
  subido_por        INTEGER,
  subido_en         TEXT,
  estado            TEXT NOT NULL DEFAULT 'generada',
                    -- generada | impresa | cargada | en_revision | validada | rechazada
  validado_por      INTEGER,
  validado_en       TEXT,
  motivo_rechazo    TEXT,
  dias_sistema      INTEGER,                  -- dias contados por la app
  dias_soporte      INTEGER,                  -- dias declarados en el papel firmado
  discrepancia_dias INTEGER
);
CREATE INDEX idx_plan_per ON planillas(vehiculo_id, periodo_desde, periodo_hasta);

-- ---------------------------------------------------------------------------
-- 7. DIAS DE OPERACION Y LIQUIDACION (el pago es por dia)
-- ---------------------------------------------------------------------------

CREATE TABLE dias_operacion (
  id              INTEGER PRIMARY KEY,
  fecha           TEXT NOT NULL,
  vehiculo_id     INTEGER NOT NULL REFERENCES vehiculos(id),
  conductor_id    INTEGER REFERENCES personas(id),
  estado_dia      TEXT NOT NULL,
                  -- operativo | disponible | jornada_especial | mantenimiento |
                  -- fuera_servicio | no_programado
  programado      INTEGER NOT NULL DEFAULT 0, -- habia itinerario ese dia
  ejecutado       INTEGER NOT NULL DEFAULT 0, -- hubo al menos un trayecto cerrado
  num_trayectos   INTEGER NOT NULL DEFAULT 0,
  horas_operacion REAL,
  km_dia          INTEGER,
  dia_pagable     INTEGER NOT NULL DEFAULT 0,
  ajuste_manual   INTEGER NOT NULL DEFAULT 0, -- 1 si un humano forzo el valor
  ajustado_por    INTEGER,
  motivo_ajuste   TEXT,
  UNIQUE (fecha, vehiculo_id)
);
CREATE INDEX idx_dias_veh ON dias_operacion(vehiculo_id, fecha);

CREATE TABLE liquidaciones (
  id                INTEGER PRIMARY KEY,
  periodo           TEXT NOT NULL,            -- '2026-09'
  vehiculo_id       INTEGER NOT NULL REFERENCES vehiculos(id),
  propiedad         TEXT NOT NULL,            -- propio | contratista | comodato
  contratista       TEXT,
  dias_programados  INTEGER NOT NULL DEFAULT 0,
  dias_ejecutados   INTEGER NOT NULL DEFAULT 0,
  dias_pagables     INTEGER NOT NULL DEFAULT 0,
  valor_dia         REAL,
  total             REAL,
  planilla_id       INTEGER REFERENCES planillas(id),
  estado            TEXT NOT NULL DEFAULT 'borrador',
                    -- borrador | cerrada | aprobada
  generada_por      INTEGER NOT NULL,
  generada_en       TEXT NOT NULL,
  UNIQUE (periodo, vehiculo_id)
);

-- ---------------------------------------------------------------------------
-- 8. EVENTOS / NOVEDADES
-- ---------------------------------------------------------------------------

CREATE TABLE eventos (
  id            INTEGER PRIMARY KEY,
  trayecto_id   INTEGER REFERENCES trayectos(id),
  vehiculo_id   INTEGER REFERENCES vehiculos(id),
  persona_id    INTEGER REFERENCES personas(id),
  tipo          TEXT NOT NULL,
                -- varada | accidente | reten | bloqueo_via | derrumbe |
                -- orden_publico | falla_comunicaciones | negacion_paso |
                -- incidente_paciente | retraso | cancelacion | tanqueo |
                -- mantenimiento | cambio_conductor | novedad_distintivo | otro
  gravedad      TEXT NOT NULL DEFAULT 'baja', -- baja | media | alta | critica
  ts_evento     TEXT NOT NULL,
  municipio_id  INTEGER REFERENCES cat_municipios(id),
  lugar         TEXT,
  lat           REAL,
  lon           REAL,
  descripcion   TEXT NOT NULL,
  acciones      TEXT,
  adjunto_url   TEXT,
  estado        TEXT NOT NULL DEFAULT 'abierto', -- abierto | en_gestion | cerrado
  registrado_por INTEGER NOT NULL,
  creado_en     TEXT NOT NULL
);
CREATE INDEX idx_ev_fecha ON eventos(ts_evento);
CREATE INDEX idx_ev_veh   ON eventos(vehiculo_id, ts_evento);

-- ---------------------------------------------------------------------------
-- 9. LOGISTICA
-- ---------------------------------------------------------------------------

CREATE TABLE mantenimientos (
  id                  INTEGER PRIMARY KEY,
  vehiculo_id         INTEGER NOT NULL REFERENCES vehiculos(id),
  clase               TEXT NOT NULL,          -- preventivo | correctivo
  km_evento           INTEGER,
  fecha_inicio        TEXT NOT NULL,
  fecha_fin           TEXT,
  taller              TEXT,
  descripcion         TEXT,
  repuestos           TEXT,
  costo               REAL,
  dias_fuera_servicio INTEGER,
  factura_url         TEXT
);

-- Dias en que un vehiculo NO pudo operar, con su causa y su rango de fechas.
--
-- Es distinto de vehiculos.estado, que dice como esta HOY y no desde cuando; y
-- distinto de mantenimientos, que es el libro de taller (repuestos, costo,
-- factura) de la fase de logistica. Esta tabla responde a una sola pregunta, la
-- que sostiene la liquidacion: que dias estuvo parado cada vehiculo y por que.
--
-- fecha_fin NULL significa que SIGUE fuera de servicio. Es el caso normal
-- cuando lo reporta el conductor desde la via: sabe que se varo, no sabe
-- cuando vuelve.
--
-- Dos periodos del mismo vehiculo no pueden solaparse: si se permitiera, un
-- mismo dia se contaria dos veces y el descuento al contratista quedaria mal.
-- La comprobacion la hace el Worker, porque SQLite no tiene restricciones de
-- rango.
CREATE TABLE fuera_servicio (
  id             INTEGER PRIMARY KEY,
  vehiculo_id    INTEGER NOT NULL REFERENCES vehiculos(id),
  causa          TEXT NOT NULL,
                 -- averia | mantenimiento | accidente | documentos |
                 -- retenido | sin_conductor | otro
  fecha_inicio   TEXT NOT NULL,          -- dia operativo 'YYYY-MM-DD'
  fecha_fin      TEXT,                   -- NULL = sigue fuera de servicio
  descripcion    TEXT,
  taller         TEXT,
  km_evento      INTEGER,
  evento_id      INTEGER REFERENCES eventos(id),  -- la varada que lo origino
  foto_mime      TEXT,
  foto_datos     TEXT,                   -- base64, igual que trayecto_fotos
  registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
  rol_registro   TEXT NOT NULL,          -- conductor | coordinacion | principal
  creado_en      TEXT NOT NULL,
  cerrado_por    INTEGER REFERENCES usuarios(id),
  cerrado_en     TEXT,
  motivo_cierre  TEXT
);
CREATE INDEX idx_fs_veh ON fuera_servicio(vehiculo_id, fecha_inicio);
CREATE INDEX idx_fs_abierto ON fuera_servicio(fecha_fin, vehiculo_id);

CREATE TABLE tanqueos (
  id            INTEGER PRIMARY KEY,
  vehiculo_id   INTEGER NOT NULL REFERENCES vehiculos(id),
  fecha         TEXT NOT NULL,
  galones       REAL,
  valor         REAL,
  km_odometro   INTEGER,
  estacion      TEXT,
  factura_url   TEXT,
  registrado_por INTEGER
);

-- ---------------------------------------------------------------------------
-- 10. USUARIOS, ROLES Y AUDITORIA
-- ---------------------------------------------------------------------------

CREATE TABLE usuarios (
  id            INTEGER PRIMARY KEY,
  persona_id    INTEGER REFERENCES personas(id),
  usuario       TEXT NOT NULL UNIQUE,
  correo        TEXT,
  clave_hash    TEXT NOT NULL,
  rol           TEXT NOT NULL,                -- principal | coordinacion | conductor
  municipio_id  INTEGER REFERENCES cat_municipios(id),
  activo        INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_clave INTEGER NOT NULL DEFAULT 1,
  ultimo_acceso TEXT,
  creado_por    INTEGER,                      -- solo el rol 'principal' puede crear
  creado_en     TEXT NOT NULL
);

CREATE TABLE sesiones (
  id            TEXT PRIMARY KEY,             -- token opaco
  usuario_id    INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada_en     TEXT NOT NULL,
  expira_en     TEXT NOT NULL,
  user_agent    TEXT
);

CREATE TABLE auditoria (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  usuario_id    INTEGER,
  rol           TEXT,
  accion        TEXT NOT NULL,                -- crear | editar | eliminar | validar |
                                              -- exportar | ingresar | anular
  entidad       TEXT NOT NULL,
  entidad_id    INTEGER,
  valor_antes   TEXT,
  valor_despues TEXT
);
CREATE INDEX idx_aud_ts ON auditoria(ts);
CREATE INDEX idx_aud_ent ON auditoria(entidad, entidad_id);

-- Imágenes de configuración (hoy solo el banner institucional). Se guardan en
-- la base como texto base64 en vez de en un almacén de archivos aparte: son una
-- o dos, pesan poco tras comprimirlas en el navegador, y así el respaldo de la
-- base se lleva todo consigo.
CREATE TABLE config_imagenes (
  clave           TEXT PRIMARY KEY,      -- 'banner'
  mime            TEXT NOT NULL,
  datos           TEXT NOT NULL,         -- base64 sin el prefijo data:
  ancho           INTEGER,
  alto            INTEGER,
  bytes           INTEGER,
  actualizado_por INTEGER,
  actualizado_en  TEXT NOT NULL
);

CREATE TABLE parametros (
  clave         TEXT PRIMARY KEY,
  valor         TEXT NOT NULL,
  descripcion   TEXT,
  actualizado_por INTEGER,
  actualizado_en  TEXT
);
