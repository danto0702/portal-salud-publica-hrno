# Manuales de Flota Vehicular

Tres manuales, uno por rol. Separados a propósito: nadie lee el manual de otro,
y un documento que le habla a los tres a la vez no le sirve a ninguno.

| Manual | Para quién | Qué cubre |
|---|---|---|
| **[Conductor](MANUAL_CONDUCTOR.md)** | Los conductores | Instalar, entrar, marcar salida y llegada, checklist, novedades, averías, sin señal |
| **[Coordinación](MANUAL_COORDINACION.md)** | Coordinación de Salud Pública | Itinerario, pincel, plantilla de Excel, solicitudes de aprobación, viajes, novedades, dashboard |
| **[Administrador](MANUAL_ADMINISTRADOR.md)** | La administración | Aprobar y rechazar, corregir viajes, informes firmados y reemisión, vehículos, personas, usuarios, ajustes, auditoría |

**El Markdown es la fuente.** Se lee en GitHub, se corrige junto con el código
y es lo que hay que editar. El PDF se genera a partir de él, para imprimir y
entregar; **nunca se edita el PDF a mano**, porque la siguiente generación lo
pisa.

---

## Volver a generarlos

Después de cambiar la aplicación —una pantalla nueva, un botón que se movió—:

```
node manuales/capturas.mjs     # vuelve a tomar las 35 capturas
node manuales/hacer_pdf.mjs    # vuelve a armar los tres PDF
```

### `capturas.mjs`

Levanta el servidor de ejemplo, entra con cada rol y toma las capturas en
`img/`. Al final las adelgaza con ImageMagick si está instalado (9 MB → 2,5 MB,
sin pérdida visible); si no está, las deja como salieron.

> Las capturas se toman **contra el servidor de ejemplo**, con sus datos
> inventados, **nunca contra producción**: un manual lleva nombres, placas y
> cédulas en cada pantalla.

El orden importa: coordinación deja una solicitud pendiente que el manual del
administrador necesita para poder enseñar la bandeja con algo dentro.

### `hacer_pdf.mjs`

Convierte el Markdown a PDF con el mismo Chromium de las pruebas. El
convertidor de Markdown va escrito a mano dentro del archivo y cubre
exactamente lo que los manuales usan: encabezados, párrafos, listas, tablas,
citas, imágenes, negrita, cursiva y código. El resto del proyecto no tiene
dependencias y esto tampoco necesita una.

La portada, el índice y la hoja de estilo salen de ahí. Los colores y las
tipografías son los de la aplicación —Source Serif en los títulos, Inter en el
texto, el azul institucional y el amarillo de la marca— para que quien tenga el
manual al lado de la pantalla reconozca que son la misma cosa.

El encabezado de datos de cada `.md` (`titulo`, `subtitulo`, `entidad`) es lo
que se imprime en la portada.

---

## Lo que NO son estos manuales

- **[INSTALAR_EN_EL_CELULAR.md](../INSTALAR_EN_EL_CELULAR.md)** — el
  instructivo de una página para entregar con el código QR. El manual del
  conductor lo incluye, pero esto se imprime suelto.
- **[MENSAJE_WHATSAPP_CONDUCTORES.md](../MENSAJE_WHATSAPP_CONDUCTORES.md)** —
  los mensajes para mandar por WhatsApp, uno por pantalla. Es para enseñar a
  distancia, no para consultar.
- **[DEPLOY.md](../DEPLOY.md)** y
  **[PUBLICAR_SIN_TERMINAL.md](../PUBLICAR_SIN_TERMINAL.md)** — cómo se publica.
- **[PROJECT.md](../PROJECT.md)** — la bitácora técnica: por qué cada cosa está
  hecha como está. No es un manual de uso.
