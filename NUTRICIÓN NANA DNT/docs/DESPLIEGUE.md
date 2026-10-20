# Puesta en marcha

## 1 · La base de datos ya está lista

Las 14 migraciones se aplicaron al proyecto **SI-APS HRNO** (`wttljozqyaxlzilomnef`).
No hay que ejecutar nada. El histórico está en `sql/README.md`.

Ya quedaron cargados los informes de enero a agosto de 2026: **242 niños, 242 casos y
271 seguimientos** con los puntajes Z recalculados.

## 2 · Primer ingreso

`danto0702@gmail.com` ya es administrador del módulo con los cuatro municipios asignados.
Entre con la misma contraseña del Portal de Salud Pública.

## 3 · Crear los usuarios

Dos caminos, los dos en **Administración → Usuarios y permisos**:

- **Usted los crea** con «➕ Crear usuario». Define nombre, correo, rol y municipios, y el
  sistema devuelve una **contraseña provisional** que usted le entrega a la persona. Es el
  camino normal: no hay que esperar a que nadie se registre.
- **La persona se autoregistra** desde `login.html` → «Solicitar acceso». Queda pendiente
  hasta que usted la apruebe desde el mismo panel.

Si el correo ya tiene cuenta del Portal de Salud Pública, **no se crea otra**: se le da
acceso al módulo y conserva su contraseña. En ese caso el sistema no devuelve contraseña
provisional y lo dice.

La contraseña provisional **no se puede volver a consultar**. Si se pierde, en «Gestionar»
hay un botón «Contraseña nueva» que genera otra.

### Si alguien olvida su contraseña

No hay correo de recuperación: el restablecimiento depende de usted.

1. La persona entra a `login.html` → «Olvidé mi contraseña» y escribe su correo.
2. A usted le aparece en **Administración → Usuarios**, en el recuadro rojo
   «🔑 Contraseñas por restablecer», con su nombre, su cargo y su teléfono.
3. Pulsa **Generar contraseña** y se la dicta o se la envía por donde acostumbren.
4. Al entrar, el módulo le exige elegir una propia antes de dejarla continuar.

En la tabla de usuarios, quien todavía no ha elegido contraseña propia lleva la marca
**🔑 provisional** junto a su estado. Si ve una solicitud repetida o que ya resolvió por
teléfono, **Descartar** la saca de la bandeja sin generar nada.

> Un responsable **sin municipio asignado no ve ningún caso**. Es el error más probable del
> primer día, así que el sistema ya no deja guardarlo así.

## 4 · Repartir los casos

Los 242 casos cargados están **sin responsable asignado**. Desde la ficha de cada caso
(pestaña Resumen → «Reasignar responsable») el coordinador o el administrador los reparte.

Todos aparecen con el control **vencido**, porque la última medición cargada es de julio
y el seguimiento es semanal. Eso es correcto: es exactamente la lista de trabajo con la que
arranca el equipo.

## 5 · Cargues mensuales

Cada mes, el responsable entra a **Cargar datos** y sube el Excel `Inf_PrimeraInfancia`
de su sede sin modificar los encabezados. El sistema:

1. Valida la estructura y muestra un análisis **antes** de guardar nada.
2. Agrupa las atenciones por documento y recalcula los puntajes Z.
3. Omite lo que ya está cargado (mismo caso y misma fecha).
4. Avisa si un niño ya está registrado en otro municipio, para que lo resuelva el coordinador.

## 6 · Sincronizar la carpeta local

El proyecto vive en el repositorio del portal. Para tenerlo en
`C:\Users\danto\Desktop\DANILO 2026\NUTRICIÓN\NANA DNT`:

```powershell
cd "C:\Users\danto\Desktop\DANILO 2026\NUTRICIÓN"
git clone https://github.com/danto0702/portal-salud-publica-hrno.git "NANA DNT"
```

Y después de cada cambio:

```powershell
cd "C:\Users\danto\Desktop\DANILO 2026\NUTRICIÓN\NANA DNT"
git pull
```

El módulo queda en la subcarpeta `NUTRICIÓN NANA DNT` de ese clon.

## 7 · Publicación

GitHub Pages sirve desde la raíz de `main`. Una vez fusionada la rama, el módulo queda en:

```
https://danto0702.github.io/portal-salud-publica-hrno/NUTRICI%C3%93N%20NANA%20DNT/
```

Recuerde el caché de 1 a 5 minutos del CDN: tras un push, `Ctrl+Shift+R`.

## Pendientes

- **Correo**: las alertas son sólo en pantalla. Para notificaciones por correo hay que
  conectar un proveedor SMTP y una función de Supabase.
- **Logo institucional**: el encabezado usa un emoji. Si deja el PNG del logo en `assets/`,
  se reemplaza en un minuto.
- **Repositorio propio**: el App de GitHub de la sesión no tiene permiso para crear
  repositorios. Las instrucciones para extraerlo están en el README.
