const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const GROUP_IDS = {
    LOBBY: '120363425370751798@g.us',
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
const STALE_HEALTHCHECK_MS = 8 * 60 * 1000;
const FORCED_RECYCLE_MS = 0;
const RESTART_DELAY_MS = 15000;
const MIN_RESTART_INTERVAL_MS = 2 * 60 * 1000;
const BAD_STATE_RESTART_THRESHOLD = 5;
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
let browserProcessExitHandler = null;
let lastRestartAt = 0;
let lastHealthyAt = 0;
let latestQR = null;
let badStateCount = 0;
let scheduledRestartTimeout = null;
let isChromiumConnected = false;
const monitoredChromiumPages = new WeakSet();

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
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN,
            headless: true,
            protocolTimeout: 240000,
            ignoreHTTPSErrors: true,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--no-first-run',
                '--noerrdialogs',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-extensions',
                '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-renderer-backgrounding',
                '--disable-session-crashed-bubble',
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

function getErrorMessage(error) {
    if (!error) {
        return '';
    }

    if (typeof error === 'string') {
        return error;
    }

    if (error.message) {
        return error.message;
    }

    return String(error);
}

function isChromiumRuntimeError(error) {
    const message = getErrorMessage(error).toLowerCase();

    return [
        'page crashed',
        'target closed',
        'detached frame',
        'session closed',
        'execution context was destroyed',
        'cannot find context with specified id',
        'most likely because of a navigation',
        'protocol error',
        'browser has disconnected'
    ].some(fragment => message.includes(fragment));
}

function shouldIgnoreOperationError(error) {
    const message = getErrorMessage(error).toLowerCase();

    return [
        'msg no longer exists',
        'message can only be deleted',
        'participant already',
        'not a participant',
        'cannot remove participant',
        'not found'
    ].some(fragment => message.includes(fragment));
}

function handleChromiumOperationError(error, context, options = {}) {
    const { restart = true, suppressIfIgnorable = false } = options;
    const message = getErrorMessage(error);

    if (suppressIfIgnorable && shouldIgnoreOperationError(error)) {
        console.warn(`${context} -> operacion omitida: ${message}`);
        return true;
    }

    if (isChromiumRuntimeError(error)) {
        isChromiumConnected = false;
        console.error(`${context} -> error de Chromium: ${message}`);

        if (restart) {
            restartClient(`${context}: ${message}`).catch(restartError => {
                console.error('No se pudo reiniciar tras error de Chromium:', getErrorMessage(restartError));
            });
        }

        return true;
    }

    return false;
}

async function runClientOperation(context, operation, options = {}) {
    try {
        return await operation();
    } catch (error) {
        const handled = handleChromiumOperationError(error, context, options);
        if (!handled) {
            console.error(`${context}: ${getErrorMessage(error)}`);
        }

        return null;
    }
}

function monitorChromiumPage(page, label) {
    if (!page || monitoredChromiumPages.has(page)) {
        return;
    }

    monitoredChromiumPages.add(page);

    page.on('error', error => {
        isChromiumConnected = false;
        console.error(`Chromium page error (${label}): ${getErrorMessage(error)}`);
        restartClient(`page error ${label}`).catch(restartError => {
            console.error('No se pudo reiniciar tras page error:', getErrorMessage(restartError));
        });
    });

    page.on('pageerror', error => {
        console.error(`Chromium page runtime error (${label}): ${getErrorMessage(error)}`);
    });

    page.on('close', () => {
        isChromiumConnected = false;
        console.error(`Chromium page cerrada (${label}).`);
        restartClient(`page closed ${label}`).catch(restartError => {
            console.error('No se pudo reiniciar tras cierre de pagina:', getErrorMessage(restartError));
        });
    });
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

function getChatLabel(chat) {
    if (!chat) {
        return 'chat-desconocido';
    }

    const name = chat.name || chat.formattedTitle || chat.subject || 'sin-nombre';
    const id = chat.id && chat.id._serialized ? chat.id._serialized : 'sin-id';
    return `${name} (${id})`;
}

function logChatEvent(chat, action, details = '') {
    const suffix = details ? ` | ${details}` : '';
    console.log(`[CHAT] ${action} | ${getChatLabel(chat)}${suffix}`);
}

function logIncomingMessage(chat, user, text, fromMe) {
    const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;
    console.log(
        `[MSG] ${fromMe ? 'BOT_OWNER' : 'USER'} ${user} -> ${getChatLabel(chat)} | "${preview}"`
    );
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
    const chat = msg && msg.getChat ? await runClientOperation('No se pudo obtener el chat del mensaje', () => msg.getChat(), { restart: false }) : null;
    const author = getUserId(msg);
    logChatEvent(chat, 'DELETE_MESSAGE', `autor=${author}`);
    await runClientOperation(
        'No se pudo borrar el mensaje',
        () => msg.delete(true),
        { restart: true, suppressIfIgnorable: true }
    );
}

async function safeRemoveParticipants(chat, participants) {
    logChatEvent(chat, 'REMOVE_PARTICIPANTS', `usuarios=${participants.join(', ')}`);
    await runClientOperation(
        'No se pudo expulsar al usuario',
        () => chat.removeParticipants(participants),
        { restart: true, suppressIfIgnorable: true }
    );
}

async function safeSetAdminsOnly(chat, enabled) {
    logChatEvent(chat, 'SET_ADMINS_ONLY', `enabled=${enabled}`);
    await runClientOperation(
        'No se pudo cambiar el estado del grupo',
        () => chat.setMessagesAdminsOnly(enabled),
        { restart: true }
    );
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
        const browser = currentClient && currentClient.pupBrowser;

        if (browser && !browserDisconnectHandler) {
            browserDisconnectHandler = () => {
                isChromiumConnected = false;
                console.error('Chromium se desconecto.');
                restartClient('browser disconnected').catch(error => {
                    console.error('No se pudo reiniciar tras browser disconnected:', getErrorMessage(error));
                });
            };

            browser.once('disconnected', browserDisconnectHandler);
        }

        if (browser && browser.process && !browserProcessExitHandler) {
            const browserProcess = browser.process();

            if (browserProcess) {
                browserProcessExitHandler = (code, signal) => {
                    isChromiumConnected = false;
                    console.error(`Chromium process exit. code=${code} signal=${signal || 'none'}`);
                    restartClient(`browser process exit code=${code} signal=${signal || 'none'}`).catch(error => {
                        console.error('No se pudo reiniciar tras process exit:', getErrorMessage(error));
                    });
                };

                browserProcess.once('exit', browserProcessExitHandler);
            }
        }

        if (browser && typeof browser.pages === 'function') {
            const pages = await browser.pages();
            pages.forEach((page, index) => monitorChromiumPage(page, `existing-${index}`));
        }

        if (browser && typeof browser.on === 'function') {
            browser.on('targetcreated', async target => {
                try {
                    if (target.type() !== 'page') {
                        return;
                    }

                    const page = await target.page();
                    monitorChromiumPage(page, 'targetcreated');
                } catch (error) {
                    handleChromiumOperationError(error, 'monitor targetcreated', { restart: false });
                }
            });
        }
    } catch (error) {
        console.error('No se pudo optimizar Chromium:', getErrorMessage(error));
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
    logChatEvent(chat, 'GROUP_JOIN', `usuario=${user}`);

    if (!ALLOWED_PREFIXES.some(prefix => number.startsWith(prefix))) {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=numero-no-permitido usuario=${user}`);
        await chat.sendMessage('Numero no permitido.');
        await safeRemoveParticipants(chat, [user]);
        deleteUserState(user);
        return;
    }

    logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-bienvenida usuario=${user}`);
    await chat.sendMessage(buildFichaBienvenida(user), {
        mentions: [user]
    });

    clearUserTimers(user);

    const reminderTimer = setTimeout(async () => {
        if (!usuariosFicha[user]) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=recordatorio-ficha usuario=${user}`);
            await chat.sendMessage(`@${number} recuerda rellenar tu ficha.`, {
                mentions: [user]
            });
        }
    }, REMINDER_MS);

    const kickTimer = setTimeout(async () => {
        if (!usuariosFicha[user]) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-no-rellenada usuario=${user}`);
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
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=admin-help solicitado-por=${usuario}`);
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
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=expulsar-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        await safeRemoveParticipants(chat, mencionados);
        mencionados.forEach(deleteUserState);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=usuario-expulsado solicitado-por=${usuario}`);
        await chat.sendMessage('Usuario expulsado.');
        return true;
    }

    if (texto === '!cerrar') {
        await safeSetAdminsOnly(chat, true);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=grupo-cerrado solicitado-por=${usuario}`);
        await chat.sendMessage('Grupo cerrado.');
        return true;
    }

    if (texto === '!abrir') {
        await safeSetAdminsOnly(chat, false);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=grupo-abierto solicitado-por=${usuario}`);
        await chat.sendMessage('Grupo abierto.');
        return true;
    }

    if (texto.startsWith('!aviso')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=aviso-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        avisos[objetivo] = (avisos[objetivo] || 0) + 1;
        userJoinLog[objetivo] = Date.now();

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=aviso objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(
            `Aviso para @${objetivo.split('@')[0]} (${avisos[objetivo]}/3)`,
            { mentions: [objetivo] }
        );

        if (avisos[objetivo] >= 3) {
            await safeRemoveParticipants(chat, [objetivo]);
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=expulsado-por-avisos objetivo=${objetivo}`);
            await chat.sendMessage('Expulsado por 3 avisos.');
            deleteUserState(objetivo);
        }
        return true;
    }

    if (texto.startsWith('!quitaraviso')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=quitaraviso-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        avisos[objetivo] = 0;
        userJoinLog[objetivo] = Date.now();

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=avisos-reiniciados objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(`Avisos reiniciados para @${objetivo.split('@')[0]}`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (texto.startsWith('!avisos')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=avisos-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        const cantidad = avisos[objetivo] || 0;

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=consultar-avisos objetivo=${objetivo} solicitado-por=${usuario}`);
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
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=spam-detectado usuario=${user}`);
        await chat.sendMessage('Spam detectado. Mute de 1 minuto.');
        muteUser(user);
        return true;
    }

    if (esLink(text)) {
        await safeDeleteMessage(msg);
        const warningCount = addWarning(user);

        if (warningCount >= 2) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=enlaces-prohibidos-expulsion usuario=${user}`);
            await chat.sendMessage('Enlaces prohibidos. Usuario expulsado.');
            await safeRemoveParticipants(chat, [user]);
            deleteUserState(user);
        } else {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=enlace-warning usuario=${user}`);
            await chat.sendMessage('Enlaces no permitidos. Warning.');
        }
        return true;
    }

    if (INSULTS.some(insulto => text.includes(insulto))) {
        const warningCount = addWarning(user);

        if (warningCount === 1) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=respeto-warning usuario=${user}`);
            await chat.sendMessage('Respeta las normas. Warning.');
        } else if (warningCount === 2) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=mute-comportamiento usuario=${user}`);
            await chat.sendMessage('Mute por comportamiento.');
            muteUser(user, DEFAULT_MUTE_MS);
        } else {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=expulsion-faltas-respeto usuario=${user}`);
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
        logChatEvent(archive, 'FORWARD_FICHA', `usuario=${user}`);
        await msg.forward(archive);
    } catch (error) {
        console.error('No se pudo reenviar la ficha al archivo:', error.message);
    }

    const edad = extraerEdad(text);
    if (!edad) {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=edad-no-detectada usuario=${user}`);
        await chat.sendMessage('No se detecto la edad correctamente.');
        return true;
    }

    const destinoId = edad >= 17 ? GROUP_IDS.ELITE : GROUP_IDS.ROOKIE;
    const grupoNombre = edad >= 17 ? 'ELITE' : 'ROOKIE';

    try {
        const grupoDestino = await client.getChatById(destinoId);
        await grupoDestino.addParticipants([user]);

        logChatEvent(grupoDestino, 'SEND_MESSAGE', `motivo=bienvenida-destino usuario=${user}`);
        await grupoDestino.sendMessage(buildDestinoBienvenida(user), {
            mentions: [user]
        });

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-completada usuario=${user} destino=${grupoNombre}`);
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

    if (lastHealthyAt > 0 && Date.now() - lastHealthyAt > STALE_HEALTHCHECK_MS) {
        console.error(`healthcheck -> cliente estancado durante ${Date.now() - lastHealthyAt}ms`);
        await restartClient('stale client health');
        return;
    }

    if (!isChromiumConnected) {
        console.log('healthcheck -> Chromium no disponible, se omite comprobacion');
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
        const handled = handleChromiumOperationError(error, 'Healthcheck', { restart: true });
        if (!handled) {
            console.error('Healthcheck fallo sin reinicio:', getErrorMessage(error));
        }
        return;
    }

    if (FORCED_RECYCLE_MS > 0 && Date.now() - lastRestartAt >= FORCED_RECYCLE_MS) {
        await restartClient('scheduled recycle');
    }
}

async function destroyCurrentClient() {
    if (!client) {
        return;
    }

    const currentClient = client;
    client = null;
    isChromiumConnected = false;

    try {
        currentClient.removeAllListeners();
    } catch (error) {
        console.error('No se pudieron limpiar listeners del cliente:', error.message);
    }

    try {
        if (currentClient.pupBrowser && browserDisconnectHandler) {
            currentClient.pupBrowser.off('disconnected', browserDisconnectHandler);
        }
    } catch (error) {
        console.error('No se pudo quitar el listener del browser:', getErrorMessage(error));
    }

    try {
        const browserProcess = currentClient.pupBrowser && currentClient.pupBrowser.process
            ? currentClient.pupBrowser.process()
            : null;

        if (browserProcess && browserProcessExitHandler) {
            browserProcess.off('exit', browserProcessExitHandler);
        }
    } catch (error) {
        console.error('No se pudo quitar el listener del proceso del browser:', getErrorMessage(error));
    }

    browserDisconnectHandler = null;
    browserProcessExitHandler = null;

    try {
        await currentClient.destroy();
    } catch (error) {
        console.error('No se pudo destruir el cliente:', getErrorMessage(error));
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
                console.error('Fallo al levantar el cliente tras reinicio:', getErrorMessage(error));
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
        isChromiumConnected = true;
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
        isChromiumConnected = true;
        console.log(`loading_screen -> ${percent}% ${message || ''}`.trim());
    });

    currentClient.on('error', error => {
        console.error('client error:', error);
        handleChromiumOperationError(error, 'client error', { restart: true });
    });

    currentClient.on('ready', async () => {
        touchHealth();
        isChromiumConnected = true;
        latestQR = null;
        console.log('Bot unificado activo.');
        await optimizeChromiumResources(currentClient);
    });

    currentClient.on('authenticated', () => {
        touchHealth();
        isChromiumConnected = true;
        console.log('Sesion autenticada.');
    });

    currentClient.on('auth_failure', message => {
        console.error('Fallo de autenticacion:', message);
        restartClient('auth failure').catch(error => {
            console.error('No se pudo reiniciar tras auth failure:', getErrorMessage(error));
        });
    });

    currentClient.on('change_state', state => {
        touchHealth();
        isChromiumConnected = true;
        console.log(`Estado de WhatsApp: ${state}`);
    });

    currentClient.on('disconnected', reason => {
        isChromiumConnected = false;
        console.error(`Cliente desconectado: ${reason}`);

        if (reason === 'NAVIGATION' || reason === 'TIMEOUT') {
            console.log('Desconexion temporal detectada; no se reinicia para evitar bucle.');
            return;
        }

        restartClient(`client disconnected: ${reason}`).catch(error => {
            console.error('No se pudo reiniciar tras desconexion:', getErrorMessage(error));
        });
    });

    currentClient.on('group_join', async notification => {
        touchHealth();
        try {
            await manejarEntradaLobby(notification);
        } catch (error) {
            const handled = handleChromiumOperationError(error, 'group_join', { restart: true });
            if (!handled) {
                console.error('Error en group_join:', getErrorMessage(error));
            }
        }
    });

    currentClient.on('message', async msg => {
        touchHealth();

        try {
            const text = (msg.body || '').toLowerCase().trim();

            if (msg.fromMe && !text.startsWith('!')) {
                return;
            }

            const chat = await msg.getChat();
            if (!chat.isGroup) {
                return;
            }

            const user = getUserId(msg);
            logIncomingMessage(chat, user, text, msg.fromMe);

            const comandoProcesado = await manejarComandosAdmin(msg, chat, text, user);
            if (comandoProcesado) {
                return;
            }

            const moderacionProcesada = await manejarModeracionLobby(msg, chat, text, user);
            if (moderacionProcesada) {
                return;
            }

            await manejarFichaLobby(msg, chat, text, user);
        } catch (error) {
            const handled = handleChromiumOperationError(error, 'message handler', { restart: true });
            if (!handled) {
                console.error('Error procesando mensaje:', getErrorMessage(error));
            }
        }
    });
}

async function startClient() {
    console.log('startClient() -> iniciando cliente');
    const newClient = createClient();
    client = newClient;
    isChromiumConnected = false;
    bindClientEvents(newClient);

    lastRestartAt = Date.now();
    touchHealth();

    console.log('startClient() -> ejecutando initialize()');

    try {
        await client.initialize();
        console.log('startClient() -> initialize() completado');
    } catch (error) {
        handleChromiumOperationError(error, 'startClient initialize', { restart: false });
        console.error('startClient() -> fallo al iniciar Puppeteer/WhatsApp:', error);
        throw error;
    }
}

function startSchedulers() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(() => {
            cleanupOldState();
        }, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref();
    }

    if (!healthInterval) {
        healthInterval = setInterval(() => {
            healthcheckClient().catch(error => {
                console.error('Error en healthcheck:', getErrorMessage(error));
            });
        }, HEALTHCHECK_INTERVAL_MS);
        healthInterval.unref();
    }
}

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', getErrorMessage(error));
    handleChromiumOperationError(error, 'unhandledRejection', { restart: true });
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', getErrorMessage(error));
    handleChromiumOperationError(error, 'uncaughtException', { restart: true });
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
    console.error('No se pudo iniciar el cliente:', getErrorMessage(error));
    restartClient('initial start failed');
});
