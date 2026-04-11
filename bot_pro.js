const { Client, LocalAuth } = require('whatsapp-web.js');

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

const GRUPO_ID = "120363408940060754@g.us";

// 🚫 PALABRAS PROHIBIDAS (puedes añadir más)
const insultos = [
    "puta", "gilipollas", "idiota", "subnormal", "mierda", "imbecil"
];

// 🔗 DETECTOR DE LINKS
const linkRegex = /(https?:\/\/|www\.|\.com|\.net|\.org)/i;

// 📩 DETECTAR MENSAJES
client.on('message', async (msg) => {
    const chat = await msg.getChat();

    if (!chat.isGroup) return;
    if (chat.id._serialized !== GRUPO_ID) return;

    const texto = msg.body.toLowerCase();
    const user = msg.author || msg.from;

    // 🚫 DETECTAR LINKS
    if (linkRegex.test(texto)) {
        console.log("🔗 Link detectado");

        try {
            await msg.delete(true); // borrar mensaje
            await chat.removeParticipants([user]); // expulsar
        } catch (e) {
            console.log("Error eliminando usuario:", e);
        }

        return;
    }

    // 🤬 DETECTAR INSULTOS
    if (insultos.some(p => texto.includes(p))) {
        console.log("⚠️ Insulto detectado");

        await chat.sendMessage(
            "⚠️ Se ha detectado faltas de respeto.\nEl grupo se cerrará hasta que aparezcan los administradores."
        );

        try {
            await chat.setMessagesAdminsOnly(true); // solo admins pueden escribir
        } catch (e) {
            console.log("Error cerrando grupo:", e);
        }

        return;
    }

    // ✅ DETECTAR FICHA COMPLETA (simple)
    if (
        texto.includes("nombre") &&
        texto.includes("edad") &&
        texto.includes("hobbies")
    ) {
        await chat.sendMessage(`
Cuando se conecten los administradores serán añadidos a sus grupos correspondientes.

Si tienen alguna configuración que no permite añadir personas externas a ustedes, cambien sus ajustes o añadidlos a vuestros contactos.

Manténganse a la espera en este grupo.

Gracias por unirte. Que disfrutes de tu estancia ✨
`);
    }
});

client.on('ready', () => {
    console.log("🔥 BOT PRO ACTIVADO");
});

client.initialize();
