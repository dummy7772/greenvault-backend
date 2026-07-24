// config/firebase.js
//
// Lazily initializes the Firebase Admin SDK for sending FCM push
// notifications. Configured via ONE of the following env vars (checked in
// this order):
//   - FIREBASE_SERVICE_ACCOUNT_BASE64  base64-encoded service account JSON
//                                       (preferred on hosts like Railway —
//                                       avoids multiline/quote-escaping
//                                       issues that raw JSON env vars hit)
//   - FIREBASE_SERVICE_ACCOUNT_JSON    raw service account JSON string
//   - FIREBASE_SERVICE_ACCOUNT_PATH    path to a service account JSON file
//
// If none are set, push sending is silently disabled — every existing
// feature (notifications table, in-app notification list, etc.) keeps
// working exactly as before, since FCM is purely additive. A single
// warning is logged once at startup so a missing config is easy to spot.
const admin = require('firebase-admin');

let _initTried = false;
let _app = null;
let _messaging = null;

function initFirebase() {
  if (_initTried) return _app;
  _initTried = true;

  try {
    let credentialJson = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      credentialJson = Buffer
        .from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64')
        .toString('utf8');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      credentialJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const fs = require('fs');
      credentialJson = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8');
    }

    if (!credentialJson) {
      console.warn('[firebase] No FIREBASE_SERVICE_ACCOUNT_* env var set — push notifications are disabled.');
      return null;
    }

    const serviceAccount = JSON.parse(credentialJson);
    _app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    _messaging = admin.messaging();
    console.log('[firebase] Admin SDK initialized — push notifications enabled.');
  } catch (err) {
    console.error('[firebase] Failed to initialize Admin SDK — push notifications disabled:', err.message);
    _app = null;
    _messaging = null;
  }

  return _app;
}

/** Returns the Messaging instance, or null if FCM isn't configured. */
function getMessaging() {
  if (!_initTried) initFirebase();
  return _messaging;
}

module.exports = { initFirebase, getMessaging };