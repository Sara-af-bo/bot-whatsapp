const { Client, LocalAuth } = require('whatsapp-web.js');

const GRUPO_ID = "120363408940060754@g.us";

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    }
});

// 🧠 MEMORIA
const usuariosPendientes = {};
const usuariosFicha = {};

// 🚫 LISTA INSULTOS (puedes ampliar)
const insultos = ["puta", "gilipollas", "idiota", "imbecil", "tonto", "subnormal"];

// 🔗 DETECTOR LINKS
const esLink = (text) => {
    return /(https?:\/\/|www\.|\.com|\.gg|\.net)/i.test(text);
};

// 📩 CUANDO ENTRA ALGUIEN
client.on('group_join', async (notification) => {
    const chat = await notification.getChat();

    if (chat.id._serialized !== GRUPO_ID) return;

    const user = notification.recipientIds[0];

    usuariosPendientes[user] = Date.now();

    // ⏳ 24h timeout
    setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage(
                "A causa de que han pasado las 24 horas y no rellenaste ficha serás eliminado del grupo. Si quieres volver a ingresar manda mensaje privado a los administradores. Gracias por unirte."
            );

            await chat.removeParticipants([user]);
        }
    }, 24 * 60 * 60 * 1000); // 24h
});

// 📩 DETECTAR MENSAJES
client.on('message', async (msg) => {
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.id._serialized !== GRUPO_ID) return;

    const user = msg.author || msg.from;
    const texto = msg.body.toLowerCase();

    // 🔗 LINKS → BORRAR + EXPULSAR
    if (esLink(texto)) {
        await msg.delete(true);

        await chat.sendMessage("🚫 Enlaces no permitidos. Usuario eliminado.");

        await chat.removeParticipants([user]);
        return;
    }

    // 🚫 INSULTOS → CERRAR GRUPO
    if (insultos.some(i => texto.includes(i))) {
        await chat.sendMessage("Se ha detectado faltas de respeto se cerrará el grupo hasta que aparezcan los administradores.");

        await chat.setMessagesAdminsOnly(true);
        return;
    }

    // ✅ DETECTAR FICHA COMPLETADA (básico)
    if (
        texto.includes("nombre") &&
        texto.includes("edad") &&
        texto.includes("hobbies")
    ) {
        usuariosFicha[user] = true;

        await chat.sendMessage(
            "Cuando se conecten los administradores serás añadido a tus grupos correspondientes. Si tienes configuraciones que impiden añadirte, cambia ajustes o añade a admins a contactos. Mantente a la espera. Gracias por unirte."
        );
    }
});

client.on('ready', () => {
    console.log("🔥 BOT PRO ACTIVO");
});

client.initialize();
