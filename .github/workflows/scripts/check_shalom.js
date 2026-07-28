/**
 * check_shalom.js
 * ------------------------------------------------------------
 * Corre cada 30 min vía GitHub Actions (ver .github/workflows/check.yml).
 * 1. Lee de Back4App las guías que aún no están "entregado".
 * 2. Inicia sesión en pro.shalom.pe con las credenciales (secrets).
 * 3. Para cada guía, consulta su estado de rastreo.
 * 4. Actualiza Back4App con el nuevo estado.
 *
 * ⚠️ IMPORTANTE — AJUSTE PENDIENTE:
 * Los selectores CSS/XPath de las funciones loginShalom() y
 * consultarGuia() son un punto de partida basado en patrones típicos
 * de Shalom Pro (Frappe/ERPNext-like). Es MUY probable que necesiten
 * ajustarse la primera vez, comparando contra el HTML real ya logueado.
 * Busca los comentarios "AJUSTAR AQUÍ".
 * ------------------------------------------------------------
 */

const { chromium } = require('playwright');

const BACK4APP_APP_ID = process.env.BACK4APP_APP_ID;
const BACK4APP_MASTER_KEY = process.env.BACK4APP_MASTER_KEY; // Master Key: solo en GitHub Secrets, nunca en el frontend
const SHALOM_USER = process.env.SHALOM_USER;
const SHALOM_PASS = process.env.SHALOM_PASS;

const PARSE_URL = 'https://parseapi.back4app.com';
const CLASE = 'EnvioShalom';

if (!BACK4APP_APP_ID || !BACK4APP_MASTER_KEY || !SHALOM_USER || !SHALOM_PASS) {
    console.error('❌ Faltan variables de entorno (BACK4APP_APP_ID, BACK4APP_MASTER_KEY, SHALOM_USER, SHALOM_PASS).');
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

async function loginShalom(page) {
    await page.goto('https://pro.shalom.pe/login', { waitUntil: 'networkidle' });

    // Selectores confirmados contra el HTML real de pro.shalom.pe (login):
    //   - Email:    input[name="email"]
    //   - Password: input#passwordLogin (name="password")
    //   - Submit:   button.btn-redshalom dentro de <form id="formLogin">
    await page.fill('input[name="email"]', SHALOM_USER);
    await page.fill('input#passwordLogin', SHALOM_PASS);

    // ⚠️ El formulario usa reCAPTCHA v3 invisible (Google). El botón dispara
    // grecaptcha.execute(...) vía JS antes de enviar el form (ver función
    // addRecaptchaToken en la página). Al hacer click real sobre el botón,
    // Playwright ejecuta ese mismo JS dentro de un Chromium real, así que
    // en teoría el token se genera igual que en un navegador humano.
    // RIESGO CONOCIDO: Google puede asignar un score bajo a tráfico
    // automatizado y el login podría fallar silenciosamente (recarga la
    // página de login sin error visible). Si eso pasa, no hay mucho que
    // ajustar en el script — sería una limitación de fondo del enfoque
    // "robot con Playwright" contra un sitio protegido con reCAPTCHA v3.
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
        page.click('form#formLogin button.btn-redshalom')
    ]);

    // Verificación de login exitoso: ya no estamos en /login
    if (page.url().includes('/login')) {
        throw new Error('El login a Shalom Pro falló (seguimos en /login). Probable causa: score bajo de reCAPTCHA v3, o credenciales/campos incorrectos.');
    }
}

async function consultarGuia(page, guia) {
    // AJUSTAR AQUÍ: la URL/ruta real de rastreo dentro de Shalom Pro
    // (por ejemplo podría ser /rastreo, /seguimiento, /orders/{guia}, etc.)
    // Este es un punto de partida genérico: se intenta ir a una vista de
    // rastreo y buscar el campo de texto para escribir la guía.
    await page.goto('https://pro.shalom.pe/rastreo', { waitUntil: 'networkidle' }).catch(() => {});

    const inputBusqueda = page.locator('input[placeholder*="guía" i], input[placeholder*="orden" i], input[name*="guia" i]').first();
    if (await inputBusqueda.count() === 0) {
        return { estado: 'error', detalle: 'No se encontró el campo de búsqueda de guía (ajustar selector).' };
    }

    await inputBusqueda.fill(guia);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // AJUSTAR AQUÍ: selector del texto que muestra el estado del envío.
    const estadoTexto = await page.locator('[class*="estado" i], [class*="status" i]').first().innerText().catch(() => null);

    if (!estadoTexto) {
        return { estado: 'error', detalle: 'No se pudo leer el estado (ajustar selector de resultado).' };
    }

    const normalizado = estadoTexto.toLowerCase();
    const entregado = /entregad|en destino|recogid|finalizad/.test(normalizado);

    return {
        estado: entregado ? 'entregado' : 'en_transito',
        detalle: estadoTexto.trim()
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
        await loginShalom(page);
        console.log('✅ Sesión iniciada en Shalom Pro.');

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
