const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestWaWebVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event, data) => {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (res.flush) res.flush();
        } catch (_) {}
    };

    const phone = (req.query.phone || '').replace(/[^0-9]/g, '');
    const usePairing = phone.length > 7;

    const sessionDir = path.join(os.tmpdir(), `kiama_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    let sock;
    let done = false;

    const cleanup = () => {
        try { if (sock) sock.end(undefined); } catch (_) {}
        try { fs.removeSync(sessionDir); } catch (_) {}
    };

    req.on('close', () => { if (!done) cleanup(); });

    const pingInterval = setInterval(() => {
        try { res.write(': ping\n\n'); if (res.flush) res.flush(); } catch (_) {}
    }, 15000);

    const finish = () => {
        done = true;
        clearInterval(pingInterval);
        cleanup();
        try { res.end(); } catch (_) {}
    };

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestWaWebVersion();
        const logger = pino({ level: 'silent' });

        sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            browser: ['Ubuntu', 'Chrome', '22.04.4'],
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            getMessage: async () => undefined
        });

        sock.ev.on('creds.update', saveCreds);

        let pairingRequested = false;

        sock.ev.on('connection.update', async (update) => {
            if (done) return;
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                if (usePairing && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        await new Promise(r => setTimeout(r, 2000));
                        const code = await sock.requestPairingCode(phone);
                        const formatted = code.match(/.{1,4}/g)?.join('-') || code;
                        send('pairing_code', { code: formatted });
                    } catch (e) {
                        send('error', { message: 'Failed to get pairing code: ' + e.message });
                        finish();
                    }
                } else if (!usePairing) {
                    try {
                        const image = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
                        send('qr', { image });
                    } catch (e) {
                        send('error', { message: 'QR generation failed' });
                        finish();
                    }
                }
            }

            if (connection === 'open') {
                send('status', { message: 'Connected! Generating session ID...' });
                await new Promise(r => setTimeout(r, 3000));
                await saveCreds();
                await new Promise(r => setTimeout(r, 1000));

                const credsPath = path.join(sessionDir, 'creds.json');
                if (!fs.existsSync(credsPath)) {
                    send('error', { message: 'Session file not found. Please try again.' });
                    finish();
                    return;
                }

                const raw = fs.readFileSync(credsPath, 'utf8');
                const compressed = zlib.gzipSync(Buffer.from(raw, 'utf8'));
                const b64 = compressed.toString('base64');
                const sessionId = `KiamaConnect~${b64}`;

                send('session', { id: sessionId });
                finish();
            }

            if (connection === 'close') {
                if (done) return;
                const reason = lastDisconnect?.error?.output?.statusCode;
                send('error', {
                    message: reason === DisconnectReason.loggedOut
                        ? 'WhatsApp rejected the session. Please try again.'
                        : `Connection closed (${reason || 'unknown'}). Please try again.`
                });
                finish();
            }
        });

    } catch (err) {
        send('error', { message: err.message || 'Unexpected error. Please try again.' });
        finish();
    }
};
