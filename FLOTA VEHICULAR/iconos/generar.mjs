/**
 * Genera los iconos de la aplicación a partir del logotipo de la marca.
 *
 * REGLA: el logotipo NO SE TOCA. `logo-original.png` es el que entregó diseño
 * —cuadro amarillo, la muesca de «By PascalIA» arriba a la derecha, el emblema
 * en el centro y la palabra Flota abajo— y todos los iconos son ese mismo
 * dibujo, entero, sin recortar nada. Lo único que cambia es el tamaño.
 *
 * Lo único que hace este generador, aparte de cambiar el tamaño, es redondear
 * las esquinas al mismo radio que ya tiene el cuadro amarillo, para quitar el
 * blanco que el archivo lleva por fuera de la curva. Sin eso, en el escritorio
 * del teléfono se verían cuatro esquinas blancas alrededor del icono.
 *
 * Cambiar la marca es cambiar ESTE archivo y volver a correr el generador: de
 * aquí salen el icono del teléfono, el del navegador, el de iPhone y el que la
 * aplicación muestra en el ingreso y en la cabecera. Por eso no hay ninguna
 * ruta de imagen escrita a mano en index.html que haya que ir a buscar.
 *
 * NO SE DECLARA ICONO CON MÁSCARA, a propósito. Un icono con máscara lo recorta
 * Android en un círculo, así que para que el círculo no se comiera la muesca de
 * PascalIA ni la palabra Flota había que encoger el logotipo y dejarlo pequeño
 * en mitad de un cuadro de color. Se veía encogido y con las esquinas del
 * logotipo marcadas por dentro — que es justo lo que se reportó desde un
 * teléfono. Sin icono con máscara, Android usa el normal y el logotipo se ve
 * entero y a su tamaño, que es como diseño lo entregó: el archivo YA viene con
 * forma de icono, con su cuadro amarillo y sus esquinas redondeadas.
 *
 * Aparte va `pascalia.png`, la firma del pie de cada pantalla. Esa no sale del
 * logotipo de FLOTA sino de `pascalia-fuente.png`, que es la marca de PascalIA
 * en horizontal, que es como se lee bien en una línea.
 *
 * Chrome solo ofrece "Instalar" si el manifiesto trae iconos PNG reales de
 * 192 y 512 px; iPhone, por su parte, solo lee apple-touch-icon.png. Por eso
 * todo esto se genera una vez aquí y queda versionado como archivos.
 *
 *   node iconos/generar.mjs iconos
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright no es dependencia de la aplicación: solo hace falta el día que se
// quiera rediseñar el icono. Si no está instalado: npm i -g playwright
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

// fileURLToPath y no .pathname: la carpeta se llama "FLOTA VEHICULAR", con
// espacio, y en la URL viene como %20.
const AQUI = fileURLToPath(new URL('.', import.meta.url));
const destino = process.argv[2] ?? AQUI;
fs.mkdirSync(destino, { recursive: true });

/**
 * El amarillo del borde del logotipo. Solo se ve en el píxel suavizado del
 * filo redondeado: el dibujo cubre el resto. Se toma del borde y no del
 * centro porque el fondo del logotipo es un degradado.
 */
const FONDO = '#fcc806';
/**
 * Radio de las esquinas del cuadro, medido sobre el original: la curva arranca
 * en x≈46 para y=20, lo que da un radio de unos 109 px sobre 800. Se recorta un
 * pelo por fuera (0.138) para que no sobreviva ni un píxel del blanco que el
 * original lleva por fuera de la curva.
 */
const RADIO = 0.138;
const logo = fs.readFileSync(path.join(AQUI, 'logo-original.png')).toString('base64');

/**
 * @param size   lado en píxeles
 * @param radio  radio de las esquinas, en fracción del lado; 0 = cuadrado
 */
function pagina(size, radio) {
  return `<body style="margin:0">
    <div style="width:${size}px;height:${size}px;border-radius:${size * radio}px;
                background:${FONDO};overflow:hidden">
      <img src="data:image/png;base64,${logo}"
           style="width:${size}px;height:${size}px;display:block">
    </div>
  </body>`;
}

const PIEZAS = [
  // El icono de la aplicación: el logotipo entero, a sangre. Es lo que se ve en
  // el escritorio del teléfono, en la pantalla de arranque, en el cuadro de
  // instalación y en la lista de aplicaciones abiertas.
  { archivo: 'icono-192.png',        size: 192, radio: RADIO },
  { archivo: 'icono-512.png',        size: 512, radio: RADIO },
  // iPhone redondea por su cuenta: aquí va cuadrado, a sangre.
  { archivo: 'apple-touch-icon.png', size: 180, radio: 0 },
  // El que la aplicación muestra en el ingreso y en la cabecera.
  { archivo: 'marca.png',            size: 192, radio: RADIO },
  // Los del navegador.
  { archivo: 'favicon-32.png',       size: 32,  radio: RADIO },
  { archivo: 'favicon-16.png',       size: 16,  radio: RADIO },
];

const navegador = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const pag = await navegador.newPage({ deviceScaleFactor: 1 });

for (const p of PIEZAS) {
  await pag.setViewportSize({ width: p.size, height: p.size });
  await pag.setContent(pagina(p.size, p.radio));
  await pag.waitForLoadState('load');
  // Esquinas transparentes: sobre el fondo oscuro de un teléfono, unas esquinas
  // blancas delatarían el recuadro del icono.
  const png = await pag.screenshot({ omitBackground: true,
    clip: { x: 0, y: 0, width: p.size, height: p.size } });
  fs.writeFileSync(path.join(destino, p.archivo), png);
  console.log(`  ${p.archivo.padEnd(24)} ${p.size}x${p.size}  ${png.length} bytes`);
}

// ── La firma de PascalIA del pie, en horizontal ─────────────────────────────
{
  const FUENTE = { x: 174, y: 3, ancho: 454, alto: 120, lienzo: 800 };
  const ESCALA = 2;                 // al doble, para que se vea nítida
  const b64 = fs.readFileSync(path.join(AQUI, 'pascalia-fuente.png')).toString('base64');
  const w = FUENTE.ancho * ESCALA, h = FUENTE.alto * ESCALA;
  await pag.setViewportSize({ width: w, height: h });
  await pag.setContent(`<body style="margin:0">
    <div style="width:${w}px;height:${h}px;overflow:hidden;position:relative;background:#fff">
      <img src="data:image/png;base64,${b64}"
           style="position:absolute;width:${FUENTE.lienzo * ESCALA}px;
                  left:${-FUENTE.x * ESCALA}px;top:${-FUENTE.y * ESCALA}px">
    </div></body>`);
  await pag.waitForLoadState('load');
  const png = await pag.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
  fs.writeFileSync(path.join(destino, 'pascalia.png'), png);
  console.log(`  ${'pascalia.png'.padEnd(24)} ${w}x${h}  ${png.length} bytes`);
}

await navegador.close();
