/**
 * Convierte los manuales de Markdown a PDF.
 *
 *   node manuales/hacer_pdf.mjs
 *
 * El Markdown es la fuente: vive en el repositorio, se lee en GitHub y se
 * corrige con el código. El PDF es para imprimir y entregar, y se vuelve a
 * generar cada vez. Nunca se edita el PDF a mano.
 *
 * El convertidor de Markdown va escrito aquí, a mano y corto. Cubre
 * exactamente lo que los manuales usan y nada más: encabezados, párrafos,
 * listas, tablas, citas, imágenes, negrita, cursiva y código. Traer una
 * dependencia para esto costaría más de lo que resuelve, y el resto del
 * proyecto no tiene ninguna.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const AQUI = fileURLToPath(new URL('.', import.meta.url));
const MANUALES = ['MANUAL_CONDUCTOR', 'MANUAL_COORDINACION', 'MANUAL_ADMINISTRADOR'];

// ── Markdown → HTML ─────────────────────────────────────────────────────────

const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Lo que va dentro de una línea: negrita, cursiva, código y enlaces. */
function enLinea(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(—])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Separa el encabezado de datos del cuerpo. */
function portada(texto) {
  const m = texto.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { datos: {}, cuerpo: texto };
  const datos = {};
  for (const linea of m[1].split('\n')) {
    const i = linea.indexOf(':');
    if (i > 0) datos[linea.slice(0, i).trim()] = linea.slice(i + 1).trim();
  }
  return { datos, cuerpo: texto.slice(m[0].length) };
}

function aHtml(md) {
  const lineas = md.split('\n');
  const fuera = [];
  let i = 0;

  const cerrarLista = (tipo) => {
    const items = [];
    const marca = tipo === 'ol' ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
    while (i < lineas.length && marca.test(lineas[i])) {
      let t = lineas[i].replace(marca, '');
      i++;
      // Una línea suelta debajo, con sangría, continúa el mismo punto.
      while (i < lineas.length && /^\s{2,}\S/.test(lineas[i]) && !marca.test(lineas[i])) {
        t += ' ' + lineas[i].trim(); i++;
      }
      items.push(`<li>${enLinea(t)}</li>`);
    }
    fuera.push(`<${tipo}>${items.join('')}</${tipo}>`);
  };

  while (i < lineas.length) {
    const l = lineas[i];

    if (!l.trim()) { i++; continue; }

    // Imagen sola en su renglón: va como figura, con su pie.
    const img = l.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      fuera.push(`<figure><img src="${img[2]}" alt="${esc(img[1])}">`
               + (img[1] ? `<figcaption>${enLinea(img[1])}</figcaption>` : '') + '</figure>');
      i++; continue;
    }

    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { fuera.push(`<h${h[1].length}>${enLinea(h[2])}</h${h[1].length}>`); i++; continue; }

    if (/^---+\s*$/.test(l)) { fuera.push('<hr>'); i++; continue; }

    if (/^\s*[-*]\s+/.test(l)) { cerrarLista('ul'); continue; }
    if (/^\s*\d+\.\s+/.test(l)) { cerrarLista('ol'); continue; }

    if (l.startsWith('>')) {
      const parrafos = [];
      while (i < lineas.length && lineas[i].startsWith('>')) {
        parrafos.push(lineas[i].replace(/^>\s?/, '')); i++;
      }
      fuera.push(`<blockquote>${enLinea(parrafos.join(' ').trim())}</blockquote>`);
      continue;
    }

    // Tabla: cabecera, separador de guiones, y las filas.
    if (l.includes('|') && /^\s*\|?[\s:-]*-[\s|:-]*$/.test(lineas[i + 1] || '')) {
      const celdas = (x) => x.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
      const cab = celdas(l).map(c => `<th>${enLinea(c.trim())}</th>`).join('');
      i += 2;
      const filas = [];
      while (i < lineas.length && lineas[i].includes('|')) {
        filas.push('<tr>' + celdas(lineas[i]).map(c => `<td>${enLinea(c.trim())}</td>`).join('') + '</tr>');
        i++;
      }
      fuera.push(`<table><thead><tr>${cab}</tr></thead><tbody>${filas.join('')}</tbody></table>`);
      continue;
    }

    // Párrafo: todo lo seguido hasta un renglón en blanco.
    const p = [];
    while (i < lineas.length && lineas[i].trim() && !/^[#>|]/.test(lineas[i])
           && !/^\s*([-*]|\d+\.)\s+/.test(lineas[i]) && !/^---+\s*$/.test(lineas[i])) {
      p.push(lineas[i].trim()); i++;
    }
    if (p.length) fuera.push(`<p>${enLinea(p.join(' '))}</p>`);
    else i++;
  }
  return fuera.join('\n');
}

// ── La hoja de estilo ───────────────────────────────────────────────────────
//
// Los mismos colores y las mismas tipografías de la aplicación: quien tenga el
// manual al lado de la pantalla tiene que reconocer que son la misma cosa.
// Source Serif en los títulos, Inter en el texto, el azul institucional y el
// amarillo de la marca.
const ESTILO = `
@page { size: A4; margin: 18mm 16mm 20mm; }
:root{
  --azul:#1e5aa8; --azul-osc:#15447f; --amarillo:#fcc806;
  --texto:#16202b; --suave:#4a5867; --tenue:#75828f;
  --borde:#dde3ea; --fondo-suave:#f7f9fb;
  --ambar:#a2620a; --ambar-glow:#fdf6ea; --verde:#0a7d57; --rojo:#c22e24;
}
*{box-sizing:border-box}
body{
  margin:0; color:var(--texto);
  font:400 10.2pt/1.6 'Inter',-apple-system,'Segoe UI',sans-serif;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
h1,h2,h3,h4{ font-family:'Source Serif 4',Georgia,serif; line-height:1.2; margin:0; }

/* ── Portada ─────────────────────────────────────────────── */
.portada{
  height:245mm; display:flex; flex-direction:column; justify-content:space-between;
  page-break-after:always; text-align:left;
}
.portada .alto{ padding-top:26mm; }
.portada .marca{ width:34mm; height:34mm; border-radius:5mm; margin-bottom:13mm; }
.portada h1{ font-size:34pt; margin:0 0 3mm; letter-spacing:-.015em; }
.portada .sub{ font-size:13pt; color:var(--suave); }
.portada .raya{
  width:46mm; height:3.5mm; border-radius:2mm; margin-top:11mm;
  background:linear-gradient(90deg,var(--amarillo),var(--azul));
}
/* Quién lo hizo y para quién. Va abajo y separado del título: la aplicación
   es de PascalIA, la operación que administra es de la ESE, y el manual no
   puede dar a entender lo contrario. */
.portada .credito{ padding-bottom:4mm; }
.portada .rotulo{
  font:600 8.2pt/1.4 'Inter',sans-serif; letter-spacing:.11em;
  text-transform:uppercase; color:var(--tenue); margin-bottom:3.5mm;
}
/* pascalia.png lleva aire alrededor —el recorte útil empieza en el píxel 105
   de 908—, así que a 11 mm de alto sobran 4,8 mm por la izquierda. Sin
   corregirlo, el logotipo queda metido hacia adentro y desalineado del
   «Desarrollado por» y del «para la ESE…» que lleva encima y debajo. */
.portada .autor{
  height:11mm; width:auto; display:block;
  margin:0 0 5mm -4.8mm;
}
.portada .para{ font-size:10.5pt; color:var(--suave); line-height:1.6; }
.portada .para strong{ color:var(--texto); }
.portada .fecha{
  margin-top:7mm; padding-top:4mm; border-top:.3mm solid var(--borde);
  font-size:8.6pt; color:var(--tenue);
}

/* ── Índice ──────────────────────────────────────────────── */
.indice{ page-break-after:always; }
.indice h2{ margin-top:0; }
.indice ol{ padding-left:0; list-style:none; counter-reset:sec; margin-top:6mm; }
.indice li{
  counter-increment:sec; margin-bottom:3.4mm; padding-left:11mm;
  position:relative; font-size:11pt;
}
.indice li::before{
  content:counter(sec); position:absolute; left:0; top:.2mm;
  width:7mm; text-align:right;
  font:700 10pt/1.4 'Inter',sans-serif; color:var(--azul);
}

/* ── Texto ───────────────────────────────────────────────── */
h1{ font-size:21pt; margin:0 0 5mm; letter-spacing:-.01em; }
h2{
  font-size:14.5pt; margin:11mm 0 3.5mm; padding-bottom:2mm;
  border-bottom:.6mm solid var(--azul); page-break-after:avoid;
}
h3{ font-size:11.8pt; margin:7mm 0 2.5mm; color:var(--azul-osc); page-break-after:avoid; }
p{ margin:0 0 3.2mm; }
strong{ font-weight:700; }
code{
  font:500 9pt/1 ui-monospace,'SF Mono',Menlo,monospace;
  background:var(--fondo-suave); border:.2mm solid var(--borde);
  border-radius:1mm; padding:.4mm 1.2mm;
}
a{ color:var(--azul); text-decoration:none; }
hr{ border:0; border-top:.3mm solid var(--borde); margin:8mm 0; }

ul,ol{ margin:0 0 3.5mm; padding-left:6mm; }
li{ margin-bottom:1.6mm; }
li::marker{ color:var(--azul); font-weight:600; }

/* ── Cita: la advertencia ────────────────────────────────── */
blockquote{
  margin:4.5mm 0; padding:3.2mm 4.5mm;
  background:var(--ambar-glow); border-left:1.2mm solid var(--ambar);
  border-radius:0 2mm 2mm 0; color:#6b4409; font-size:9.8pt;
  page-break-inside:avoid;
}
blockquote strong{ color:#4e3105; }

/* ── Tablas ──────────────────────────────────────────────── */
table{
  width:100%; border-collapse:collapse; margin:4mm 0 5mm;
  font-size:9.4pt; page-break-inside:avoid;
}
th{
  text-align:left; background:var(--fondo-suave); color:var(--suave);
  font:700 8.2pt/1.3 'Inter',sans-serif; letter-spacing:.05em;
  text-transform:uppercase; padding:2.4mm 3mm;
  border-bottom:.4mm solid var(--borde);
}
td{ padding:2.4mm 3mm; border-bottom:.2mm solid var(--borde); vertical-align:top; }
tr:last-child td{ border-bottom:0; }

/* ── Capturas ────────────────────────────────────────────── */
figure{
  margin:5mm 0 6mm; page-break-inside:avoid; text-align:center;
}
/* Una captura ancha la limita el ancho de la caja; una alta y angosta —la de
   un teléfono o la de una ventana— la limita el alto. 140 mm es lo más grande
   que cabe dejando sitio para el pie y algo de texto en la misma página. */
figure img{
  max-width:100%; max-height:140mm; width:auto;
  border:.25mm solid var(--borde); border-radius:2mm;
}
figcaption{
  margin-top:2mm; font-size:8.4pt; color:var(--tenue); font-style:italic;
}
`;

// ── Armado ──────────────────────────────────────────────────────────────────

const logo = fs.readFileSync(path.join(AQUI, '../iconos/icono-512.png')).toString('base64');
// La firma de PascalIA en horizontal, la misma del pie de la aplicación.
const pascalia = fs.readFileSync(path.join(AQUI, '../iconos/pascalia.png')).toString('base64');
const hoy = new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });

const nav = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await (await nav.newContext({ locale: 'es-CO' })).newPage();

for (const nombre of MANUALES) {
  const md = fs.readFileSync(path.join(AQUI, nombre + '.md'), 'utf8');
  const { datos, cuerpo } = portada(md);
  // El título ya va en la portada; repetirlo en la primera página sobra.
  const sinTitulo = cuerpo.replace(/^#\s+.*\n/, '');

  // Índice: solo los encabezados de nivel 2, que son las secciones. Sin
  // número de página —habría que renderizar dos veces para saberlos— pero las
  // secciones ya van numeradas en su propio título, que es lo que se busca al
  // abrir un manual: en cuál de las nueve está lo que necesito.
  const secciones = [...sinTitulo.matchAll(/^##\s+(.*)$/gm)].map(m => m[1]);
  const indice = secciones.length < 3 ? '' : `
<section class="indice">
  <h2>Contenido</h2>
  <ol>${secciones.map(t => `<li>${enLinea(t.replace(/^\d+\s*·\s*/, ''))}</li>`).join('')}</ol>
</section>`;

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${ESTILO}</style></head><body>
<section class="portada">
  <div class="alto">
    <img class="marca" src="data:image/png;base64,${logo}" alt="">
    <h1>${esc(datos.titulo || nombre)}</h1>
    <div class="sub">${esc(datos.subtitulo || '')}</div>
    <div class="raya"></div>
  </div>
  <div class="credito">
    <div class="rotulo">Desarrollado por</div>
    <img class="autor" src="data:image/png;base64,${pascalia}" alt="${esc(datos.autor || '')}">
    <div class="para">
      para la <strong>${esc(datos.para || '')}</strong><br>
      ${esc(datos.area || '')}
    </div>
    <div class="fecha">Actualizado el ${hoy}</div>
  </div>
</section>
${indice}
${aHtml(sinTitulo)}
</body></html>`;

  const htmlRuta = path.join(AQUI, '.' + nombre + '.html');
  fs.writeFileSync(htmlRuta, html);
  await pag.goto('file://' + htmlRuta, { waitUntil: 'networkidle' });
  // Las tipografías llegan de la red: sin esperarlas, el PDF sale con la
  // sustituta del sistema y el reemplazo se nota en los títulos.
  await pag.evaluate(() => document.fonts.ready);
  await pag.waitForTimeout(400);

  const pdf = path.join(AQUI, nombre + '.pdf');
  await pag.pdf({
    path: pdf, format: 'A4', printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;margin:0 16mm;font:400 7pt Inter,sans-serif;
      color:#9aa5b1;display:flex;justify-content:space-between;">
      <span>${esc(datos.titulo || '')} · Flota Vehicular · PascalIA para la ESE HRNO</span>
      <span class="pageNumber"></span></div>`,
    margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
  });
  fs.unlinkSync(htmlRuta);
  console.log(`  ${(nombre + '.pdf').padEnd(30)} ${(fs.statSync(pdf).size / 1048576).toFixed(1)} MB`);
}

await nav.close();
