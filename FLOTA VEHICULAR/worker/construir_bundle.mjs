/**
 * Une los 6 módulos del Worker en UN SOLO archivo, para poder pegarlo
 * directamente en el editor del panel web de Cloudflare, sin terminal.
 *
 *   node construir_bundle.mjs
 */
import fs from 'node:fs';

const ORDEN = ['router.js', 'lib.js', 'rutas_admin.js', 'rutas_operacion.js',
                'rutas_fuera_servicio.js', 'index.js'];

const limpiar = (texto) => texto
  // Quitar los import entre módulos (ya no hay módulos separados)
  .replace(/^import\s+[\s\S]*?from\s+'\.\/[^']+';\s*$/gm, '')
  .replace(/^import\s+'\.\/[^']+';\s*$/gm, '')
  // Quitar los bloques export { ... } finales
  .replace(/^export\s*\{[\s\S]*?\};\s*$/gm, '')
  // export const/function/async function -> declaración normal
  .replace(/^export\s+(const|function|async function|class)\s/gm, '$1 ');

let salida = `/**
 * FLOTA VEHICULAR HRNO — Worker completo en un solo archivo
 *
 * ESE Hospital Regional Noroccidental · Coordinación de Salud Pública
 *
 * ARCHIVO GENERADO — no editar a mano.
 * Se produce con:  node construir_bundle.mjs
 * El código fuente está en src/ (router, lib, rutas_admin, rutas_operacion,
 * rutas_fuera_servicio, index).
 *
 * Este archivo existe para poder pegarlo en el editor del panel web de
 * Cloudflare, sin necesidad de instalar nada ni usar la terminal.
 */

`;

for (const archivo of ORDEN) {
  const contenido = limpiar(fs.readFileSync(`src/${archivo}`, 'utf8'));
  salida += `\n// ${'═'.repeat(72)}\n// ${archivo}\n// ${'═'.repeat(72)}\n`;
  salida += contenido.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

fs.writeFileSync('flota-worker-completo.js', salida);
const lineas = salida.split('\n').length;
console.log(`flota-worker-completo.js generado: ${lineas} líneas, ${(salida.length / 1024).toFixed(1)} KB`);
