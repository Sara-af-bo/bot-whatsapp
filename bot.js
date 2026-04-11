const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// 🔒 PONEMOS EL ID DESPUÉS
const GRUPO_ID = "AQUI_VA_EL_ID";

const client = new Client({
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// QR
client.on('qr', qr => {
    console.log('Escanea este QR:');
    qrcode.generate(qr, { small: true });
});

// READY + SACAR IDS
client.on('ready', async () => {
    console.log('Bot listo 🚀');

    const chats = await client.getChats();
    chats.forEach(chat => {
        if (chat.isGroup) {
            console.log("Grupo:", chat.name);
            console.log("ID:", chat.id._serialized);
            console.log("-------------------");
        }
    });
});

// 👇 DETECTAR ENTRADA
client.on('group_join', async (notification) => {
    const chat = await notification.getChat();

    // 🔒 SOLO TU GRUPO
    if (chat.id._serialized !== GRUPO_ID) return;

    const user = notification.recipientIds[0];

    const mensaje = `
ំஂ◌｡೨⑅*.      🐉

☰ ⌇─➭ welcome @${user.split('@')[0]} ﹀﹀ ੈ✩‧₊.  ↷

︽❨💣 ೃ/ੈː͡➘ Ficha de presentación

 彡ૢ⃢🫯 ·੭  _Nombre:_ 

 彡ૢ⃢👑 ·੭ _Género o pronombres:_

 彡ૢ⃢🐉 ·੭ _Edad:_ 

 彡ૢ⃢🧶 ·੭ _Fecha de cumpleaños:_ 

 彡ૢ⃢💸 ·੭ _Signo zodiaco:_

 彡ૢ⃢🎧 ·੭ _¿Hobbies favoritos?:_

 彡ૢ⃢💣 ·੭ _¿Series/libros/peliculas favoritas?:_

 彡ૢ⃢🦩 ·੭ _¿Con que palabras te describirias?:_

 彡ૢ⃢🎓 ·੭ _¿Cuál es tu mayor deseo?:_

 彡ૢ⃢👑 ·੭ _¿Aceptas respetar las reglas?:_ 

 彡ૢ⃢🦋 ·੭ _¿En que otros clanes estás o estabas?_ 

 彡ૢ⃢🪐 ·੭ _Captura del codigo de amistad de among us (obligatorio)_

 彡ૢ⃢🐿️ ·੭ _Foto de tu carita hermosa (opcional)_

   ༊ཱི࿆᪰⃝🐉 DRΛXØRIX 死
`;

    await chat.sendMessage(mensaje, {
        mentions: [user]
    });
});

client.initialize();