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
const ALLOWED_PREFIXES = ['34','52','54','57','51','58','56','593','591','595','598'];
const INSULTS = ['puta','gilipollas','idiota','imbecil','subnormal'];
const LINK_REGEX = /(https?:\/\/|www\.|\.com|\.gg|\.net)/i;

const FLOOD_WINDOW_MS = 5000;
const FLOOD_LIMIT = 5;
const DEFAULT_MUTE_MS = 60000;

const WEB_PORT = 3000;

const warnings = {};
const mutedUsers = {};
const userMessages = {};
const avisos = {};

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
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-zygote'
            ]
        }
    });
}

function addWarning(user) {
    warnings[user] = (warnings[user] || 0) + 1;
    return warnings[user];
}

function muteUser(user) {
    mutedUsers[user] = true;
    setTimeout(() => delete mutedUsers[user], DEFAULT_MUTE_MS);
}

function getUserId(msg) {
    return msg.author || msg.from;
}

async function safeRemoveParticipants(chat, users) {
    try { await chat.removeParticipants(users); } catch {}
}

async function safeSetAdminsOnly(chat, enabled) {
    try { await chat.setMessagesAdminsOnly(enabled); } catch {}
}

function bindEvents(client) {

    client.on('qr', async qr => {
        latestQR = await QRCode.toDataURL(qr);
        console.log('QR listo en /qr');
    });

    client.on('ready', () => {
        latestQR = null;
        console.log('Bot activo');
    });

    client.on('message', async msg => {

        if (msg.fromMe) return;

        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const user = getUserId(msg);
        const text = (msg.body || '').toLowerCase().trim();

        // =====================
        // COMANDOS
        // =====================

        if (text.startsWith('!help')) {
            await chat.sendMessage(`
COMANDOS:

!help
!expulsar @usuario
!cerrar
!abrir
!aviso @usuario
!quitaraviso @usuario
!avisos @usuario
            `);
            return;
        }

        if (!ALLOWED_GROUPS.includes(chat.id._serialized)) return;

        const isAdmin = chat.participants.find(p =>
            p.id._serialized === user &&
            (p.isAdmin || p.isSuperAdmin)
        );

        if (text.startsWith('!expulsar') && isAdmin) {
            const mentions = msg.mentionedIds || [];
            if (mentions.length) {
                await safeRemoveParticipants(chat, mentions);
                await chat.sendMessage('Usuario expulsado.');
            }
            return;
        }

        if (text === '!cerrar' && isAdmin) {
            await safeSetAdminsOnly(chat, true);
            await chat.sendMessage('Grupo cerrado.');
            return;
        }

        if (text === '!abrir' && isAdmin) {
            await safeSetAdminsOnly(chat, false);
            await chat.sendMessage('Grupo abierto.');
            return;
        }

        if (text.startsWith('!aviso') && isAdmin) {
            const m = msg.mentionedIds || [];
            if (m.length) {
                const u = m[0];
                avisos[u] = (avisos[u] || 0) + 1;

                await chat.sendMessage(`Aviso ${avisos[u]}/3`, { mentions: [u] });

                if (avisos[u] >= 3) {
                    await safeRemoveParticipants(chat, [u]);
                }
            }
            return;
        }

        if (text.startsWith('!quitaraviso') && isAdmin) {
            const m = msg.mentionedIds || [];
            if (m.length) {
                avisos[m[0]] = 0;
                await chat.sendMessage('Avisos reiniciados');
            }
            return;
        }

        if (text.startsWith('!avisos') && isAdmin) {
            const m = msg.mentionedIds || [];
            if (m.length) {
                const count = avisos[m[0]] || 0;
                await chat.sendMessage(`Tiene ${count} avisos`, { mentions: m });
            }
            return;
        }

        // =====================
        // MODERACIÓN
        // =====================

        if (mutedUsers[user]) return;

        const now = Date.now();
        userMessages[user] = userMessages[user] || [];
        userMessages[user].push(now);
        userMessages[user] = userMessages[user].filter(t => now - t < FLOOD_WINDOW_MS);

        if (userMessages[user].length > FLOOD_LIMIT) {
            await chat.sendMessage('Spam detectado.');
            muteUser(user);
            return;
        }

        if (LINK_REGEX.test(text)) {
            const w = addWarning(user);
            if (w >= 2) {
                await safeRemoveParticipants(chat, [user]);
            } else {
                await chat.sendMessage('Warning por links.');
            }
            return;
        }

        if (INSULTS.some(i => text.includes(i))) {
            const w = addWarning(user);
            if (w === 1) {
                await chat.sendMessage('Warning.');
            } else if (w === 2) {
                muteUser(user);
            } else {
                await safeRemoveParticipants(chat, [user]);
            }
        }
    });
}

async function start() {
    client = createClient();
    bindEvents(client);
    await client.initialize();
}

start().catch(console.error);
