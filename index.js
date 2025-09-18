/**
 * index.js — KAYA-MD (adapté pour Baileys v6+ et Render)
 *
 * - Utilise `useMultiFileAuthState` (créera un dossier auth_info/)
 * - Expose une page HTTP "/" qui affiche le QR (DataURL) pour scanner
 * - Sauvegarde automatiquement les credentials via saveCreds
 *
 * Avant d'exécuter:
 * npm install
 * npm start
 *
 * Sécurité: n'ajoute pas le dossier auth_info/ au dépôt (ajoute au .gitignore).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeInMemoryStore
} = require('baileys');

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info'; // dossier créé par useMultiFileAuthState
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ---------------- Express & UI QR ---------------- */
const app = express();
let latestQRCodeDataUrl = null;
let qrLastUpdated = null;
let connectionStatus = 'starting';

app.get('/', (req, res) => {
  if (!latestQRCodeDataUrl) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="5"><title>KAYA-MD — QR</title></head>
        <body style="font-family: Arial, sans-serif; text-align:center; padding:40px">
          <h1>KAYA-MD</h1>
          <h2>Status: ${connectionStatus}</h2>
          <p>En attente du QR… la page se rafraîchit toutes les 5s.</p>
          <p>Regarde les logs si rien n'apparait.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head><title>KAYA-MD — QR</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family: Arial, sans-serif; text-align:center; padding:20px">
        <h1>KAYA-MD</h1>
        <h3>Status: ${connectionStatus}</h3>
        <p>Dernière génération: ${qrLastUpdated}</p>
        <img src="${latestQRCodeDataUrl}" alt="WhatsApp QR" style="max-width:90%;height:auto;"/>
        <p style="margin-top:12px">Scanner avec WhatsApp → Menu > Appareils liés > Scanner un code</p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: connectionStatus, qrLastUpdated });
});

/* ---------------- Baileys + auth ---------------- */

async function startSocket() {
  try {
    connectionStatus = 'fetching-baileys-version';
    let version = [2, 2204, 13];
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched && Array.isArray(fetched.version)) version = fetched.version;
      logger.info('Baileys version:', { version });
    } catch (err) {
      logger.warn('Impossible de récupérer la dernière version de Baileys, fallback utilisé.');
    }

    // useMultiFileAuthState crée/charge un dossier (ex: auth_info/)
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    connectionStatus = 'starting-socket';
    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      version
    });

    // sauvegarde automatique des cred quand elles changent
    sock.ev.on('creds.update', saveCreds);

    // optionnel : store mémoire (si besoin)
    let store = null;
    try {
      if (makeInMemoryStore) {
        store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });
        if (store && store.bind) store.bind(sock.ev);
      }
    } catch (e) {
      logger.debug('store non chargé:', e);
    }

    // connection update handler
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            latestQRCodeDataUrl = await QRCode.toDataURL(qr);
            qrLastUpdated = new Date().toISOString();
            connectionStatus = 'qr-generated';
            logger.info('QR généré et exposé via HTTP /');
          } catch (qErr) {
            logger.error('Erreur conversion QR -> DataURL:', qErr);
          }
        }

        if (connection) {
          connectionStatus = connection;
          logger.info('connection.update', { connection });
          // Lorsque connection ouverte, enlever le QR
          if (connection === 'open') {
            latestQRCodeDataUrl = null;
            qrLastUpdated = new Date().toISOString();
            logger.info('Session ouverte. Auth saved.');
          }
        }

        if (lastDisconnect && lastDisconnect.error) {
          const err = lastDisconnect.error;
          logger.warn('lastDisconnect:', err && err.output ? err.output.payload : err);

          const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
          // comportements selon le code
          if (code === DisconnectReason.badSession || code === DisconnectReason.loggedOut) {
            logger.warn('Session invalide. Suppression du dossier d\'auth et redémarrage pour re-login.');
            try {
              // supprime les fichiers d'auth (auth_info/*)
              if (fs.existsSync(AUTH_DIR)) {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
              }
            } catch (e) {
              logger.error('Impossible de supprimer auth dir:', e);
            }
            setTimeout(() => startSocket(), 2000);
          } else if (code === DisconnectReason.restartRequired || code === DisconnectReason.connectionClosed) {
            logger.info('Redémarrage du socket...');
            setTimeout(() => startSocket(), 2000);
          } else {
            logger.info('Tentative de reconnexion dans 5s...');
            setTimeout(() => startSocket(), 5000);
          }
        }
      } catch (e) {
        logger.error('Erreur dans connection.update handler:', e);
      }
    });

    // messages handler (exemple minimal)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages || [];
        for (const msg of messages) {
          if (!msg.message) continue;
          const from = msg.key.remoteJid;
          logger.info('Message reçu', { from, type: Object.keys(msg.message)[0] });
          // Exemple réponse (désactivée)
          // if (msg.message.conversation) {
          //   await sock.sendMessage(from, { text: 'OK' }, { quoted: msg });
          // }
        }
      } catch (err) {
        logger.error('Erreur messages.upsert:', err);
      }
    });

    logger.info('Socket initialisé.');
    return sock;
  } catch (err) {
    logger.error('Erreur startSocket():', err);
    setTimeout(() => startSocket(), 5000);
  }
}

/* ---------------- démarrage serveur + socket ---------------- */
(async () => {
  app.listen(PORT, () => {
    logger.info(`HTTP server pour QR en écoute sur le port ${PORT}`);
  });

  await startSocket();
})();
