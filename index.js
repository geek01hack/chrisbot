/**
 * index.js — KAYA-MD (version adaptée Render + QR web)
 *
 * 1) npm install @whiskeysockets/baileys qrcode express pino
 * 2) Déployer sur Render (Web Service) avec start: "node index.js"
 * 3) Ouvre l'URL fournie par Render et scanne le QR affiché.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const baileys = require('@whiskeysockets/baileys');
const {
  default: makeWASocket,
  useSingleFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeInMemoryStore
} = baileys;

const PORT = process.env.PORT || 3000;
const AUTH_FILE = process.env.AUTH_FILE_PATH || './auth_info_multi.json';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ------------------------------------------------------
   Express (page QR)
   ------------------------------------------------------ */
const app = express();
let latestQRCodeDataUrl = null;
let qrLastUpdated = null;
let connectionStatus = 'starting';

app.get('/', (req, res) => {
  if (!latestQRCodeDataUrl) {
    return res.send(`
      <html>
        <head>
          <meta http-equiv="refresh" content="5">
          <title>KAYA-MD — QR</title>
        </head>
        <body style="font-family: Arial, sans-serif; text-align:center; padding:40px">
          <h1>KAYA-MD</h1>
          <h2>Status: ${connectionStatus}</h2>
          <p>En attente du QR… cette page se rafraîchit toutes les 5s.</p>
          <p>Si rien n'apparaît, regarde les logs (Render / console) pour voir les erreurs.</p>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head>
        <title>KAYA-MD — QR</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: Arial, sans-serif; text-align:center; padding:20px">
        <h1>KAYA-MD</h1>
        <h3>Status: ${connectionStatus}</h3>
        <p>Dernière génération: ${qrLastUpdated}</p>
        <img src="${latestQRCodeDataUrl}" alt="WhatsApp QR Code" style="max-width:90%;height:auto"/>
        <p style="margin-top:12px">Scanne ce QR avec WhatsApp (Menu > Appareils liés > Scanner).</p>
        <p style="font-size:12px; color:#666">NB: Si le QR expire, reviens sur cette page pour voir la nouvelle image.</p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ status: connectionStatus, qrLastUpdated });
});

/* ------------------------------------------------------
   Baileys + Auth
   ------------------------------------------------------ */
const { state, saveState } = useSingleFileAuthState(AUTH_FILE);

let store;
try {
  store = makeInMemoryStore ? makeInMemoryStore({ logger: pino().child({ level: 'silent' }) }) : null;
} catch (e) {
  store = null;
}

async function startSock() {
  try {
    connectionStatus = 'fetching-baileys-version';
    let version = [2, 2204, 13];
    try {
      const fetched = await fetchLatestBaileysVersion();
      if (fetched && Array.isArray(fetched.version)) version = fetched.version;
      logger.info('Baileys version fetched', { version });
    } catch (err) {
      logger.warn('Could not fetch latest baileys version, using fallback.');
    }

    connectionStatus = 'starting-socket';
    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      version
    });

    if (store && store.bind) store.bind(sock.ev);

    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          try {
            latestQRCodeDataUrl = await QRCode.toDataURL(qr);
            qrLastUpdated = new Date().toISOString();
            logger.info('QR généré et exposé via HTTP /');
            connectionStatus = 'qr-generated';
          } catch (qerr) {
            logger.error('Erreur génération QR DataURL:', qerr);
          }
        }

        if (connection) {
          connectionStatus = connection;
          logger.info('connection.update', { connection });

          if (connection === 'open') {
            logger.info('Connection ouverte — authentification réussie');
            latestQRCodeDataUrl = null;
            qrLastUpdated = new Date().toISOString();
          }
        }

        if (lastDisconnect && lastDisconnect.error) {
          const err = lastDisconnect.error;
          logger.warn('lastDisconnect:', err && err.output ? err.output.payload : err);

          const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
          if (code === DisconnectReason.badSession || code === DisconnectReason.loggedOut) {
            logger.warn('Session invalide. Suppression du fichier d\'auth et redémarrage pour re-login.');
            try { fs.unlinkSync(AUTH_FILE); } catch (e) { logger.error('Impossible de supprimer le fichier auth:', e); }
            setTimeout(() => startSock(), 2000);
          } else if (code === DisconnectReason.restartRequired || code === DisconnectReason.connectionClosed) {
            logger.info('Redémarrage du socket...');
            setTimeout(() => startSock(), 2000);
          } else {
            logger.info('Tentative de reconnexion dans 5s...');
            setTimeout(() => startSock(), 5000);
          }
        }
      } catch (e) {
        logger.error('Erreur dans connection.update handler:', e);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages || [];
        for (const msg of messages) {
          if (!msg.message) continue;
          const from = msg.key.remoteJid;
          logger.info('Message reçu', { from, content: Object.keys(msg.message)[0] });
          // exemple de réponse (désactivé par défaut)
          // if (msg.message.conversation) {
          //   await sock.sendMessage(from, { text: 'OK' }, { quoted: msg });
          // }
        }
      } catch (e) {
        logger.error('Erreur messages.upsert:', e);
      }
    });

    return sock;
  } catch (err) {
    logger.error('Erreur startSock:', err);
    setTimeout(() => startSock(), 5000);
  }
}

/* start everything */
(async () => {
  app.listen(PORT, () => {
    logger.info(`HTTP server pour QR en écoute sur le port ${PORT}`);
  });

  await startSock();
})();
