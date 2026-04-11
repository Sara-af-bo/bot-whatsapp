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

const WEB_PORT = 3000;

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
let latestQR = null;

const app = express();

app.get('/qr', (req, res) => {
    const qrMarkup = latestQR
        ? `<img src="${latestQR}" style="max-width:300px;" />`
        : '<p>QR no generado aún</p>';

    res.send(`
    <html>
    <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:white;flex-direction:column;">
        <h2>Escanea el QR</h2>
        ${qrMarkup}
    </body>
    </html>
    `);
});

app.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`Servidor QR activo en puerto ${WEB_PORT}`);
});

function createClient() {
    return new Client({
        authStrategy: new LocalAuth({ clientId: 'draxorix-bot' }),
        restartOnAuthFail: true,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
        qrMaxRetries: 20,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ]
        }
    });
}

function addWarning(user) {
    warnings[user] = (warnings[user] || 0) + 1;
    return warnings[user];
}

function muteUser(user, duration = DEFAULT_MUTE_MS) {
    mutedUsers[user] = true;
    setTimeout(() => delete mutedUsers[user], duration);
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
    try { await msg.delete(true); } catch {}
}

async function safeRemoveParticipants(chat, users) {
    try { await chat.removeParticipants(users); } catch {}
}

async function safeSetAdminsOnly(chat, enabled) {
    try { await chat.setMessagesAdminsOnly(enabled); } catch {}
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

function bindEvents(client) {

    client.on('qr', async qr => {
        latestQR = await QRCode.toDataURL(qr);
        console.log('QR listo en /qr');
    });

    client.on('ready', () => {
        latestQR = null;
        console.log('Bot unificado activo');
    });

    client.on('group_join', async notification => {
        const chat = await notification.getChat();
        if (chat.id._serialized !== GROUP_IDS.LOBBY) return;

        const user = notification.recipientIds[0];
        const number = user.split('@')[0];

        if (!ALLOWED_PREFIXES.some(p => number.startsWith(p))) {
            await chat.sendMessage('Numero no permitido.');
            await safeRemoveParticipants(chat, [user]);
            return;
        }

        await chat.sendMessage(buildFichaBienvenida(user), { mentions: [user] });
    });

    client.on('message', async msg => {

        if (msg.fromMe) return;

        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const user = getUserId(msg);
        const text = (msg.body || '').toLowerCase();

        if (mutedUsers[user]) {
            await safeDeleteMessage(msg);
            return;
        }

        // flood
        const now = Date.now();
        userMessages[user] = userMessages[user] || [];
        userMessages[user].push(now);
        userMessages[user] = userMessages[user].filter(t => now - t < FLOOD_WINDOW_MS);

        if (userMessages[user].length > FLOOD_LIMIT) {
            await chat.sendMessage('Spam detectado. Mute.');
            muteUser(user);
            return;
        }

        // links
        if (esLink(text)) {
            await safeDeleteMessage(msg);
            const w = addWarning(user);

            if (w >= 2) {
                await chat.sendMessage('Expulsado por links.');
                await safeRemoveParticipants(chat, [user]);
            } else {
                await chat.sendMessage('Warning por links.');
            }
            return;
        }

        // insultos
        if (INSULTS.some(i => text.includes(i))) {
            const w = addWarning(user);

            if (w === 1) {
                await chat.sendMessage('Warning.');
            } else if (w === 2) {
                muteUser(user);
            } else {
                await safeRemoveParticipants(chat, [user]);
            }

            return;
        }

        // ficha
        if (chat.id._serialized === GROUP_IDS.LOBBY && isFicha(text)) {

            const edad = extraerEdad(text);
            if (!edad) return;

            const destino = edad >= 17 ? GROUP_IDS.ELITE : GROUP_IDS.ROOKIE;

            const grupo = await client.getChatById(destino);
            await grupo.addParticipants([user]);

            await grupo.sendMessage(buildDestinoBienvenida(user), { mentions: [user] });

            setTimeout(async () => {
                await safeRemoveParticipants(chat, [user]);
            }, 3000);
        }
    });

    client.on('disconnected', reason => {
        console.log('Desconectado:', reason);
    });
}

async function start() {
    client = createClient();
    bindEvents(client);
    await client.initialize();
}

start().catch(console.error);
