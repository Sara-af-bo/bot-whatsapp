const { Client, LocalAuth } = require('whatsapp-web.js');

const LOBBY_ID = "120363408940060754@g.us";
const ROOKIE_ID = "120363426241635796@g.us";
const ELITE_ID = "120363426931376573@g.us";
const ARCHIVE_ID = "120363425009767808@g.us";

const client = new Client({
authStrategy: new LocalAuth({ clientId: "roles" }),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox']
    }
});

// 🧠 EXTRAER EDAD
function extraerEdad(texto) {
    const match = texto.match(/edad[:\s]*([0-9]{1,2})/i);
    return match ? parseInt(match[1]) : null;
}

// 📩 DETECTAR FICHA
client.on('message', async (msg) => {
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.id._serialized !== LOBBY_ID) return;

   const user = msg.author || msg.from;
const texto = msg.body.toLowerCase();

if (texto.includes("nombre") && texto.includes("edad")) {

    // 🔥 REENVIAR SOLO FICHA
    const archive = await client.getChatById(ARCHIVE_ID);
    await msg.forward(archive);

        const edad = extraerEdad(texto);

        if (!edad) {
            await chat.sendMessage("⚠️ No se detectó la edad correctamente.");
            return;
        }

        let destinoID;
        let grupoNombre;

        if (edad >= 17) {
            destinoID = ELITE_ID;
            grupoNombre = "ELITE";
        } else {
            destinoID = ROOKIE_ID;
            grupoNombre = "ROOKIE";
        }

        try {
            const grupoDestino = await client.getChatById(destinoID);

            // ➕ AÑADIR
            await grupoDestino.addParticipants([user]);

            const mensaje = `
╔═⚔️═🐉 *DRΛXØRIX* 死 ══⚔️═╗
　　　☠️ 𝘽 𝙄 𝙀 𝙉 𝙑 𝙀 𝙉 𝙄 𝘿 𝙓 ☠️
╚══🔥═══════════🔥═══╝

꒰ 🫯⌒⌒⌒⌒ ೄ ༘ «⸙︽︽︽
　　　➤ @${user.split('@')[0]}
ೄ ༘ «⸙︽︽︽ ⌒⌒⌒⌒💥꒰

╰➤ *NO MERCY* · ONLY DRΛXØRIX 死 🐉🔥
`;

            await grupoDestino.sendMessage(mensaje, {
                mentions: [user]
            });

            await chat.sendMessage(`✅ Usuario añadido a ${grupoNombre}`);

            // ⏳ ELIMINAR DEL LOBBY
            setTimeout(async () => {
                try {
                    await chat.removeParticipants([user]);
                } catch (err) {
                    console.error("Error eliminando:", err);
                }
            }, 3000);

        } catch (err) {
            console.error(err);
            await chat.sendMessage("❌ No se pudo añadir.");
        }
    }
}); // 🔥 ESTE CIERRE TE FALTABA

// ✅ READY FUERA
client.on('ready', () => {
    console.log("🔥 BOT ROLES ACTIVO (17+ ELITE)");
});

// ✅ INIT FUERA
client.initialize();
