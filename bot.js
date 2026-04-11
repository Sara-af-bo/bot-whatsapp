const { Client } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');

const GRUPO_ID = "120363408940060754@g.us";

const client = new Client({
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    }
});

// 🔥 QR EN IMAGEN + BASE64 (para copiar fácil)
client.on('qr', async (qr) => {
    console.log('Generando QR...');

    try {
        // Guardar imagen
        await QRCode.toFile('qr.png', qr);

        // Generar base64 (esto es clave)
        const qrBase64 = await QRCode.toDataURL(qr);

        console.log('QR generado correctamente');
        console.log('COPIA ESTE LINK EN EL NAVEGADOR:');
        console.log(qrBase64);

    } catch (err) {
        console.error('Error generando QR:', err);
    }
});

// READY
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

// ENTRADA AL GRUPO
client.on('group_join', async (notification) => {
    const chat = await notification.getChat();

    if (chat.id._serialized !== GRUPO_ID) return;

    const user = notification.recipientIds[0];

    // 📩 MENSAJE 1: BIENVENIDA + FICHA
    const ficha = `
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

 彡ૢ⃢🦋 ·੭ _¿En que otros clanes estás o estuviste?_ 

 彡ૢ⃢🪐 ·੭ _Captura del codigo de amistad de among us (obligatorio)_

 彡ૢ⃢🐿️ ·੭ _Foto de tu carita hermosa (opcional)_

   ༊ཱི࿆᪰⃝🐉 DRΛXØRIX 死
`;

    // 📜 MENSAJE 2: NORMAS (COMPLETAS)
    const normas = `
ୖୣ﹍﹍﹍﹍✿⡪⡪⡪̶᷍┊̶֑ . . . .⛓️‍💥~➴

༊ཱི࿆᪰⃝🐉ླྀ DRΛXØRIX 死 | 𝙍𝙐𝙇𝙀𝙎: ཻུ࿆༅̼

𓏸𓊔🪻⤾·˚ Para *identificarnos* como clan, utilizaremos el símbolo: 死

𓏸𓊔🍃⤾·˚ En este clan contamos con una serie de *normas* que todos los miembros deben *respetar:*

❙˗ˋ⌦;🐿️﹚ะ❱• No se permite el *flood* (mensajes excesivos) ni el *spam.*

❙˗ˋ⌦;🦩﹚ะ❱• El envío de *enlaces externos* está *restringido* y requiere *autorización previa* de los *administradores,* especialmente si son de procedencia dudosa.

❙˗ˋ⌦;🌵﹚ะ❱• Está *prohibido el acoso,* tanto hacia mujeres como hacia hombres, salvo *consentimiento explícito.*

❙˗ˋ⌦;🐦‍🔥﹚ะ❱• En este clan todos somos *iguales:* se exige *respeto, empatía* y *buen trato* entre los miembros.

❙˗ˋ⌦;🪺﹚ะ❱• La creación de *códigos* y *salas* solo está permitida con *autorización previa* de los administradores y debe hacerse con *responsabilidad.*

𓏸𓊔🦋⤾·˚ Esperamos que disfruten su estancia y cumplan las normas de manera *responsable.*

𓏸𓊔🕷️⤾·˚ Cualquier miembro que incumpla las normas será *sancionado* de forma correspondiente.

ୖୣ﹍﹍﹍﹍✿⡪⡪⡪̶᷍┊̶֑ . . . .⛓️‍💥~➴
`;

    // 🚀 ENVÍO SEPARADO
    await chat.sendMessage(ficha, { mentions: [user] });
    await chat.sendMessage(normas);
});

client.initialize();
