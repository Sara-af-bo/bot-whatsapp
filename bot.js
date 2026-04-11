const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const GROUP_IDS = {
    LOBBY: '120363408940060754@g.us',
    ROOKIE: '120363426241635796@g.us',
    ELITE: '120363426931376573@g.us',
    ARCHIVE: '120363425009767808@g.us'
};

const ALLOWED_GROUPS = [GROUP_IDS.LOBBY, GROUP_IDS.ROOKIE, GROUP_IDS.ELITE];
const ALLOWED_PREFIXES = ['34', '52', '54', '57', '51', '58', '56', '593', '591', '595', '598'];
const INSULTS = ['puta', 'gilipollas', 'idiota', 'imbecil', 'subnormal'];
const LINK_REGEX = /(https?:\/\/|www\.|\.com|\.gg|\.net)/i;

const FLOOD_WINDOW_MS = 5000;
const FLOOD_LIMIT = 5;
const DEFAULT_MUTE_MS = 60 * 1000;
const REMINDER_MS = 12 * 60 * 60 * 1000;
const KICK_DELAY_MS = 24 * 60 * 60 * 1000;
const REOPEN_GROUP_MS = 10 * 60 * 1000;
const STALE_USER_TTL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

const HEALTHCHECK_INTERVAL_MS = 2 * 60 * 1000;
const FORCED_RECYCLE_MS = 6 * 60 * 60 * 1000;
const RESTART_DELAY_MS = 15000;
const MIN_RESTART_INTERVAL_MS = 2 * 60 * 1000;
const BAD_STATE_RESTART_THRESHOLD = 3;
const WEB_PORT = 3000;
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB || 420);
const MAX_HEAP_MB = Number(process.env.MAX_HEAP_MB || 220);

const warnings = {};
const mutedUsers = {};
const userMessages = {};
const usuariosPendientes = {};
const usuariosFicha = {};
const userJoinLog = {};
const avisos = {};
const reminderTimeouts = new Map();
const kickTimeouts = new Map();

let client = null;
let healthInterval = null;
let cleanupInterval = null;
let isRestarting = false;
let reopenTimeout = null;
let browserDisconnectHandler = null;
let lastRestartAt = 0;
let lastHealthyAt = 0;
let latestQR = null;
let badStateCount = 0;
let scheduledRestartTimeout = null;

const app = express();

app.get('/qr', (req, res) => {
    const qrMarkup = latestQR
        ? `<img src="${latestQR}" alt="QR de WhatsApp" style="max-width: 320px; width: 100%; height: auto;" />`
        : '<p>QR a\u00fan no generado</p>';

    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="refresh" content="5" />
    <title>QR del bot</title>
</head>
<body style="font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f5; color: #111;">
    <main style="text-align: center; background: white; padding: 24px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); width: min(92vw, 420px);">
        <h1 style="margin-top: 0;">QR del bot</h1>
        ${qrMarkup}
    </main>
</body>
</html>`);
});

app.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`Servidor QR activo en el puerto ${WEB_PORT}`);
});

function createClient() {
    console.log('createClient() -> creando cliente de WhatsApp');

    return new Client({
        authStrategy: new LocalAuth({ clientId: 'draxorix-bot' }),
        restartOnAuthFail: true,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        qrMaxRetries: 20,
        puppeteer: {
            headless: true,
            protocolTimeout: 180000,
            ignoreHTTPSErrors: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--no-first-run',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-default-browser-check',
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        }
    });
}

function touchHealth() {
    lastHealthyAt = Date.now();
}

function bytesToMb(bytes) {
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function logMemory(context) {
    const memory = process.memoryUsage();
    console.log(
        `[MEM] ${context} rss=${bytesToMb(memory.rss)}MB heapUsed=${bytesToMb(memory.heapUsed)}MB heapTotal=${bytesToMb(memory.heapTotal)}MB`
    );
}

function clearTimer(timer) {
    if (timer) {
        clearTimeout(timer);
    }
}

function clearUserTimers(user) {
    clearTimer(reminderTimeouts.get(user));
    clearTimer(kickTimeouts.get(user));
    reminderTimeouts.delete(user);
    kickTimeouts.delete(user);
}

function deleteUserState(user) {
    delete warnings[user];
    delete mutedUsers[user];
    delete userMessages[user];
    delete usuariosPendientes[user];
    delete usuariosFicha[user];
    delete userJoinLog[user];
    delete avisos[user];
    clearUserTimers(user);
}

function cleanupOldState() {
    const now = Date.now();
    const knownUsers = new Set([
        ...Object.keys(warnings),
        ...Object.keys(mutedUsers),
        ...Object.keys(userMessages),
        ...Object.keys(usuariosPendientes),
        ...Object.keys(usuariosFicha),
        ...Object.keys(userJoinLog),
        ...Object.keys(avisos),
        ...reminderTimeouts.keys(),
        ...kickTimeouts.keys()
    ]);

    for (const user of knownUsers) {
        const lastJoin = userJoinLog[user] || 0;
        const messages = userMessages[user] || [];
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : 0;
        const lastSeen = Math.max(lastJoin, lastMessage);

        if (!lastSeen || now - lastSeen > STALE_USER_TTL_MS) {
            deleteUserState(user);
        }
    }

    if (typeof global.gc === 'function') {
        global.gc();
    }
}

function logUser(user, action) {
    console.log(`[LOG] ${user} -> ${action}`);
}

function addWarning(user) {
    warnings[user] = (warnings[user] || 0) + 1;
    userJoinLog[user] = Date.now();
    return warnings[user];
}

function muteUser(user, duration = DEFAULT_MUTE_MS) {
    mutedUsers[user] = true;
    userJoinLog[user] = Date.now();

    setTimeout(() => {
        delete mutedUsers[user];
    }, duration);
}

function esLink(text) {
    return LINK_REGEX.test(text);
}

function extraerEdad(texto) {
    const match = texto.match(/edad[:\s]*([0-9]{1,2})/i);
    return match ? parseInt(match[1], 10) : null;
}

function getUserId(msg) {
    return msg.author || msg.from;
}

function isFicha(text) {
    return text.includes('nombre') && text.includes('edad');
}

async function safeDeleteMessage(msg) {
    try {
        await msg.delete(true);
    } catch (error) {
        console.error('No se pudo borrar el mensaje:', error.message);
    }
}

async function safeRemoveParticipants(chat, participants) {
    try {
        await chat.removeParticipants(participants);
    } catch (error) {
        console.error('No se pudo expulsar al usuario:', error.message);
    }
}

async function safeSetAdminsOnly(chat, enabled) {
    try {
        await chat.setMessagesAdminsOnly(enabled);
    } catch (error) {
        console.error('No se pudo cambiar el estado del grupo:', error.message);
    }
}

async function esAdmin(chat, userId) {
    const participantes = Array.isArray(chat.participants) ? chat.participants : [];
    const participante = participantes.find(
        participant => participant.id._serialized === userId
    );

    return Boolean(participante && (participante.isAdmin || participante.isSuperAdmin));
}

function buildFichaBienvenida(user) {
    return [
        `Welcome @${user.split('@')[0]}`,
        '',
        'Ficha de presentacion:',
        '- Nombre:',
        '- Genero o pronombres:',
        '- Edad:',
        '- Fecha de cumpleanos:',
        '- Signo zodiaco:',
        '- Hobbies favoritos:',
        '- Series/libros/peliculas favoritas:',
        '- Como te describirias:',
        '- Cual es tu mayor deseo:',
        '- Aceptas respetar las reglas:',
        '- En que otros clanes estas o estabas:',
        '- Captura del codigo de amistad de Among Us (obligatorio)',
        '- Foto tuya (opcional)'
    ].join('\n');
}

function buildDestinoBienvenida(user) {
    return [
        'DRAXORIX',
        '',
        `Bienvenidx @${user.split('@')[0]}`,
        'No mercy. Only DRAXORIX.'
    ].join('\n');
}

async function optimizeChromiumResources(currentClient) {
    try {
        const page = currentClient && currentClient.pupPage;
        const browser = currentClient && currentClient.pupBrowser;

        if (!page || page.__optimizedForRailway) {
            return;
        }

        page.__optimizedForRailway = true;

        await page.setCacheEnabled(false);
        await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
        await page.setRequestInterception(true);

        page.on('request', request => {
            const resourceType = request.resourceType();
            const url = request.url();

            const shouldBlockType = ['image', 'media', 'font', 'texttrack', 'object', 'imageset'].includes(resourceType);
            const shouldBlockUrl = url.includes('doubleclick.net') || url.includes('google-analytics.com');

            if (shouldBlockType || shouldBlockUrl) {
                request.abort();
                return;
            }

            request.continue();
        });

        page.on('error', error => {
            console.error('Chromium page error:', error.message);
        });

        page.on('pageerror', error => {
            console.error('WhatsApp page runtime error:', error.message);
        });

        if (browser && !browserDisconnectHandler) {
            browserDisconnectHandler = () => {
                console.error('Chromium se desconecto.');
                browserDisconnectHandler = null;
            };

            browser.once('disconnected', browserDisconnectHandler);
        }
    } catch (error) {
        console.error('No se pudo optimizar Chromium:', error.message);
    }
}

async function manejarEntradaLobby(notification) {
    const chat = await notification.getChat();
    if (chat.id._serialized !== GROUP_IDS.LOBBY) {
        return;
    }

    const user = notification.recipientIds[0];
    const number = user.split('@')[0];

    userJoinLog[user] = Date.now();
    usuariosPendientes[user] = true;
    touchHealth();
    logUser(user, 'JOIN');

    if (!ALLOWED_PREFIXES.some(prefix => number.startsWith(prefix))) {
        await chat.sendMessage('Numero no permitido.');
        await safeRemoveParticipants(chat, [user]);
        deleteUserState(user);
        return;
    }

    await chat.sendMessage(buildFichaBienvenida(user), {
        mentions: [user]
    });

    clearUserTimers(user);

    const reminderTimer = setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage(`@${number} recuerda rellenar tu ficha.`, {
                mentions: [user]
            });
        }
    }, REMINDER_MS);

    const kickTimer = setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage(`@${number} no rellenaste la ficha en 24h.`, {
                mentions: [user]
            });
            await safeRemoveParticipants(chat, [user]);
            deleteUserState(user);
        }
    }, KICK_DELAY_MS);

    reminderTimeouts.set(user, reminderTimer);
    kickTimeouts.set(user, kickTimer);
}

async function manejarComandosAdmin(msg, chat, texto, usuario) {
    if (!ALLOWED_GROUPS.includes(chat.id._serialized)) {
        return false;
    }

    if (texto === '!help') {
        await chat.sendMessage([
            'COMANDOS ADMIN',
            '',
            '!expulsar @usuario',
            '!cerrar',
            '!abrir',
            '!aviso @usuario',
            '!quitaraviso @usuario',
            '!avisos @usuario'
        ].join('\n'));
        return true;
    }

    const admin = await esAdmin(chat, usuario);
    if (!admin) {
        return false;
    }

    if (texto.startsWith('!expulsar')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        await safeRemoveParticipants(chat, mencionados);
        mencionados.forEach(deleteUserState);
        await chat.sendMessage('Usuario expulsado.');
        return true;
    }

    if (texto === '!cerrar') {
        await safeSetAdminsOnly(chat, true);
        await chat.sendMessage('Grupo cerrado.');
        return true;
    }

    if (texto === '!abrir') {
        await safeSetAdminsOnly(chat, false);
        await chat.sendMessage('Grupo abierto.');
        return true;
    }

    if (texto.startsWith('!aviso')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        avisos[objetivo] = (avisos[objetivo] || 0) + 1;
        userJoinLog[objetivo] = Date.now();

        await chat.sendMessage(
            `Aviso para @${objetivo.split('@')[0]} (${avisos[objetivo]}/3)`,
            { mentions: [objetivo] }
        );

        if (avisos[objetivo] >= 3) {
            await safeRemoveParticipants(chat, [objetivo]);
            await chat.sendMessage('Expulsado por 3 avisos.');
            deleteUserState(objetivo);
        }
        return true;
    }

    if (texto.startsWith('!quitaraviso')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        avisos[objetivo] = 0;
        userJoinLog[objetivo] = Date.now();

        await chat.sendMessage(`Avisos reiniciados para @${objetivo.split('@')[0]}`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (texto.startsWith('!avisos')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        const cantidad = avisos[objetivo] || 0;

        await chat.sendMessage(
            `@${objetivo.split('@')[0]} tiene ${cantidad} avisos.`,
            { mentions: [objetivo] }
        );
        return true;
    }

    return false;
}

async function manejarModeracionLobby(msg, chat, text, user) {
    if (chat.id._serialized !== GROUP_IDS.LOBBY) {
        return false;
    }

    if (mutedUsers[user]) {
        await safeDeleteMessage(msg);
        return true;
    }

    const now = Date.now();
    userMessages[user] = userMessages[user] || [];
    userMessages[user].push(now);
    userJoinLog[user] = now;
    userMessages[user] = userMessages[user].filter(
        timestamp => now - timestamp < FLOOD_WINDOW_MS
    );

    if (userMessages[user].length > FLOOD_LIMIT) {
        await chat.sendMessage('Spam detectado. Mute de 1 minuto.');
        muteUser(user);
        return true;
    }

    if (esLink(text)) {
        await safeDeleteMessage(msg);
        const warningCount = addWarning(user);

        if (warningCount >= 2) {
            await chat.sendMessage('Enlaces prohibidos. Usuario expulsado.');
            await safeRemoveParticipants(chat, [user]);
            deleteUserState(user);
        } else {
            await chat.sendMessage('Enlaces no permitidos. Warning.');
        }
        return true;
    }

    if (INSULTS.some(insulto => text.includes(insulto))) {
        const warningCount = addWarning(user);

        if (warningCount === 1) {
            await chat.sendMessage('Respeta las normas. Warning.');
        } else if (warningCount === 2) {
            await chat.sendMessage('Mute por comportamiento.');
            muteUser(user, DEFAULT_MUTE_MS);
        } else {
            await chat.sendMessage('Expulsado por faltas de respeto.');
            await safeRemoveParticipants(chat, [user]);
            deleteUserState(user);
        }

        await safeSetAdminsOnly(chat, true);

        if (reopenTimeout) {
            clearTimeout(reopenTimeout);
        }

        reopenTimeout = setTimeout(async () => {
            reopenTimeout = null;
            await safeSetAdminsOnly(chat, false);
        }, REOPEN_GROUP_MS);

        return true;
    }

    return false;
}

async function manejarFichaLobby(msg, chat, text, user) {
    if (chat.id._serialized !== GROUP_IDS.LOBBY || !isFicha(text)) {
        return false;
    }

    usuariosFicha[user] = true;
    delete usuariosPendientes[user];
    userJoinLog[user] = Date.now();
    clearUserTimers(user);
    logUser(user, 'FICHA COMPLETADA');

    try {
        const archive = await client.getChatById(GROUP_IDS.ARCHIVE);
        await msg.forward(archive);
    } catch (error) {
        console.error('No se pudo reenviar la ficha al archivo:', error.message);
    }

    const edad = extraerEdad(text);
    if (!edad) {
        await chat.sendMessage('No se detecto la edad correctamente.');
        return true;
    }

    const destinoId = edad >= 17 ? GROUP_IDS.ELITE : GROUP_IDS.ROOKIE;
    const grupoNombre = edad >= 17 ? 'ELITE' : 'ROOKIE';

    try {
        const grupoDestino = await client.getChatById(destinoId);
        await grupoDestino.addParticipants([user]);

        await grupoDestino.sendMessage(buildDestinoBienvenida(user), {
            mentions: [user]
        });

        await chat.sendMessage(`Ficha completada. Usuario anadido a ${grupoNombre}.`);

        setTimeout(async () => {
            await safeRemoveParticipants(chat, [user]);
            deleteUserState(user);
        }, 3000);
    } catch (error) {
        console.error('No se pudo anadir al usuario al grupo destino:', error.message);
        await chat.sendMessage('No se pudo anadir al usuario al grupo destino.');
    }

    return true;
}

async function healthcheckClient() {
    cleanupOldState();

    const memory = process.memoryUsage();
    const rssMb = bytesToMb(memory.rss);
    const heapMb = bytesToMb(memory.heapUsed);

    if (rssMb >= MAX_RSS_MB || heapMb >= MAX_HEAP_MB) {
        logMemory('threshold-exceeded');
        return;
    }

    if (!client) {
        return;
    }

    try {
        const state = await client.getState();
        touchHealth();
        console.log(`healthcheck -> state=${state}`);

        if (state === 'CONNECTED' || state === 'OPENING' || state === 'PAIRING') {
            badStateCount = 0;
            return;
        }

        if (state === 'CONFLICT') {
            badStateCount = 0;
            return;
        }

        if (state === 'UNLAUNCHED' || state === 'UNPAIRED' || state === 'UNPAIRED_IDLE' || state === 'TIMEOUT') {
            badStateCount += 1;
            console.error(`healthcheck -> bad state ${state} (${badStateCount}/${BAD_STATE_RESTART_THRESHOLD})`);

            if (badStateCount >= BAD_STATE_RESTART_THRESHOLD) {
                badStateCount = 0;
                await restartClient(`bad state ${state}`);
            }
            return;
        }

        badStateCount = 0;
    } catch (error) {
        console.error('Healthcheck fallo sin reinicio:', error.message);
        return;
    }

    if (Date.now() - lastRestartAt >= FORCED_RECYCLE_MS) {
        await restartClient('scheduled recycle');
    }
}

async function destroyCurrentClient() {
    if (!client) {
        return;
    }

    const currentClient = client;
    client = null;

    try {
        currentClient.removeAllListeners();
    } catch (error) {
        console.error('No se pudieron limpiar listeners del cliente:', error.message);
    }

    try {
        if (currentClient.pupBrowser && browserDisconnectHandler) {
            currentClient.pupBrowser.removeListener('disconnected', browserDisconnectHandler);
        }
    } catch (error) {
        console.error('No se pudo quitar el listener del browser:', error.message);
    }

    browserDisconnectHandler = null;

    try {
        await currentClient.destroy();
    } catch (error) {
        console.error('No se pudo destruir el cliente:', error.message);
    }
}

async function restartClient(reason) {
    if (isRestarting) {
        return;
    }

    if (scheduledRestartTimeout) {
        console.log(`Reinicio ya programado. Motivo omitido: ${reason}`);
        return;
    }

    const elapsedSinceLastRestart = Date.now() - lastRestartAt;
    if (elapsedSinceLastRestart < MIN_RESTART_INTERVAL_MS) {
        const waitMs = Math.max(RESTART_DELAY_MS, MIN_RESTART_INTERVAL_MS - elapsedSinceLastRestart);
        console.log(`Reinicio aplazado ${waitMs}ms para evitar bucle. Motivo: ${reason}`);

        scheduledRestartTimeout = setTimeout(() => {
            scheduledRestartTimeout = null;
            restartClient(`${reason} (delayed)`).catch(error => {
                console.error('Fallo en reinicio aplazado:', error.message);
            });
        }, waitMs);

        return;
    }

    isRestarting = true;
    console.error(`Reiniciando cliente: ${reason}`);
    logMemory('before-restart');

    try {
        await destroyCurrentClient();
        badStateCount = 0;

        if (typeof global.gc === 'function') {
            global.gc();
        }

        scheduledRestartTimeout = setTimeout(() => {
            scheduledRestartTimeout = null;
            startClient().catch(error => {
                console.error('Fallo al levantar el cliente tras reinicio:', error.message);
            });
        }, RESTART_DELAY_MS);
    } finally {
        isRestarting = false;
    }
}

function bindClientEvents(currentClient) {
    console.log('bindClientEvents() -> registrando eventos del cliente');

    currentClient.on('qr', async qr => {
        touchHealth();
        console.log('GENERANDO QR');

        try {
            latestQR = await QRCode.toDataURL(qr, {
                width: 180,
                margin: 1
            });
            console.log('QR listo -> /qr');
        } catch (error) {
            console.error('No se pudo generar el QR en base64:', error.message);
        }
    });

    currentClient.on('loading_screen', (percent, message) => {
        touchHealth();
        console.log(`loading_screen -> ${percent}% ${message || ''}`.trim());
    });

    currentClient.on('error', error => {
        console.error('client error:', error);
    });

    currentClient.on('ready', async () => {
        touchHealth();
        latestQR = null;
        console.log('Bot unificado activo.');
        await optimizeChromiumResources(currentClient);
    });

    currentClient.on('authenticated', () => {
        touchHealth();
        console.log('Sesion autenticada.');
    });

    currentClient.on('auth_failure', message => {
        console.error('Fallo de autenticacion:', message);
        restartClient('auth failure');
    });

    currentClient.on('change_state', state => {
        touchHealth();
        console.log(`Estado de WhatsApp: ${state}`);
    });

    currentClient.on('disconnected', reason => {
        console.error(`Cliente desconectado: ${reason}`);
        restartClient(`client disconnected: ${reason}`);
    });

    currentClient.on('group_join', async notification => {
        touchHealth();
        await manejarEntradaLobby(notification);
    });

    currentClient.on('message', async msg => {
        touchHealth();

        if (msg.fromMe) {
            return;
        }

        const chat = await msg.getChat();
        if (!chat.isGroup) {
            return;
        }

        const user = getUserId(msg);
        const text = (msg.body || '').toLowerCase().trim();

        const comandoProcesado = await manejarComandosAdmin(msg, chat, text, user);
        if (comandoProcesado) {
            return;
        }

        const moderacionProcesada = await manejarModeracionLobby(msg, chat, text, user);
        if (moderacionProcesada) {
            return;
        }

        await manejarFichaLobby(msg, chat, text, user);
    });
}

async function startClient() {
    console.log('startClient() -> iniciando cliente');
    const newClient = createClient();
    client = newClient;
    bindClientEvents(newClient);

    lastRestartAt = Date.now();
    touchHealth();

    console.log('startClient() -> ejecutando initialize()');

    try {
        await client.initialize();
        console.log('startClient() -> initialize() completado');
    } catch (error) {
        console.error('startClient() -> fallo al iniciar Puppeteer/WhatsApp:', error);
        throw error;
    }
}

function startSchedulers() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(cleanupOldState, CLEANUP_INTERVAL_MS);
    }

    if (!healthInterval) {
        healthInterval = setInterval(() => {
            healthcheckClient().catch(error => {
                console.error('Error en healthcheck:', error.message);
            });
        }, HEALTHCHECK_INTERVAL_MS);
    }
}

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error && error.message ? error.message : error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error.message);
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM recibido. Cerrando cliente...');
    await destroyCurrentClient();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT recibido. Cerrando cliente...');
    await destroyCurrentClient();
    process.exit(0);
});

startSchedulers();
startClient().catch(error => {
    console.error('No se pudo iniciar el cliente:', error.message);
    restartClient('initial start failed');
});
