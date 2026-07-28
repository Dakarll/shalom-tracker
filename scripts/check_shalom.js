/**
 * check_shalom.js
 * ------------------------------------------------------------
 * Corre cada 30 min vía GitHub Actions (ver .github/workflows/check.yml).
 * 1. Lee de Back4App las guías que aún no están "entregado".
 * 2. Consulta cada una en la página PÚBLICA de rastreo de Shalom
 *    (https://shalom.com.pe/rastrea) — no requiere login.
 * 3. Actualiza Back4App con el nuevo estado.
 * ------------------------------------------------------------
 */

const { chromium } = require('playwright');

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

async function consultarGuia(page, guia) {
    await page.goto('https://shalom.com.pe/rastrea', { waitUntil: 'networkidle' });

    const input = page.locator('input[placeholder="N° de Orden"]');
    await input.fill(guia);
    await input.press('Enter');

    // Espera a que la app (Vue/SPA) renderice el resultado.
    await page.waitForTimeout(3000);

    const estadoLocator = page.locator('.text-4xl.font-bold.text-red-color-sidebar').first();
    const hayResultado = (await estadoLocator.count()) > 0;

    if (!hayResultado) {
        return { estado: 'error', detalle: 'No se encontró resultado para esta guía (verifica el número o si la orden existe / está muy reciente).' };
    }

    const estadoTexto = (await estadoLocator.innerText()).trim();
    const detalleTexto = await page.locator('p.text-silver-title').first().innerText().catch(() => '');

    const normalizado = estadoTexto.toLowerCase();
    const entregado = /entregad/.test(normalizado);

    return {
        estado: entregado ? 'entregado' : 'en_transito',
        detalle: detalleTexto ? `${estadoTexto} — ${detalleTexto.trim()}` : estadoTexto
    };
}

async function main() {
    const guias = await getGuiasPendientes();
    console.log(`📦 ${guias.length} guía(s) pendiente(s) de consultar.`);

    if (guias.length === 0) {
        console.log('Nada que hacer. Fin.');
        return;
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        for (const envio of guias) {
            console.log(`🔍 Consultando guía ${envio.guia}...`);
            try {
                const resultado = await consultarGuia(page, envio.guia);

                const cambios = {
                    estado: resultado.estado,
                    detalleEstado: resultado.detalle,
                    ultimaConsulta: new Date().toISOString()
                };

                if (resultado.estado === 'entregado' && envio.estado !== 'entregado') {
                    cambios.notificado = false; // para que el cotizador muestre el aviso
                    cambios.entregadoEn = new Date().toISOString();
                    console.log(`🎉 Guía ${envio.guia} marcada como ENTREGADA.`);
                }

                await actualizarEnvio(envio.objectId, cambios);
            } catch (err) {
                console.error(`⚠️ Error consultando guía ${envio.guia}:`, err.message);
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
