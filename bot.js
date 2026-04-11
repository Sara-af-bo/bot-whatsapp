const fs = require('fs');
const path = require('path');
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
const QR_IMAGE_PATH = path.join(__dirname, 'qr.png');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'draxorix-bot' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

const warnings = {};
const mutedUsers = {};
const userMessages = {};
const usuariosPendientes = {};
const usuariosFicha = {};
const userJoinLog = {};
const avisos = {};

function logUser(user, action) {
    console.log(`[LOG] ${user} -> ${action}`);
}

function addWarning(user) {
    warnings[user] = (warnings[user] || 0) + 1;
    return warnings[user];
}

function muteUser(user, duration = DEFAULT_MUTE_MS) {
    mutedUsers[user] = true;

    setTimeout(() => {
        delete mutedUsers[user];
    }, duration);
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
    try {
        await msg.delete(true);
    } catch (error) {
        console.error('No se pudo borrar el mensaje:', error.message);
    }
}

async function safeRemoveParticipants(chat, participants) {
    try {
        await chat.removeParticipants(participants);
    } catch (error) {
        console.error('No se pudo expulsar al usuario:', error.message);
    }
}

async function safeSetAdminsOnly(chat, enabled) {
    try {
        await chat.setMessagesAdminsOnly(enabled);
    } catch (error) {
        console.error('No se pudo cambiar el estado del grupo:', error.message);
    }
}

async function esAdmin(chat, userId) {
    const participante = chat.participants.find(
        participant => participant.id._serialized === userId
    );

    return Boolean(participante && participante.isAdmin);
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

async function manejarEntradaLobby(notification) {
    const chat = await notification.getChat();
    if (chat.id._serialized !== GROUP_IDS.LOBBY) {
        return;
    }

    const user = notification.recipientIds[0];
    const number = user.split('@')[0];

    userJoinLog[user] = Date.now();
    usuariosPendientes[user] = true;
    logUser(user, 'JOIN');

    if (!ALLOWED_PREFIXES.some(prefix => number.startsWith(prefix))) {
        await chat.sendMessage('Numero no permitido.');
        await safeRemoveParticipants(chat, [user]);
        return;
    }

    await chat.sendMessage(buildFichaBienvenida(user), {
        mentions: [user]
    });

    setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage(`@${number} recuerda rellenar tu ficha.`, {
                mentions: [user]
            });
        }
    }, REMINDER_MS);

    setTimeout(async () => {
        if (!usuariosFicha[user]) {
            await chat.sendMessage(`@${number} no rellenaste la ficha en 24h.`, {
                mentions: [user]
            });
            await safeRemoveParticipants(chat, [user]);
        }
    }, KICK_DELAY_MS);
}

async function manejarComandosAdmin(msg, chat, texto, usuario) {
    if (!ALLOWED_GROUPS.includes(chat.id._serialized)) {
        return false;
    }

    const admin = await esAdmin(chat, usuario);
    if (!admin) {
        return false;
    }

    if (texto.startsWith('!expulsar')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        await safeRemoveParticipants(chat, mencionados);
        await chat.sendMessage('Usuario expulsado.');
        return true;
    }

    if (texto === '!cerrar') {
        await safeSetAdminsOnly(chat, true);
        await chat.sendMessage('Grupo cerrado.');
        return true;
    }

    if (texto === '!abrir') {
        await safeSetAdminsOnly(chat, false);
        await chat.sendMessage('Grupo abierto.');
        return true;
    }

    if (texto.startsWith('!aviso')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        avisos[objetivo] = (avisos[objetivo] || 0) + 1;

        await chat.sendMessage(
            `Aviso para @${objetivo.split('@')[0]} (${avisos[objetivo]}/3)`,
            { mentions: [objetivo] }
        );

        if (avisos[objetivo] >= 3) {
            await safeRemoveParticipants(chat, [objetivo]);
            await chat.sendMessage('Expulsado por 3 avisos.');
            delete avisos[objetivo];
        }
        return true;
    }

    if (texto.startsWith('!quitaraviso')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        avisos[objetivo] = 0;

        await chat.sendMessage(`Avisos reiniciados para @${objetivo.split('@')[0]}`, {
            mentions: [objetivo]
        });
        return true;
    }

    if (texto.startsWith('!avisos')) {
        const mencionados = msg.mentionedIds || [];
        if (mencionados.length === 0) {
            await chat.sendMessage('Debes mencionar a alguien.');
            return true;
        }

        const objetivo = mencionados[0];
        const cantidad = avisos[objetivo] || 0;

        await chat.sendMessage(
            `@${objetivo.split('@')[0]} tiene ${cantidad} avisos.`,
            { mentions: [objetivo] }
        );
        return true;
    }

    if (texto === '!help') {
        await chat.sendMessage([
            'COMANDOS ADMIN',
            '',
            '!expulsar @usuario',
            '!cerrar',
            '!abrir',
            '!aviso @usuario',
            '!quitaraviso @usuario',
            '!avisos @usuario'
        ].join('\n'));
        return true;
    }

    return false;
}

async function manejarModeracionLobby(msg, chat, text, user) {
    if (chat.id._serialized !== GROUP_IDS.LOBBY) {
        return false;
    }

    if (mutedUsers[user]) {
        await safeDeleteMessage(msg);
        return true;
    }

    userMessages[user] = userMessages[user] || [];
    userMessages[user].push(Date.now());
    userMessages[user] = userMessages[user].filter(
        timestamp => Date.now() - timestamp < FLOOD_WINDOW_MS
    );

    if (userMessages[user].length > FLOOD_LIMIT) {
        await chat.sendMessage('Spam detectado. Mute de 1 minuto.');
        muteUser(user);
        return true;
    }

    if (esLink(text)) {
        await safeDeleteMessage(msg);
        const warningCount = addWarning(user);

        if (warningCount >= 2) {
            await chat.sendMessage('Enlaces prohibidos. Usuario expulsado.');
            await safeRemoveParticipants(chat, [user]);
        } else {
            await chat.sendMessage('Enlaces no permitidos. Warning.');
        }
        return true;
    }

    if (INSULTS.some(insulto => text.includes(insulto))) {
        const warningCount = addWarning(user);

        if (warningCount === 1) {
            await chat.sendMessage('Respeta las normas. Warning.');
        } else if (warningCount === 2) {
            await chat.sendMessage('Mute por comportamiento.');
            muteUser(user, DEFAULT_MUTE_MS);
        } else {
            await chat.sendMessage('Expulsado por faltas de respeto.');
            await safeRemoveParticipants(chat, [user]);
        }

        await safeSetAdminsOnly(chat, true);

        setTimeout(async () => {
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

    usuariosFicha[user] = true;
    delete usuariosPendientes[user];
    logUser(user, 'FICHA COMPLETADA');

    try {
        const archive = await client.getChatById(GROUP_IDS.ARCHIVE);
        await msg.forward(archive);
    } catch (error) {
        console.error('No se pudo reenviar la ficha al archivo:', error.message);
    }

    const edad = extraerEdad(text);
    if (!edad) {
        await chat.sendMessage('No se detecto la edad correctamente.');
        return true;
    }

    const destinoId = edad >= 17 ? GROUP_IDS.ELITE : GROUP_IDS.ROOKIE;
    const grupoNombre = edad >= 17 ? 'ELITE' : 'ROOKIE';

    try {
        const grupoDestino = await client.getChatById(destinoId);
        await grupoDestino.addParticipants([user]);

        await grupoDestino.sendMessage(buildDestinoBienvenida(user), {
            mentions: [user]
        });

        await chat.sendMessage(`Ficha completada. Usuario anadido a ${grupoNombre}.`);

        setTimeout(async () => {
            await safeRemoveParticipants(chat, [user]);
        }, 3000);
    } catch (error) {
        console.error('No se pudo anadir al usuario al grupo destino:', error.message);
        await chat.sendMessage('No se pudo anadir al usuario al grupo destino.');
    }

    return true;
}

client.on('qr', async qr => {
    try {
        if (fs.existsSync(QR_IMAGE_PATH)) {
            fs.unlinkSync(QR_IMAGE_PATH);
        }

        await QRCode.toFile(QR_IMAGE_PATH, qr, {
            type: 'png',
            width: 420,
            margin: 2
        });

        console.log(`QR guardado como imagen en: ${QR_IMAGE_PATH}`);
    } catch (error) {
        console.error('No se pudo generar el QR como imagen:', error.message);
    }
});

client.on('ready', async () => {
    console.log('Bot unificado activo.');

    const chats = await client.getChats();
    chats.forEach(chat => {
        if (chat.isGroup) {
            console.log(`Grupo: ${chat.name}`);
            console.log(`ID: ${chat.id._serialized}`);
            console.log('-------------------');
        }
    });
});

client.on('group_join', async notification => {
    await manejarEntradaLobby(notification);
});

client.on('message', async msg => {
    if (msg.fromMe) {
        return;
    }

    const chat = await msg.getChat();
    if (!chat.isGroup) {
        return;
    }

    const user = getUserId(msg);
    const text = (msg.body || '').toLowerCase().trim();

    const comandoProcesado = await manejarComandosAdmin(msg, chat, text, user);
    if (comandoProcesado) {
        return;
    }

    const moderacionProcesada = await manejarModeracionLobby(msg, chat, text, user);
    if (moderacionProcesada) {
        return;
    }

    await manejarFichaLobby(msg, chat, text, user);
});

client.initialize();
