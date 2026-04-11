const { Client, LocalAuth } = require('whatsapp-web.js');

// 📌 TUS GRUPOS
const LOBBY_ID = "120363408940060754@g.us";
const ROOKIE_ID = "120363426241635796@g.us";
const ELITE_ID = "120363426931376573@g.us";

const GRUPOS_PERMITIDOS = [LOBBY_ID, ROOKIE_ID, ELITE_ID];

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox']
    }
});

// ⚠️ Sistema de avisos
const avisos = {};

// 🔐 Comprobar admin
async function esAdmin(chat, userId) {
    const participantes = await chat.participants;
    return participantes.find(p => p.id._serialized === userId && p.isAdmin);
}

// 📩 MENSAJES
client.on('message', async (msg) => {
    if (msg.fromMe) return;

    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    // 🔒 SOLO ESTOS GRUPOS
    if (!GRUPOS_PERMITIDOS.includes(chat.id._serialized)) return;

    const usuario = msg.author || msg.from;
    const texto = msg.body.toLowerCase();

    const admin = await esAdmin(chat, usuario);
    if (!admin) return;

    // ============================
    // 💀 EXPULSAR
    // ============================
    if (texto.startsWith("!expulsar")) {
        const mencionados = msg.mentionedIds;

        if (mencionados.length === 0) {
            await chat.sendMessage("❌ Debes mencionar a alguien.");
            return;
        }

        await chat.removeParticipants(mencionados);
        await chat.sendMessage("💀 Usuario expulsado.");
    }

    // ============================
    // 🔇 CERRAR
    // ============================
    if (texto === "!cerrar") {
        await chat.setMessagesAdminsOnly(true);
        await chat.sendMessage("🔇 Grupo cerrado.");
    }

    // ============================
    // 🔊 ABRIR
    // ============================
    if (texto === "!abrir") {
        await chat.setMessagesAdminsOnly(false);
        await chat.sendMessage("🔓 Grupo abierto.");
    }

    // ============================
    // ⚠️ AVISO
    // ============================
    if (texto.startsWith("!aviso")) {
        const mencionados = msg.mentionedIds;
        if (mencionados.length === 0) return;

        const objetivo = mencionados[0];

        if (!avisos[objetivo]) avisos[objetivo] = 0;
        avisos[objetivo]++;

        await chat.sendMessage(
            `⚠️ Aviso para @${objetivo.split('@')[0]} (${avisos[objetivo]}/3)`,
            { mentions: [objetivo] }
        );

        if (avisos[objetivo] >= 3) {
            await chat.removeParticipants([objetivo]);
            await chat.sendMessage("💀 Expulsado por 3 avisos.");
            delete avisos[objetivo];
        }
    }

    // ============================
    // ❌ QUITAR AVISO
    // ============================
    if (texto.startsWith("!quitaraviso")) {
        const mencionados = msg.mentionedIds;
        if (mencionados.length === 0) return;

        const objetivo = mencionados[0];
        avisos[objetivo] = 0;

        await chat.sendMessage(
            `✅ Avisos reiniciados para @${objetivo.split('@')[0]}`,
            { mentions: [objetivo] }
        );
    }

    // ============================
    // 📊 VER AVISOS
    // ============================
    if (texto.startsWith("!avisos")) {
        const mencionados = msg.mentionedIds;
        if (mencionados.length === 0) return;

        const objetivo = mencionados[0];
        const cantidad = avisos[objetivo] || 0;

        await chat.sendMessage(
            `📊 @${objetivo.split('@')[0]} tiene ${cantidad} avisos`,
            { mentions: [objetivo] }
        );
    }

    // ============================
    // 📜 HELP
    // ============================
    if (texto === "!help") {
        await chat.sendMessage(`
⚔️ *COMANDOS ADMIN* ⚔️

💀 !expulsar @usuario
🔇 !cerrar
🔓 !abrir
⚠️ !aviso @usuario
❌ !quitaraviso @usuario
📊 !avisos @usuario

━━━━━━━━━━━━━━━
🔥 Solo admins pueden usar esto
        `);
    }
});

// READY
client.on('ready', () => {
    console.log("🔥 BOT ADMIN ACTIVO EN 3 GRUPOS");
});

client.initialize();
