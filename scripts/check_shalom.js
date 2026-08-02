/**
 * check_shalom.js
 * ------------------------------------------------------------
 * Corre cada 30 min vía GitHub Actions (ver .github/workflows/check.yml).
 * 1. Lee de Back4App las guías que aún no están "entregado".
 * 2. Consulta cada una en la página PÚBLICA de rastreo de Shalom
 *    (https://shalom.com.pe/rastrea) — no requiere login.
 *    - Si el envío tiene "guia" + "codigo": usa el formulario normal.
 *    - Si el envío tiene "oseId" (viene de un QR escaneado): genera una
 *      imagen del QR, la convierte en un video, emula un iPhone (el
 *      botón de escanear solo existe en la versión móvil de la página),
 *      y le hace creer al navegador automatizado que ese video es su
 *      cámara — así la propia página de Shalom "escanea" el QR igual
 *      que lo haría un celular real, sin falsificar tokens ni headers.
 * 3. Actualiza Back4App con el nuevo estado.
 *
 * Nota: el flujo por oseId (QR) es más frágil que el de guía+código,
 * porque depende de que Shalom no cambie el diseño de ese botón. Si
 * empieza a fallar, revisar el selector en consultarPorOseId().
 * ------------------------------------------------------------
 */

const { chromium, devices } = require('playwright');
const QRCode = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACK4APP_APP_ID = process.env.BACK4APP_APP_ID;
const BACK4APP_MASTER_KEY = process.env.BACK4APP_MASTER_KEY; // solo en GitHub Secrets, nunca en el frontend

const PARSE_URL = 'https://parseapi.back4app.com';
const CLASE = 'EnvioShalom';

const variablesRequeridas = { BACK4APP_APP_ID, BACK4APP_MASTER_KEY };
const faltantes = Object.entries(variablesRequeridas)
    .filter(([nombre, valor]) => !valor)
    .map(([nombre]) => nombre);

if (faltantes.length > 0) {
    console.error(`❌ Faltan estas variables de entorno específicamente: ${faltantes.join(', ')}`);
    console.error('   (Revisa en GitHub: Settings → Secrets and variables → Actions → Repository secrets)');
    process.exit(1);
}

async function parseFetch(metodo, objectId, body, query) {
    let url = `${PARSE_URL}/classes/${CLASE}`;
    if (objectId) url += `/${objectId}`;

    if (metodo === 'GET' && query) {
        const params = new URLSearchParams();
        if (query.where) params.set('where', JSON.stringify(query.where));
        url += `?${params.toString()}`;
    }

    const res = await fetch(url, {
        method: metodo,
        headers: {
            'X-Parse-Application-Id': BACK4APP_APP_ID,
            'X-Parse-Master-Key': BACK4APP_MASTER_KEY,
            'Content-Type': 'application/json'
        },
        body: (metodo === 'POST' || metodo === 'PUT') ? JSON.stringify(body || {}) : undefined
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `Error Back4App (${res.status})`);
    }
    return data;
}

async function getGuiasPendientes() {
    const resultado = await parseFetch('GET', null, null, { where: { estado: { '$ne': 'entregado' } } });
    return resultado.results || [];
}

async function actualizarEnvio(objectId, cambios) {
    return parseFetch('PUT', objectId, cambios);
}

// ============================================
// Lectura del resultado en pantalla (compartida por los dos métodos)
// ============================================
async function leerResultadoEnPantalla(page, timeoutMs = 8000) {
    const estadoLocator = page.locator('.text-4xl.font-bold.text-red-color-sidebar').first();

    try {
        await estadoLocator.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch (err) {
        return { estado: 'error', detalle: 'No se encontró resultado en pantalla tras la búsqueda.' };
    }

    const estadoTexto = (await estadoLocator.innerText()).trim();
    const detalleTexto = await page.locator('p.text-silver-title').first().innerText().catch(() => '');
    // N° de Orden que Shalom muestra en el resultado — útil para
    // "rellenar" el campo guia cuando el envío se registró solo con
    // el QR (oseId) y todavía no sabíamos el número impreso.
    const ordenTexto = await page.locator('p:has-text("N° DE ORDEN")').first().innerText().catch(() => '');
    const guiaDetectada = (ordenTexto.match(/(\d{5,})/) || [])[1] || null;

    const normalizado = estadoTexto.toLowerCase();
    const entregado = /entregad/.test(normalizado);

    return {
        estado: entregado ? 'entregado' : 'en_transito',
        detalle: detalleTexto ? `${estadoTexto} — ${detalleTexto.trim()}` : estadoTexto,
        guiaDetectada
    };
}

// ============================================
// Método 1: N° de Orden + Código (formulario normal)
// ============================================
async function consultarGuia(page, guia, codigo) {
    await page.goto('https://shalom.com.pe/rastrea', { waitUntil: 'networkidle' });

    // El formulario de rastreo tiene DOS campos obligatorios:
    //   - N° de Orden (input maxlength=8)
    //   - Código de Orden (input maxlength=4, código de seguridad de 4 dígitos)
    // y se envía con un botón real (type="submit"), no basta con Enter.
    await page.fill('input[placeholder="N° de Orden"]', guia);
    await page.fill('input[placeholder="Código de Orden"]', codigo);
    await page.click('button[type="submit"]:has-text("Buscar")');

    return leerResultadoEnPantalla(page);
}

// ============================================
// Método 2: QR (cámara falsa) — para envíos registrados solo con oseId
// ============================================

// Genera un video corto que muestra el QR fijo, en el formato que
// Chromium acepta para "cámara falsa" (y4m).
function generarVideoQR(contenidoQR, carpetaTemp) {
    const rutaPng = path.join(carpetaTemp, 'qr.png');
    const rutaVideo = path.join(carpetaTemp, 'qr.y4m');

    return QRCode.toFile(rutaPng, contenidoQR, { width: 480, margin: 3 }).then(() => {
        execFileSync('ffmpeg', [
            '-y',
            '-loop', '1',
            '-i', rutaPng,
            '-t', '12',
            '-r', '10',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=480:480',
            rutaVideo
        ], { stdio: 'pipe' });
        return rutaVideo;
    });
}

async function consultarPorOseId(oseId) {
    const carpetaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'shalom-qr-'));
    let browser;

    // Carpeta de diagnóstico: capturas y logs quedan aquí para poder
    // subirlos como "artifact" de GitHub Actions y revisarlos después,
    // sin depender de adivinar qué pasó.
    const carpetaDebug = path.join(process.cwd(), 'debug-oseid');
    fs.mkdirSync(carpetaDebug, { recursive: true });
    const logsConsola = [];

    try {
        const rutaVideo = await generarVideoQR(`${oseId}/document/1/`, carpetaTemp);

        // Un navegador nuevo por cada QR: los flags de "cámara falsa" se
        // fijan al lanzar el navegador, y el video cambia por envío.
        browser = await chromium.launch({
            headless: true,
            args: [
                '--use-fake-device-for-media-stream',
                `--use-file-for-fake-video-capture=${rutaVideo}`,
                '--use-fake-ui-for-media-stream' // autoaprueba el permiso de cámara
            ]
        });

        // El botón de escanear usa la clase Tailwind "md:hidden" — solo
        // existe en el DOM cuando el ancho de pantalla es "mobile". Por
        // eso el navegador se emula como un iPhone (si no, el botón ni
        // siquiera se renderiza y no hay nada que clickear).
        const context = await browser.newContext({
            ...devices['iPhone 13'],
            permissions: ['camera']
        });
        const page = await context.newPage();

        page.on('console', msg => logsConsola.push(`[console.${msg.type()}] ${msg.text()}`));
        page.on('pageerror', err => logsConsola.push(`[pageerror] ${err.message}`));
        page.on('requestfailed', req => logsConsola.push(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`));

        await page.goto('https://shalom.com.pe/rastrea', { waitUntil: 'networkidle' });
        await page.screenshot({ path: path.join(carpetaDebug, `${oseId}-1-antes.png`) }).catch(() => {});

        // Selector confirmado contra el HTML real: botón type="button"
        // (no "submit"), con ícono SVG de escáner QR, visible solo en
        // móvil (md:hidden). Se ubica junto al botón "Buscar" dentro del
        // mismo formulario.
        const botonEscanear = page.locator('form button[type="button"]:has(svg[viewBox="0 0 21 22"])').first();
        if (await botonEscanear.count() === 0) {
            return { estado: 'error', detalle: 'No se encontró el botón de escaneo QR en la página (verificar si Shalom cambió su web).' };
        }
        await botonEscanear.click();

        // Captura justo después del click, sin esperar más: aquí se ve
        // si se abrió el modal/cámara o si no pasó nada visible.
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(carpetaDebug, `${oseId}-2-tras-click.png`) }).catch(() => {});

        const resultado = await leerResultadoEnPantalla(page);

        // Captura final, tras esperar el resultado (o el timeout).
        await page.screenshot({ path: path.join(carpetaDebug, `${oseId}-3-final.png`) }).catch(() => {});

        if (resultado.estado === 'error') {
            const resumenLogs = logsConsola.slice(-10).join(' | ') || '(sin logs de consola)';
            resultado.detalle += ` — Logs: ${resumenLogs}`;
        }

        return resultado;
    } catch (err) {
        return { estado: 'error', detalle: `Error en escaneo QR simulado: ${err.message}` };
    } finally {
        fs.writeFileSync(path.join(carpetaDebug, `${oseId}-consola.log`), logsConsola.join('\n'));
        if (browser) await browser.close();
        fs.rmSync(carpetaTemp, { recursive: true, force: true });
    }
}

async function main() {
    const guias = await getGuiasPendientes();
    console.log(`📦 ${guias.length} guía(s) pendiente(s) de consultar.`);

    if (guias.length === 0) {
        console.log('Nada que hacer. Fin.');
        return;
    }

    // Los que tienen guía+código usan un navegador compartido; los que
    // solo tienen oseId (QR) usan su propio navegador con cámara falsa.
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        for (const envio of guias) {
            const usaOseId = !envio.guia && envio.oseId;
            const etiqueta = envio.guia || `QR:${envio.oseId}`;
            console.log(`🔍 Consultando ${etiqueta}...`);

            try {
                const resultado = usaOseId
                    ? await consultarPorOseId(envio.oseId)
                    : await consultarGuia(page, envio.guia, envio.codigo);

                const cambios = {
                    estado: resultado.estado,
                    detalleEstado: resultado.detalle,
                    ultimaConsulta: new Date().toISOString()
                };

                // Si el envío se había registrado solo con oseId (sin
                // guía visible), y ahora sí pudimos leer el N° de Orden
                // en pantalla, lo guardamos para que se vea bien en el
                // cotizador de ahí en adelante.
                if (usaOseId && resultado.guiaDetectada && !envio.guia) {
                    cambios.guia = resultado.guiaDetectada;
                }

                if (resultado.estado === 'entregado' && envio.estado !== 'entregado') {
                    cambios.notificado = false; // para que el cotizador muestre el aviso
                    cambios.entregadoEn = new Date().toISOString();
                    console.log(`🎉 ${etiqueta} marcado como ENTREGADO.`);
                }

                await actualizarEnvio(envio.objectId, cambios);
            } catch (err) {
                console.error(`⚠️ Error consultando ${etiqueta}:`, err.message);
                await actualizarEnvio(envio.objectId, {
                    estado: 'error',
                    detalleEstado: `Error: ${err.message}`,
                    ultimaConsulta: new Date().toISOString()
                });
            }
        }
    } finally {
        await browser.close();
    }

    console.log('✅ Ronda de verificación completa.');
}

main().catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
});
