const { Client, LocalAuth } = require('whatsapp-web.js');

const GRUPO_ID = "120363408940060754@g.us";

const client = new Client({
authStrategy: new LocalAuth({ clientId: "admin" }),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox']
    }
});

// 🧠 MEMORIA
const warnings = {};
const mutedUsers = {};
const userMessages = {};
const usuariosPendientes = {};
const usuariosFicha = {};
const userJoinLog = {};

// 🚫 INSULTOS
const insultos = ["puta","gilipollas","idiota","imbecil","subnormal"];

// 🌍 PREFIJOS PERMITIDOS (España + Latam)
const allowedPrefixes = ["34","52","54","57","51","58","56","593","591","595","598"];

// 🔗 DETECTOR LINK
const esLink = (text) => /(https?:\/\/|www\.|\.com|\.gg|\.net)/i.test(text);

// 📊 REGISTRO
function logUser(user, action) {
    console.log(`[LOG] ${user} → ${action}`);
}

// ⚠️ WARNINGS
function addWarning(user) {
    if (!warnings[user]) warnings[user] = 0;
    warnings[user]++;
    return warnings[user];
}

// 🔇 MUTE
function muteUser(user, duration = 60000) {
    mutedUsers[user] = true;

    setTimeout(() => {
        delete mutedUsers[user];
    }, duration);
}

// 📲 ENTRADA
client.on('group_join', async (notification) => {
    const chat = await notification.getChat();
    if (chat.id._serialized !== GRUPO_ID) return;

    const user = notification.recipientIds[0];

    userJoinLog[user] = Date.now();
    usuariosPendientes[user] = true;

    logUser(user, "JOIN");

    // 🌍 FILTRO NUMERO
    const number = user.split("@")[0];

    if (!allowedPrefixes.some(p => number.startsWith(p))) {
        await chat.sendMessage("🚫 Número no permitido.");
        await chat.removeParticipants([user]);
        return;
    }

    // ⏳ RECORDATORIO 12h
    setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage("⏳ Recuerda rellenar tu ficha.");
        }
    }, 12 * 60 * 60 * 1000);

    // ⏳ EXPULSIÓN 24h
    setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage("❌ No rellenaste ficha en 24h. Eliminado.");
            await chat.removeParticipants([user]);
        }
    }, 24 * 60 * 60 * 1000);
});

// 📩 MENSAJES
client.on('message', async (msg) => {
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.id._serialized !== GRUPO_ID) return;

    const user = msg.author || msg.from;
    const text = msg.body.toLowerCase();

    // 🔇 MUTE SIMULADO
    if (mutedUsers[user]) {
        await msg.delete(true);
        return;
    }

    // 📊 ANTIFLOOD
    if (!userMessages[user]) userMessages[user] = [];
    userMessages[user].push(Date.now());

    userMessages[user] = userMessages[user].filter(t => Date.now() - t < 5000);

    if (userMessages[user].length > 5) {
        await chat.sendMessage("⚠️ Spam detectado → mute 1 min");
        muteUser(user);
        return;
    }

    // 🔗 LINKS
    if (esLink(text)) {
        await msg.delete(true);

        const w = addWarning(user);

        if (w >= 2) {
            await chat.sendMessage("🚫 Enlaces prohibidos → expulsado");
            await chat.removeParticipants([user]);
        } else {
            await chat.sendMessage("⚠️ Enlaces no permitidos (warning)");
        }
        return;
    }

    // 🚫 INSULTOS
    if (insultos.some(i => text.includes(i))) {
        const w = addWarning(user);

        if (w === 1) {
            await chat.sendMessage("⚠️ Respeta las normas (warning)");
        } else if (w === 2) {
            await chat.sendMessage("🔇 Mute por comportamiento");
            muteUser(user, 60000);
        } else {
            await chat.sendMessage("❌ Expulsado por faltas de respeto");
            await chat.removeParticipants([user]);
        }

        // 🔒 CERRAR GRUPO
        await chat.setMessagesAdminsOnly(true);

        // 🔓 ABRIR EN 10 MIN
        setTimeout(async () => {
            await chat.setMessagesAdminsOnly(false);
        }, 10 * 60 * 1000);

        return;
    }

    // 📋 DETECTAR FICHA
    if (text.includes("nombre") && text.includes("edad")) {
        usuariosFicha[user] = true;

        await chat.sendMessage(
            "✅ Ficha completada. En un momento se te añade al grupo."
        );

        logUser(user, "FICHA COMPLETADA");
    }
});

client.on('ready', () => {
    console.log("🔥 BOT ULTRA ACTIVO");
});

client.initialize();
