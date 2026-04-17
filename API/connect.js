const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestWaWebVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require('gifted-baileys');

const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

module.exports = async function handler(req, res) {
    // ── CORS ──────────────────────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    // ── SSE headers ───────────────────────────────────────────────────────────
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

    // ── Temp session dir (cleaned up after) ───────────────────────────────────
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiama-'));
    let sock;
    let done = false;

    const cleanup = () => {
        try { if (sock) sock.end(undefined); } catch (_) {}
        try { fs.removeSync(sessionDir); } catch (_) {}
    };

    req.on('close', () => { if (!done) cleanup(); });

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
            markOnlineOnConnect: false
        });

        sock.ev.on('creds.update', saveCreds);

        let pairingRequested = false;

        sock.ev.on('connection.update', async (update) => {
            if (done) return;
            const { connection, qr, lastDisconnect } = update;

            // ── QR or Pairing code ─────────────────────────────────────────
            if (qr) {
                if (usePairing && !pairingRequested) {
                    pairingRequested = true;
                    try {
                        const code = await sock.requestPairingCode(phone);
                        send('pairing_code', { code: code.match(/.{1,4}/g).join('-') });
                    } catch (e) {
                        send('error', { message: 'Failed to get pairing code: ' + e.message });
                    }
                } else if (!usePairing) {
                    try {
                        const image = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
                        send('qr', { image });
                    } catch (e) {
                        send('error', { message: 'QR generation failed' });
                    }
                }
            }

            // ── Connected ──────────────────────────────────────────────────
            if (connection === 'open') {
                send('status', { message: 'Connected! Generating session ID...' });
                await new Promise(r => setTimeout(r, 2500));

                const credsPath = path.join(sessionDir, 'creds.json');
                if (!fs.existsSync(credsPath)) {
                    send('error', { message: 'creds.json not found. Please try again.' });
                    res.end(); cleanup(); done = true; return;
                }

                const raw = fs.readFileSync(credsPath, 'utf8');
                const compressed = zlib.gzipSync(Buffer.from(raw, 'utf8'));
                const b64 = compressed.toString('base64');
                const sessionId = `KiamaConnect~${b64}`;

                send('session', { id: sessionId });
                done = true;
                cleanup();
                res.end();
            }

            // ── Closed ─────────────────────────────────────────────────────
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (!done) {
                    send('error', { message: `Connection closed (${reason || 'unknown'}). Please try again.` });
                    done = true;
                    cleanup();
                    res.end();
                }
            }
        });

    } catch (err) {
        send('error', { message: err.message });
        cleanup();
        res.end();
    }
};
