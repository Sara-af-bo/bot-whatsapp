const express = require('express');
const { MongoClient } = require('mongodb');

let mongoose = null;
let MongoStore = null;
try {
    mongoose = require('mongoose');
    const wwebJsMongo = require('wwebjs-mongo');
    MongoStore = wwebJsMongo.StoreFactory || wwebJsMongo;
    console.log('IMPORT DEBUG -> wwebjs-mongo module:', Object.keys(wwebJsMongo || {}));
} catch (error) {
    console.warn('MongoDB dependencies not available. Running without persistence.');
}

console.log('DEPENDENCIES DEBUG -> mongoose loaded:', Boolean(mongoose), 'MongoStore loaded:', Boolean(MongoStore));

const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const GROUP_IDS = {
    LOBBY: '120363425370751798@g.us',
    ROOKIE: '120363426241635796@g.us',
    ELITE: '120363426931376573@g.us',
    ARCHIVE: '120363425009767808@g.us'
};

const ADMIN_IDS = [
    '273521049612340@lid',
    '200815692222677@lid'
];

const ALLOWED_GROUPS = [GROUP_IDS.LOBBY, GROUP_IDS.ROOKIE, GROUP_IDS.ELITE];
const INSULTS = ['puta', 'hijo de puta', 'gilipollas', 'idiota', 'imbecil', 'subnormal', 'cabron', 'capullo', 'mierda', 'payaso'];
const LINK_REGEX = /(https?:\/\/|www\.|\.com|\.gg|\.net)/i;

const FLOOD_WINDOW_MS = 5000;
const FLOOD_LIMIT = 5;
const DEFAULT_MUTE_MS = 60 * 1000;
const REMINDER_MS = 12 * 60 * 60 * 1000;
const KICK_DELAY_MS = 24 * 60 * 60 * 1000;
const FICHA_EXIT_DELAY_MS = 10 * 60 * 1000;
const REOPEN_GROUP_MS = 10 * 60 * 1000;
const STALE_USER_TTL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

const HEALTHCHECK_INTERVAL_MS = 2 * 60 * 1000;
const STALE_HEALTHCHECK_MS = 2 * 60 * 60 * 1000; // 2 horas
const FORCED_RECYCLE_MS = 0;
const RESTART_DELAY_MS = 15000;
const MIN_RESTART_INTERVAL_MS = 2 * 60 * 1000;
const BAD_STATE_RESTART_THRESHOLD = 5;
const WEB_PORT = 3000;
const MAX_RSS_MB = Number(process.env.MAX_RSS_MB || 420);
const MAX_HEAP_MB = Number(process.env.MAX_HEAP_MB || 220);
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'draxorix_bot';
const SESSION_CLIENT_ID = process.env.SESSION_CLIENT_ID || 'draxorix-bot';

console.log('ENV DEBUG -> MONGODB_URI set:', Boolean(MONGODB_URI));
console.log('ENV DEBUG -> MONGODB_URI value (first 30 chars):', MONGODB_URI ? MONGODB_URI.substring(0, 30) + '...' : 'NOT SET');
console.log('ENV DEBUG -> MONGODB_DB:', MONGODB_DB);
console.log('ENV DEBUG -> SESSION_CLIENT_ID:', SESSION_CLIENT_ID);

const STATE_SAVE_DEBOUNCE_MS = 1000;
const TRACKED_GROUP_IDS = Object.values(GROUP_IDS);
const PERSISTED_CHAT_ACTIONS = new Set([
    'GROUP_JOIN',
    'GROUP_LEAVE',
    'DELETE_MESSAGE',
    'REMOVE_PARTICIPANTS',
    'SET_ADMINS_ONLY',
    'FORWARD_FICHA'
]);

const warnings = {};
const mutedUsers = {};
const userMessages = {};
const usuariosPendientes = {};
const usuariosFicha = {};
const userJoinLog = {};
const userLeaveLog = {};
const avisos = {};
const bannedUsers = {};
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
let mongoClient = null;
let mongoDb = null;
let mongoStateCollection = null;
let mongoEventsCollection = null;
let mongoFichasCollection = null;
let mongoStore = null;
let pendingStateSaveTimeout = null;
let stateSaveInFlight = null;
const processedMessageIds = new Map();
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
    console.log('CREATE CLIENT DEBUG -> mongoStore available:', Boolean(mongoStore));

    const authStrategy = mongoStore
        ? new RemoteAuth({
            clientId: SESSION_CLIENT_ID,
            store: mongoStore,
            backupSyncIntervalMs: 5 * 60 * 1000
        })
        : new LocalAuth({ clientId: SESSION_CLIENT_ID });

    console.log('CREATE CLIENT DEBUG -> Using auth strategy:', mongoStore ? 'RemoteAuth' : 'LocalAuth');

    return new Client({
        authStrategy,
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

function shouldProcessMessage(msg) {
    const messageId = msg && msg.id && msg.id._serialized;
    if (!messageId) {
        return true;
    }

    const now = Date.now();

    for (const [id, timestamp] of processedMessageIds.entries()) {
        if (now - timestamp > 30 * 1000) {
            processedMessageIds.delete(id);
        }
    }

    if (processedMessageIds.has(messageId)) {
        return false;
    }

    processedMessageIds.set(messageId, now);
    return true;
}

function getPersistentStateSnapshot() {
    return {
        warnings,
        mutedUsers,
        userMessages,
        usuariosPendientes,
        usuariosFicha,
        userJoinLog,
        userLeaveLog,
        avisos,
        bannedUsers
    };
}

function assignLoadedState(target, source) {
    Object.keys(target).forEach(key => delete target[key]);
    Object.assign(target, source || {});
}

async function connectMongo() {
    console.log('\n========== CONNECT_MONGO_START ==========');
    console.log('CONNECT MONGO DEBUG -> Starting connectMongo');
    console.log('CONNECT MONGO DEBUG -> mongoose available:', Boolean(mongoose));
    console.log('CONNECT MONGO DEBUG -> MongoStore available:', Boolean(MongoStore));
    console.log('CONNECT MONGO DEBUG -> MONGODB_URI defined:', Boolean(MONGODB_URI));
    console.log('CONNECT MONGO DEBUG -> MONGODB_URI value (first 50 chars):', MONGODB_URI ? MONGODB_URI.substring(0, 50) + '...' : 'UNDEFINED');

    if (!mongoose || !MongoStore) {
        console.error('CONNECT MONGO ERROR -> MongoDB dependencies not available!');
        console.error('  mongoose:', Boolean(mongoose));
        console.error('  MongoStore:', Boolean(MongoStore));
        console.log('========== CONNECT_MONGO_END (Dependencies missing) ==========\n');
        return;
    }

    if (!MONGODB_URI) {
        console.error('CONNECT MONGO ERROR -> MONGODB_URI not set!');
        console.log('========== CONNECT_MONGO_END (No URI) ==========\n');
        return;
    }

    console.log('CONNECT MONGO DEBUG -> Attempting to connect to MongoDB...');
    try {
        console.log('MongoDB connect -> trying to connect with configured URI');
        await mongoose.connect(MONGODB_URI, {
            dbName: MONGODB_DB
        });

        console.log('CONNECT MONGO DEBUG -> Mongoose connected. Creating MongoStore...');
        console.log('CONNECT MONGO DEBUG -> MongoStore class:', typeof MongoStore, 'Is Function:', typeof MongoStore === 'function');
        
        mongoStore = new MongoStore({ mongoose });
        
        console.log('CONNECT MONGO DEBUG -> MongoStore created successfully');
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        mongoDb = mongoClient.db(MONGODB_DB);
        mongoStateCollection = mongoDb.collection('bot_state');
        mongoEventsCollection = mongoDb.collection('bot_events');
        mongoFichasCollection = mongoDb.collection('fichas');
        await mongoStateCollection.createIndex({ _id: 1 }, { unique: true });
        await mongoEventsCollection.createIndex({ createdAt: -1 });
        await mongoFichasCollection.createIndex({ userId: 1 }, { unique: true });
        console.log(`MongoDB conectado a la base "${MONGODB_DB}".`);
        console.log('========== CONNECT_MONGO_END (SUCCESS) ==========\n');
    } catch (error) {
        console.error('CONNECT MONGO ERROR -> Exception during connection:');
        console.error('Error message:', getErrorMessage(error));
        console.error('Error name:', error.name);
        console.error('Error code:', error.code);
        console.error('Full error:', error);
        mongoStore = null;
        mongoClient = null;
        mongoDb = null;
        mongoStateCollection = null;
        mongoEventsCollection = null;
        mongoFichasCollection = null;
        console.log('========== CONNECT_MONGO_END (FAILED) ==========\n');
    }
}

async function loadPersistentState() {
    if (!mongoStateCollection) {
        return;
    }

    const snapshot = await mongoStateCollection.findOne({ _id: 'runtime_state' });
    if (!snapshot || !snapshot.data) {
        return;
    }

    assignLoadedState(warnings, snapshot.data.warnings);
    assignLoadedState(mutedUsers, snapshot.data.mutedUsers);
    assignLoadedState(userMessages, snapshot.data.userMessages);
    assignLoadedState(usuariosPendientes, snapshot.data.usuariosPendientes);
    assignLoadedState(usuariosFicha, snapshot.data.usuariosFicha);
    assignLoadedState(userJoinLog, snapshot.data.userJoinLog);
    assignLoadedState(userLeaveLog, snapshot.data.userLeaveLog);
    assignLoadedState(avisos, snapshot.data.avisos);
    assignLoadedState(bannedUsers, snapshot.data.bannedUsers);
    console.log('Estado del bot restaurado desde MongoDB.');
}

async function savePersistentStateNow() {
    if (!mongoStateCollection) {
        return;
    }

    const payload = {
        _id: 'runtime_state',
        data: getPersistentStateSnapshot(),
        updatedAt: new Date()
    };

    await mongoStateCollection.updateOne(
        { _id: 'runtime_state' },
        { $set: payload },
        { upsert: true }
    );
}

function scheduleStateSave() {
    if (!mongoStateCollection) {
        return;
    }

    if (pendingStateSaveTimeout) {
        clearTimeout(pendingStateSaveTimeout);
    }

    pendingStateSaveTimeout = setTimeout(() => {
        pendingStateSaveTimeout = null;
        stateSaveInFlight = savePersistentStateNow()
            .catch(error => {
                console.error('No se pudo guardar el estado en MongoDB:', getErrorMessage(error));
            })
            .finally(() => {
                stateSaveInFlight = null;
            });
    }, STATE_SAVE_DEBOUNCE_MS);
}

function insertEventLog(doc) {
    if (!mongoEventsCollection) {
        return;
    }

    mongoEventsCollection.insertOne({
        ...doc,
        createdAt: new Date()
    }).catch(error => {
        console.error('No se pudo guardar el evento en MongoDB:', getErrorMessage(error));
    });
}

function shouldPersistChatEvent(action) {
    return PERSISTED_CHAT_ACTIONS.has(action);
}

function getTrackedChatId(chat) {
    return chat && chat.id ? chat.id._serialized : null;
}

function isTrackedChat(chat) {
    const chatId = getTrackedChatId(chat);
    return Boolean(chatId && TRACKED_GROUP_IDS.includes(chatId));
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
    scheduleStateSave();
}

function isBannedUser(userId) {
    const normalizedUserId = normalizeWhatsAppId(userId);

    return Object.keys(bannedUsers).some(bannedId => {
        return bannedId === userId || normalizeWhatsAppId(bannedId) === normalizedUserId;
    });
}

function cleanupOldState() {
    const now = Date.now();
    let stateChanged = false;
    const knownUsers = new Set([
        ...Object.keys(warnings),
        ...Object.keys(mutedUsers),
        ...Object.keys(userMessages),
        ...Object.keys(usuariosPendientes),
        ...Object.keys(usuariosFicha),
        ...Object.keys(userJoinLog),
        ...Object.keys(userLeaveLog),
        ...Object.keys(avisos),
        ...reminderTimeouts.keys(),
        ...kickTimeouts.keys()
    ]);

    for (const user of knownUsers) {
        const lastJoin = userJoinLog[user] || 0;
        const lastLeave = userLeaveLog[user] && userLeaveLog[user].timestamp ? userLeaveLog[user].timestamp : 0;
        const messages = userMessages[user] || [];
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : 0;
        const lastSeen = Math.max(lastJoin, lastLeave, lastMessage);

        if (!lastSeen || now - lastSeen > STALE_USER_TTL_MS) {
            deleteUserState(user);
            delete userLeaveLog[user];
            stateChanged = true;
        }
    }

    if (stateChanged) {
        scheduleStateSave();
    }

    if (typeof global.gc === 'function') {
        global.gc();
    }
}

function logUser(user, action) {
    console.log(`[LOG] ${user} -> ${action}`);

    if (action === 'JOIN' || action === 'LEAVE' || action === 'FICHA COMPLETADA') {
        insertEventLog({
            type: 'user_log',
            user,
            action
        });
    }
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

    if (shouldPersistChatEvent(action) && isTrackedChat(chat)) {
        insertEventLog({
            type: 'chat_event',
            action,
            details,
            chatId: getTrackedChatId(chat),
            chatName: chat ? getChatLabel(chat) : null
        });
    }
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
    scheduleStateSave();
    return warnings[user];
}

function muteUser(user, duration = DEFAULT_MUTE_MS) {
    mutedUsers[user] = true;
    userJoinLog[user] = Date.now();
    scheduleStateSave();

    setTimeout(() => {
        delete mutedUsers[user];
        scheduleStateSave();
    }, duration);
}

function esLink(text) {
    return LINK_REGEX.test(text);
}

function extraerEdad(texto) {
    const match = texto.match(/edad[:\s]*([0-9]{1,2})/i);
    return match ? parseInt(match[1], 10) : null;
}

function extraerCampo(texto, etiqueta) {
    const escaped = etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}\\s*[:：]\\s*(.+)`, 'i');
    const match = texto.match(regex);
    return match ? match[1].trim() : '';
}

function normalizarValorFicha(valor) {
    return valor.replace(/\s+/g, ' ').trim();
}

function parseNombreCompleto(texto) {
    const nombreCompleto = normalizarValorFicha(extraerCampo(texto, 'nombre'));
    const partes = nombreCompleto.split(' ').filter(Boolean);

    return {
        nombreCompleto,
        nombre: partes[0] || '',
        apellido: partes.length > 1 ? partes.slice(1).join(' ') : ''
    };
}

function extraerCumpleanos(texto) {
    return normalizarValorFicha(
        extraerCampo(texto, 'fecha de cumpleaños') || extraerCampo(texto, 'fecha de cumpleanos')
    );
}

function extraerSigno(texto) {
    return normalizarValorFicha(extraerCampo(texto, 'signo zodiaco'));
}

function normalizeModerationText(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function containsInsult(text) {
    const normalizedText = normalizeModerationText(text);

    if (!normalizedText) {
        return false;
    }

    return INSULTS.some(insulto => {
        const normalizedInsult = normalizeModerationText(insulto);
        const insultRegex = new RegExp(`(^|\\s)${normalizedInsult}(\\s|$)`, 'i');
        return insultRegex.test(normalizedText);
    });
}

function parseFichaData(texto, userId) {
    const nombreData = parseNombreCompleto(texto);
    const edad = extraerEdad(texto);
    const cumpleanos = extraerCumpleanos(texto);
    const signo = extraerSigno(texto);

    return {
        userId,
        nombre: nombreData.nombre,
        apellido: nombreData.apellido,
        nombreCompleto: nombreData.nombreCompleto,
        edad: edad || null,
        cumpleanos,
        signo
    };
}

async function saveFichaData(fichaData) {
    if (!mongoFichasCollection) {
        return;
    }

    await mongoFichasCollection.updateOne(
        { userId: fichaData.userId },
        {
            $set: {
                ...fichaData,
                updatedAt: new Date()
            },
            $setOnInsert: {
                createdAt: new Date()
            }
        },
        { upsert: true }
    );
}

async function findFichaByUserId(userId) {
    if (!mongoFichasCollection) {
        return null;
    }

    const directMatch = await mongoFichasCollection.findOne({ userId });
    if (directMatch) {
        return directMatch;
    }

    const normalizedUserId = normalizeWhatsAppId(userId);
    if (!normalizedUserId) {
        return null;
    }

    const fichas = await mongoFichasCollection.find({}, { projection: { userId: 1, nombre: 1, apellido: 1, nombreCompleto: 1, edad: 1, cumpleanos: 1, signo: 1, updatedAt: 1, createdAt: 1 } }).toArray();
    return fichas.find(ficha => normalizeWhatsAppId(ficha.userId) === normalizedUserId) || null;
}

async function deleteFichaByUserId(userId) {
    if (!mongoFichasCollection) {
        return 0;
    }

    const ficha = await findFichaByUserId(userId);
    if (!ficha) {
        return 0;
    }

    const result = await mongoFichasCollection.deleteOne({ _id: ficha._id });
    return result.deletedCount || 0;
}

async function getFichasStats() {
    if (!mongoFichasCollection) {
        return null;
    }

    const fichas = await mongoFichasCollection.find({}, { projection: { edad: 1 } }).toArray();
    const total = fichas.length;
    const conEdad = fichas.filter(ficha => Number.isFinite(ficha.edad));
    const elite = conEdad.filter(ficha => ficha.edad >= 17).length;
    const rookie = conEdad.filter(ficha => ficha.edad < 17).length;
    const mediaEdad = conEdad.length
        ? Math.round((conEdad.reduce((sum, ficha) => sum + ficha.edad, 0) / conEdad.length) * 10) / 10
        : 0;

    return { total, elite, rookie, mediaEdad };
}

async function getFichasRank(limit = 10) {
    if (!mongoFichasCollection) {
        return [];
    }

    return mongoFichasCollection
        .find({ edad: { $type: 'number' } }, { projection: { userId: 1, nombre: 1, apellido: 1, nombreCompleto: 1, edad: 1 } })
        .sort({ edad: -1, updatedAt: 1 })
        .limit(limit)
        .toArray();
}

async function getFichaNames(limit = 50) {
    if (!mongoFichasCollection) {
        return [];
    }

    return mongoFichasCollection
        .find({}, { projection: { userId: 1, nombreCompleto: 1, nombre: 1, apellido: 1 } })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(limit)
        .toArray();
}

function getUserId(msg) {
    if (msg.id && msg.id.participant) {
        return msg.id.participant;
    }

    if (msg.author) {
        return msg.author;
    }

    if (msg.fromMe && client && client.info && client.info.wid && client.info.wid._serialized) {
        return client.info.wid._serialized;
    }

    return msg.author || msg.from;
}

function normalizeWhatsAppId(value) {
    if (!value) {
        return '';
    }

    return String(value).split('@')[0].replace(/\D/g, '');
}

function participantMatchesUser(participant, userId) {
    if (!participant) {
        return false;
    }

    const candidateIds = [
        participant.id && participant.id._serialized,
        participant.id && participant.id.user,
        participant.lid,
        participant.phone
    ].filter(Boolean);

    const normalizedUserId = normalizeWhatsAppId(userId);

    return candidateIds.some(candidate => {
        return candidate === userId || normalizeWhatsAppId(candidate) === normalizedUserId;
    });
}

function getParticipantByUser(chat, userId) {
    return getChatParticipants(chat).find(participant => participantMatchesUser(participant, userId)) || null;
}

function getPrimaryUserNumber(chat, userId) {
    const participant = getParticipantByUser(chat, userId);
    const candidates = [
        participant && participant.phone,
        participant && participant.id && participant.id.user,
        participant && participant.id && participant.id._serialized,
        participant && participant.lid,
        userId
    ].filter(Boolean);

    for (const candidate of candidates) {
        const normalized = normalizeWhatsAppId(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return '';
}

function getCanonicalUserId(chat, userId) {
    const participant = getParticipantByUser(chat, userId);
    const candidates = [
        participant && participant.id && participant.id._serialized,
        participant && participant.lid,
        userId
    ].filter(Boolean);

    return candidates[0] || userId;
}

function isParticipantAdmin(participant) {
    if (!participant) {
        return false;
    }

    return Boolean(
        participant.isAdmin ||
        participant.isSuperAdmin ||
        participant.isGroupAdmin ||
        participant.admin
    );
}

function getChatParticipants(chat) {
    const sources = [
        chat && chat.participants,
        chat && chat.groupMetadata && chat.groupMetadata.participants,
        chat && chat.groupMetadata && chat.groupMetadata._data && chat.groupMetadata._data.participants
    ];

    for (const source of sources) {
        if (Array.isArray(source) && source.length > 0) {
            return source;
        }
    }

    return [];
}

function getCommandName(text) {
    if (!text.startsWith('!')) {
        return null;
    }

    return text.split(/\s+/)[0];
}

function isAuthorizedAdmin(userId) {
    const normalizedUserId = normalizeWhatsAppId(userId);

    return ADMIN_IDS.some(adminId => {
        return adminId === userId || normalizeWhatsAppId(adminId) === normalizedUserId;
    });
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

async function safeAddParticipants(chat, participants) {
    logChatEvent(chat, 'GROUP_JOIN', `usuarios-anadidos=${participants.join(', ')}`);
    await runClientOperation(
        'No se pudo anadir al usuario',
        () => chat.addParticipants(participants),
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
    let participantes = getChatParticipants(chat);

    if (participantes.length === 0 && client && chat && chat.id && chat.id._serialized) {
        try {
            const refreshedChat = await client.getChatById(chat.id._serialized);
            participantes = getChatParticipants(refreshedChat);
        } catch (error) {
            console.error('No se pudieron refrescar participantes del grupo:', getErrorMessage(error));
        }
    }

    const participante = participantes.find(participant => participantMatchesUser(participant, userId));
    if (participante) {
        return isParticipantAdmin(participante);
    }

    const normalizedUserId = normalizeWhatsAppId(userId);
    const normalizedOwnerId = normalizeWhatsAppId(
        client && client.info && client.info.wid && client.info.wid._serialized
    );

    if (normalizedUserId && normalizedOwnerId && normalizedUserId === normalizedOwnerId) {
        return true;
    }

    return false;
}

function buildFichaBienvenida(user) {
    return [
        'ំஂ◌｡೨⑅*.      🐉',
        '',
        `☰ ⌇─➭ welcome ${formatUserMention(user)} ﹀﹀ ੈ✩‧₊.  ↷`,
        '',
        '︽❨💣 ೃ/ੈː͡➘ Ficha de presentación',
        '',
        ' 彡ૢ⃢🫯 ·੭  Nombre: ',
        '',
        ' 彡ૢ⃢👑 ·੭ Género o pronombres:',
        '',
        ' 彡ૢ⃢🐉 ·੭ Edad: ',
        '',
        ' 彡ૢ⃢🧶 ·੭ Fecha de cumpleaños: ',
        '',
        ' 彡ૢ⃢💸 ·੭ Signo zodiaco:',
        '',
        ' 彡ૢ⃢🎧 ·੭ ¿Hobbies favoritos?:',
        '',
        ' 彡ૢ⃢💣 ·੭ ¿Series/libros/peliculas favoritas?:',
        '',
        ' 彡ૢ⃢🦩 ·੭ ¿Con que palabras te describirias?:',
        '',
        ' 彡ૢ⃢🎓 ·੭ ¿Cuál es tu mayor deseo?:',
        '',
        ' 彡ૢ⃢👑 ·੭ ¿Aceptas respetar las reglas?: ',
        '',
        ' 彡ૢ⃢🦋 ·੭ ¿En que otros clanes estás o estuviste? ',
        '',
        ' 彡ૢ⃢🪐 ·੭ Captura del codigo de amistad de among us (obligatorio)',
        '',
        ' 彡ૢ⃢🐿️ ·੭ Foto de tu carita hermosa (opcional)',
        '',
        '   ំஂ◌｡೨⑅*.      🐉'
    ].join('\n');
}

function buildLobbyBienvenida(user) {
    return [
        `Welcome ${formatUserMention(user)}`,
        '',
        'Completa tu ficha de presentacion y revisa las reglas del clan.'
    ].join('\n');
}

function buildDestinoBienvenida(user) {
    return [
        '╔═⚔️═🐉 DRΛXØRIX 死 ══⚔️═╗',
        '　　　☠️ 𝘽 𝙄 𝙀 𝙉 𝙑 𝙀 𝙉 𝙄 𝘿 𝙓 ☠️',
        '╚══🔥═══════════🔥═══╝',
        '',
        '꒰ 🫯⌒⌒⌒⌒ ೄ ༘ «⸙︽︽︽',
        `　　　➤ ${formatUserMention(user)}`,
        'ೄ ༘ «⸙︽︽︽ ⌒⌒⌒⌒💥꒰',
        '',
        '𖤐 Has entrado en DRΛXØRIX 死',
        'un clan donde solo sobreviven los que respetan el orden dentro del caos',
        '',
        '⊱╌╍⟞❬❀ೄ๑˚｡˚ ⛓️ *ೄ๑❀❭⟝╌╍╌⊰',
        '',
        '-ˏˋ¡!☠️ೄ Aquí no hay lugar para el debil',
        '-ˏˋ¡!☠️ೄ Se exige respeto absoluto',
        '-ˏˋ¡!☠️ೄ La traición se paga caro',
        '',
        '⊱╌╍⟞❬❀ೄ๑˚｡˚ ⛓️ *ೄ๑❀❭⟝╌╍╌⊰',
        '',
        '-ˏˋ¡!⚔️ೄ  Respeta las normas o cae',
        ' -ˏˋ¡!⚔️ೄ Demuestra tu nivel en las rooms',
        '-ˏˋ¡!⚔️ೄ  Gana tu lugar en el clan',
        '',
        '⊱╌╍⟞❬❀ೄ๑˚｡˚ ⛓️ *ೄ๑❀❭⟝╌╍╌⊰',
        '',
        '╰➤ NO MERCY · ONLY DRΛXØRIX 死 🐉🔥'
    ].join('\n');
}

function buildReglasClan() {
    return [
        'ୖୣ﹍﹍﹍﹍✿⡪⡪⡪̶᷍┊̶֑ . . . .⛓️‍💥~➴',
        '',
        '༊ཱི࿆᪰⃝🐉ླྀ DRΛXØRIX 死 | 𝙍𝙐𝙇𝙀𝙎: ཻུ࿆༅̼',
        '',
        '𓏸𓊔🪻⤾·˚ Para identificarnos como clan, utilizaremos el símbolo: 死',
        '',
        '𓏸𓊔🍃⤾·˚ En este clan contamos con una serie de normas que todos los miembros deben respetar:',
        '',
        '❙˗ˋ⌦;🐿️﹚ะ❱• No se permite el flood (mensajes excesivos) ni el spam.',
        '',
        '❙˗ˋ⌦;🦩﹚ะ❱• El envío de enlaces externos está restringido y requiere autorización previa de los administradores, especialmente si son de procedencia dudosa.',
        '',
        '❙˗ˋ⌦;🌵﹚ะ❱• Está prohibido el acoso, tanto hacia mujeres como hacia hombres, salvo consentimiento explícito.',
        '',
        '❙˗ˋ⌦;🐦‍🔥﹚ะ❱• En este clan todos somos iguales: se exige respeto, empatía y buen trato entre los miembros.',
        '',
        '❙˗ˋ⌦;🪺﹚ะ❱• La creación de códigos y salas solo está permitida con autorización previa de los administradores y debe hacerse con responsabilidad.',
        '',
        '𓏸𓊔🦋⤾·˚ Esperamos que disfruten su estancia y cumplan las normas de manera responsable.',
        '',
        '𓏸𓊔🕷️⤾·˚ Cualquier miembro que incumpla las normas será sancionado de forma correspondiente.',
        '',
        'ୖୣ﹍﹍﹍﹍✿⡪⡪⡪̶᷍┊̶֑ . . . .⛓️‍💥~➴'
    ].join('\n');
}

function formatUserMention(user) {
    return `@${normalizeWhatsAppId(user) || user.split('@')[0]}`;
}

function formatTimestamp(date) {
    return new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: 'Europe/Madrid'
    }).format(date);
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
    if (!ALLOWED_GROUPS.includes(chat.id._serialized)) {
        return;
    }

    const rawUser = notification.recipientIds[0];
    const user = getCanonicalUserId(chat, rawUser);
    const number = getPrimaryUserNumber(chat, rawUser);
    const lastLeave = userLeaveLog[user];

    userJoinLog[user] = Date.now();
    usuariosPendientes[user] = true;
    touchHealth();
    logUser(user, 'JOIN');
    logChatEvent(chat, 'GROUP_JOIN', `usuario=${user}`);
    scheduleStateSave();

    if (isBannedUser(user)) {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=usuario-baneado usuario=${user}`);
        await chat.sendMessage(`${formatUserMention(user)} baneado.`, {
            mentions: [user]
        });
        await safeRemoveParticipants(chat, [user]);
        deleteUserState(user);
        return;
    }

    if (chat.id._serialized !== GROUP_IDS.LOBBY) {
        // Send welcome message for ELITE and ROOKIE
        if (chat.id._serialized === GROUP_IDS.ELITE || chat.id._serialized === GROUP_IDS.ROOKIE) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=bienvenida-destino usuario=${user}`);
            await chat.sendMessage(buildDestinoBienvenida(user));
        }
        return;
    }

    if (lastLeave && lastLeave.chatId === chat.id._serialized) {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=reingreso-reciente usuario=${user}`);
        await chat.sendMessage(
            `${formatUserMention(user)} salió del grupo el día ${formatTimestamp(new Date(lastLeave.timestamp))}.`,
            { mentions: [user] }
        );
    }

    logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-bienvenida usuario=${user}`);
    await chat.sendMessage(`${buildLobbyBienvenida(user)}\n\n${buildReglasClan()}`);
    await chat.sendMessage(buildFichaBienvenida(user));

    clearUserTimers(user);

    const reminderTimer = setTimeout(async () => {
        if (!usuariosFicha[user]) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=recordatorio-ficha usuario=${user}`);
            await chat.sendMessage(`${formatUserMention(user)} recuerda rellenar tu ficha.`, {
                mentions: [user]
            });
        }
    }, REMINDER_MS);

    const kickTimer = setTimeout(async () => {
        if (!usuariosFicha[user]) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-no-rellenada usuario=${user}`);
            await chat.sendMessage(`${formatUserMention(user)} no rellenaste la ficha en 24h.`, {
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

    const comando = getCommandName(texto);
    const admin = isAuthorizedAdmin(usuario) || await esAdmin(chat, usuario);
    if (!admin) {
        return false;
    }

    const mencionados = msg.mentionedIds || [];
    const objetivo = mencionados[0] ? getCanonicalUserId(chat, mencionados[0]) : null;

    if (comando === '!help') {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=admin-help solicitado-por=${usuario}`);
        await chat.sendMessage([
            'COMANDOS ADMIN',
            '',
            '!help',
            '!reglas',
            '!bienvenida @usuario',
            '!ficha @usuario',
            '!perfil @usuario',
            '!fichas',
            '!stats',
            '!rank',
            '!resetdata @usuario',
            '!actualizardatos (respondiendo a una ficha)',
            '!expulsar @usuario',
            '!ban @usuario',
            '!unban @usuario',
            '!mute @usuario',
            '!unmute @usuario',
            '!borrar (respondiendo a un mensaje)',
            '!cerrar',
            '!abrir',
            '!aviso @usuario',
            '!quitaraviso @usuario',
            '!avisos @usuario'
        ].join('\n'));
        return true;
    }

    if (comando === '!reglas') {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=reglas solicitado-por=${usuario}`);
        await chat.sendMessage(buildReglasClan());
        return true;
    }

    if (comando === '!bienvenida') {
        const destinatario = objetivo || usuario;

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=bienvenida-manual objetivo=${destinatario} solicitado-por=${usuario}`);
        await chat.sendMessage(`${buildLobbyBienvenida(destinatario)}\n\n${buildReglasClan()}`);
        await chat.sendMessage(buildFichaBienvenida(destinatario));
        return true;
    }

    if (comando === '!ficha') {
        const destinatario = objetivo || usuario;

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-manual objetivo=${destinatario} solicitado-por=${usuario}`);
        await chat.sendMessage(buildFichaBienvenida(destinatario));
        return true;
    }

    if (comando === '!perfil') {
        if (!objetivo) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        if (!mongoFichasCollection) {
            await chat.sendMessage('MongoDB no disponible. Verifica la conexión.');
            return true;
        }

        const ficha = await findFichaByUserId(objetivo);
        if (!ficha) {
            await chat.sendMessage('No hay datos guardados para ese usuario.');
            return true;
        }

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=perfil objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage([
            `Perfil de ${ficha.nombreCompleto || [ficha.nombre, ficha.apellido].filter(Boolean).join(' ') || formatUserMention(ficha.userId)}`,
            `Usuario: ${formatUserMention(ficha.userId)}`,
            `Edad: ${ficha.edad || 'No guardada'}`,
            `Cumpleanos: ${ficha.cumpleanos || 'No guardado'}`,
            `Signo: ${ficha.signo || 'No guardado'}`,
            `Actualizado: ${ficha.updatedAt ? formatTimestamp(new Date(ficha.updatedAt)) : 'Sin fecha'}`
        ].join('\n'));
        return true;
    }

    if (comando === '!fichas') {
        const fichas = await getFichaNames();
        if (!mongoFichasCollection) {
            await chat.sendMessage('MongoDB no disponible. Verifica la conexión.');
            return true;
        }

        if (fichas.length === 0) {
            await chat.sendMessage('No hay fichas guardadas.');
            return true;
        }

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=fichas solicitado-por=${usuario}`);
        await chat.sendMessage([
            'FICHAS GUARDADAS',
            ...fichas.map((ficha, index) => `${index + 1}. ${ficha.nombreCompleto || [ficha.nombre, ficha.apellido].filter(Boolean).join(' ') || formatUserMention(ficha.userId)}`)
        ].join('\n'));
        return true;
    }

    if (comando === '!stats') {
        const stats = await getFichasStats();
        if (!mongoFichasCollection) {
            await chat.sendMessage('MongoDB no disponible. Verifica la conexión.');
            return true;
        }

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=stats solicitado-por=${usuario}`);
        await chat.sendMessage([
            'STATS FICHAS',
            `Total: ${stats.total}`,
            `Elite: ${stats.elite}`,
            `Rookie: ${stats.rookie}`,
            `Edad media: ${stats.mediaEdad}`
        ].join('\n'));
        return true;
    }

    if (comando === '!rank') {
        const ranking = await getFichasRank();
        if (!mongoFichasCollection) {
            await chat.sendMessage('MongoDB no disponible. Verifica la conexión.');
            return true;
        }

        if (ranking.length === 0) {
            await chat.sendMessage('No hay datos suficientes para el rank.');
            return true;
        }

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=rank solicitado-por=${usuario}`);
        await chat.sendMessage([
            'RANK EDAD',
            ...ranking.map((ficha, index) => `${index + 1}. ${ficha.nombreCompleto || [ficha.nombre, ficha.apellido].filter(Boolean).join(' ') || formatUserMention(ficha.userId)} - ${ficha.edad}`)
        ].join('\n'));
        return true;
    }

    if (comando === '!resetdata') {
        if (!objetivo) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        if (!mongoFichasCollection) {
            await chat.sendMessage('MongoDB no disponible. Verifica la conexión.');
            return true;
        }

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=resetdata objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage('Eliminando datos...');
        const deleted = await deleteFichaByUserId(objetivo);
        if (deleted > 0) {
            await chat.sendMessage('Datos eliminados.');
        } else {
            await chat.sendMessage('No habia datos guardados para ese usuario.');
        }
        return true;
    }

    if (comando === '!actualizardatos') {
        if (!mongoFichasCollection) {
            await chat.sendMessage('MongoDB no disponible. Verifica la conexión.');
            return true;
        }

        if (!msg.hasQuotedMsg) {
            await chat.sendMessage('Usa !actualizardatos respondiendo a una ficha.');
            return true;
        }

        const quotedMessage = await msg.getQuotedMessage();
        if (!quotedMessage) {
            await chat.sendMessage('No se pudo encontrar el mensaje citado.');
            return true;
        }

        const quotedText = (quotedMessage.body || '').toLowerCase().trim();
        if (!isFicha(quotedText)) {
            await chat.sendMessage('El mensaje citado no parece una ficha.');
            return true;
        }

        const quotedUser = objetivo || getUserId(quotedMessage);
        const fichaData = parseFichaData(quotedText, quotedUser);

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=actualizardatos objetivo=${quotedUser} solicitado-por=${usuario}`);
        await chat.sendMessage('Actualizando datos...');

        try {
            await saveFichaData(fichaData);
            await chat.sendMessage(`Datos actualizados para ${formatUserMention(quotedUser)}.`, {
                mentions: [quotedUser]
            });
        } catch (error) {
            console.error('No se pudo actualizar la ficha en MongoDB:', getErrorMessage(error));
            await chat.sendMessage('No se pudieron actualizar los datos.');
        }
        return true;
    }

    if (comando === '!expulsar') {
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=expulsar-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        await safeRemoveParticipants(chat, mencionados);
        mencionados
            .map(mencionado => getCanonicalUserId(chat, mencionado))
            .forEach(deleteUserState);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=usuario-expulsado solicitado-por=${usuario}`);
        await chat.sendMessage(`${formatUserMention(mencionados[0])} expulsado.`, {
            mentions: [mencionados[0]]
        });
        return true;
    }

    if (comando === '!ban') {
        if (!objetivo) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        bannedUsers[objetivo] = true;
        scheduleStateSave();
        await safeRemoveParticipants(chat, [objetivo]);
        deleteUserState(objetivo);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=ban objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(`${formatUserMention(objetivo)} baneado.`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (comando === '!unban') {
        if (!objetivo) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        delete bannedUsers[objetivo];
        scheduleStateSave();
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=unban objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(`Ban quitado a ${formatUserMention(objetivo)}.`);
        return true;
    }

    if (comando === '!mute') {
        if (!objetivo) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        muteUser(objetivo);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=mute objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(`Mute aplicado a ${formatUserMention(objetivo)} por 1 minuto.`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (comando === '!unmute') {
        if (!objetivo) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        if (!mutedUsers[objetivo]) {
            await chat.sendMessage(`${formatUserMention(objetivo)} no está silenciado.`);
            return true;
        }

        delete mutedUsers[objetivo];
        scheduleStateSave();
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=unmute objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(`Mute removido a ${formatUserMention(objetivo)}.`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (comando === '!borrar') {
        if (!msg.hasQuotedMsg) {
            await chat.sendMessage('Usa !borrar respondiendo al mensaje que quieras eliminar.');
            return true;
        }

        const quotedMessage = await msg.getQuotedMessage();
        if (!quotedMessage) {
            await chat.sendMessage('No se pudo encontrar el mensaje citado.');
            return true;
        }

        await safeDeleteMessage(quotedMessage);
        await safeDeleteMessage(msg);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=borrar solicitado-por=${usuario}`);
        return true;
    }

    if (comando === '!cerrar') {
        await safeSetAdminsOnly(chat, true);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=grupo-cerrado solicitado-por=${usuario}`);
        await chat.sendMessage('Grupo cerrado.');
        return true;
    }

    if (comando === '!abrir') {
        await safeSetAdminsOnly(chat, false);
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=grupo-abierto solicitado-por=${usuario}`);
        await chat.sendMessage('Grupo abierto.');
        return true;
    }

    if (comando === '!aviso') {
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=aviso-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = getCanonicalUserId(chat, mencionados[0]);
        avisos[objetivo] = (avisos[objetivo] || 0) + 1;
        userJoinLog[objetivo] = Date.now();
        scheduleStateSave();

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=aviso objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(
            `Aviso para ${formatUserMention(objetivo)} (${avisos[objetivo]}/3) por ${formatUserMention(usuario)}.`,
            { mentions: [objetivo, usuario] }
        );

        if (avisos[objetivo] >= 3) {
            await safeRemoveParticipants(chat, [objetivo]);
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=expulsado-por-avisos objetivo=${objetivo}`);
            await chat.sendMessage(`${formatUserMention(objetivo)} expulsado por 3 avisos. Ultimo aviso de ${formatUserMention(usuario)}.`, {
                mentions: [objetivo, usuario]
            });
            deleteUserState(objetivo);
        }
        return true;
    }

    if (comando === '!quitaraviso') {
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=quitaraviso-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = getCanonicalUserId(chat, mencionados[0]);
        avisos[objetivo] = 0;
        userJoinLog[objetivo] = Date.now();
        scheduleStateSave();

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=avisos-reiniciados objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(`Avisos reiniciados para ${formatUserMention(objetivo)}.`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (comando === '!avisos') {
        if (mencionados.length === 0) {
            logChatEvent(chat, 'SEND_MESSAGE', `motivo=avisos-sin-mencion solicitado-por=${usuario}`);
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = getCanonicalUserId(chat, mencionados[0]);
        const cantidad = avisos[objetivo] || 0;

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=consultar-avisos objetivo=${objetivo} solicitado-por=${usuario}`);
        await chat.sendMessage(
            `${formatUserMention(objetivo)} tiene ${cantidad} avisos.`,
            { mentions: [objetivo] }
        );
        return true;
    }

    return false;
}

async function manejarModeracionLobby(msg, chat, text, user) {
    if (!ALLOWED_GROUPS.includes(chat.id._serialized)) {
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
    scheduleStateSave();

    if (userMessages[user].length > FLOOD_LIMIT) {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=spam-detectado usuario=${user}`);
        await chat.sendMessage('Spam detectado. Evita enviar mensajes repetidos.');
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

    if (containsInsult(text)) {
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

    const fichaData = parseFichaData(text, user);

    usuariosFicha[user] = true;
    delete usuariosPendientes[user];
    userJoinLog[user] = Date.now();
    clearUserTimers(user);
    logUser(user, 'FICHA COMPLETADA');
    scheduleStateSave();

    try {
        const archive = await client.getChatById(GROUP_IDS.ARCHIVE);
        await safeAddParticipants(archive, [user]);
        logChatEvent(archive, 'GROUP_JOIN', `usuario-anadido=${user}`);
        logChatEvent(archive, 'FORWARD_FICHA', `usuario=${user}`);
        await msg.forward(archive);
    } catch (error) {
        console.error('No se pudo anadir o reenviar la ficha al archivo:', error.message);
    }

    try {
        await saveFichaData(fichaData);
    } catch (error) {
        console.error('No se pudo guardar la ficha en MongoDB:', getErrorMessage(error));
    }

    const edad = fichaData.edad;
    if (!edad) {
        logChatEvent(chat, 'SEND_MESSAGE', `motivo=edad-no-detectada usuario=${user}`);
        await chat.sendMessage('No se detecto la edad correctamente.');
        return true;
    }

    const destinoId = edad >= 17 ? GROUP_IDS.ELITE : GROUP_IDS.ROOKIE;
    const grupoNombre = edad >= 17 ? 'ELITE' : 'ROOKIE';

    try {
        const grupoDestino = await client.getChatById(destinoId);
        await safeAddParticipants(grupoDestino, [user]);
        logChatEvent(grupoDestino, 'GROUP_JOIN', `usuario-anadido=${user}`);

        logChatEvent(grupoDestino, 'SEND_MESSAGE', `motivo=bienvenida-destino usuario=${user}`);
        await grupoDestino.sendMessage(buildDestinoBienvenida(user));

        logChatEvent(chat, 'SEND_MESSAGE', `motivo=ficha-completada usuario=${user} destino=${grupoNombre}`);
        await chat.sendMessage([
            'Gracias por completar tu ficha de presentación',
            '',
            'Este grupo es solo para presentaciones, por lo que serás removido/a en breve.',
            '',
            'Para continuar y disfrutar de la experiencia completa, solicitá unirte a los siguientes grupos:',
            'Rooms',
            'Archive',
            '',
            `Seras añadido a ${grupoNombre}. Gracias por unirte.`
        ].join('\n'));

        setTimeout(async () => {
            await safeRemoveParticipants(chat, [user]);
            deleteUserState(user);
        }, FICHA_EXIT_DELAY_MS);
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

    currentClient.on('group_leave', async notification => {
        touchHealth();

        try {
            const chat = await notification.getChat();
            const user = notification.recipientIds[0];

            if (!chat || !user) {
                return;
            }

            userLeaveLog[user] = {
                chatId: chat.id._serialized,
                timestamp: Date.now()
            };

            logUser(user, 'LEAVE');
            logChatEvent(chat, 'GROUP_LEAVE', `usuario=${user}`);
            scheduleStateSave();
        } catch (error) {
            const handled = handleChromiumOperationError(error, 'group_leave', { restart: true });
            if (!handled) {
                console.error('Error en group_leave:', getErrorMessage(error));
            }
        }
    });

    const handleGroupMessage = async msg => {
        touchHealth();

        try {
            if (!shouldProcessMessage(msg)) {
                return;
            }

            const text = (msg.body || '').toLowerCase().trim();

            const chat = await msg.getChat();
            if (!chat.isGroup) {
                return;
            }

            const user = getUserId(msg);
            logIncomingMessage(chat, user, text, msg.fromMe);

            if (msg.fromMe && !text.startsWith('!')) {
                return;
            }

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
    };

    currentClient.on('message', handleGroupMessage);
    currentClient.on('message_create', handleGroupMessage);
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

async function shutdownPersistence() {
    clearTimer(pendingStateSaveTimeout);
    pendingStateSaveTimeout = null;

    try {
        await savePersistentStateNow();
    } catch (error) {
        console.error('No se pudo guardar el estado final en MongoDB:', getErrorMessage(error));
    }

    if (stateSaveInFlight) {
        await stateSaveInFlight;
    }

    if (mongoClient) {
        await mongoClient.close();
        mongoClient = null;
    }

    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
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
    await shutdownPersistence();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT recibido. Cerrando cliente...');
    await destroyCurrentClient();
    await shutdownPersistence();
    process.exit(0);
});

async function bootstrap() {
    console.log('\n\n========== BOOTSTRAP_START ==========');
    console.log('BOOTSTRAP DEBUG -> Starting bootstrap');
    console.log('BOOTSTRAP DEBUG -> MONGODB_URI present:', Boolean(process.env.MONGODB_URI));
    console.log('BOOTSTRAP DEBUG -> MONGODB_DB:', process.env.MONGODB_DB || 'draxorix_bot');
    console.log('BOOTSTRAP DEBUG -> SESSION_CLIENT_ID:', process.env.SESSION_CLIENT_ID || 'draxorix-bot');
    console.log('BOOTSTRAP DEBUG -> About to connect to MongoDB...');

    await connectMongo();
    
    console.log('BOOTSTRAP DEBUG -> After connectMongo, mongoStore status:', Boolean(mongoStore));
    console.log('BOOTSTRAP DEBUG -> After connectMongo, mongoFichasCollection status:', Boolean(mongoFichasCollection));
    
    await loadPersistentState();
    
    console.log('BOOTSTRAP DEBUG -> Persistent state loaded. Starting schedulers...');
    startSchedulers();
    
    console.log('BOOTSTRAP DEBUG -> Schedulers started. Starting client...');
    await startClient();
    
    console.log('========== BOOTSTRAP_END ==========\n');
}

bootstrap().catch(error => {
    console.error('No se pudo iniciar el cliente:', getErrorMessage(error));
    restartClient('initial start failed');
});
