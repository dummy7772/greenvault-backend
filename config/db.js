// config/db.js
const path  = require('path');
const fs    = require('fs');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306'),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || 'root123',
  database:           process.env.DB_NAME     || 'greenvault',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+00:00',
  // Allow multiple statements so we can run the schema file in one shot
  multipleStatements: true,
});

// ── Notification / Transaction Date & Time fix ───────────────────────────────
//
// ROOT CAUSE of notifications and transaction timestamps showing the wrong
// date/time: `timezone: '+00:00'` above only tells mysql2 what timezone to
// *assume* when it parses DATETIME/TIMESTAMP values coming back from MySQL
// (and how to format JS Date params going in) — it does NOT change what
// timezone the MySQL server session actually uses.
//
// If the MySQL server's session `time_zone` is anything other than UTC
// (e.g. it defaults to SYSTEM, and the host OS is set to IST or another
// non-UTC zone), then:
//   • `CURRENT_TIMESTAMP` / `NOW()` are evaluated in that *session* timezone,
//     not UTC, so the wall-clock value actually written to the DB is offset
//     from real UTC.
//   • TIMESTAMP columns get converted from the stored UTC instant back to
//     that same non-UTC session timezone when read.
// Either way, the string mysql2 receives is NOT actually UTC — but mysql2
// (configured with `timezone: '+00:00'` above) blindly treats it as if it
// were, producing a JS Date that's shifted by the session/UTC offset (e.g.
// exactly +5:30 for IST). That shifted instant is what ends up in every
// `created_at` sent to the app — the notifications list, the transaction
// history list, the home screen's recent-transactions card, all of it —
// which is why the displayed date/time was wrong everywhere at once.
//
// Fix: force every pooled connection's session timezone to UTC so it always
// matches what mysql2 assumes. This makes `NOW()` / `CURRENT_TIMESTAMP`
// evaluate in UTC (so stored values are correct) and makes every value read
// back out consistent with the '+00:00' the driver expects — so the Date
// object (and therefore the ISO-8601 "...Z" string sent to the Flutter app)
// always reflects the true, correct instant.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err) {
      console.error('[db] failed to pin session time_zone to UTC:', err.message);
    }
  });
});

// ── Auto-initialise schema on startup ────────────────────────────────────────

async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');

  if (!fs.existsSync(schemaPath)) {
    console.warn('⚠️   schema.sql not found — skipping auto-init');
    return;
  }

  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const conn = await pool.getConnection();
    try {
      await conn.query(sql);
      console.log('✅  Schema verified / tables created');
    } finally {
      conn.release();
    }
  } catch (err) {
    // Non-fatal: log clearly but let the server start.
    // The first real request that hits the DB will surface the error properly.
    console.error('❌  Schema init failed:', err.message);
    console.error('    → Run manually: mysql -u root -p < config/schema.sql');
  }
}

// Verify connection and auto-init on startup
pool.getConnection()
  .then(async (conn) => {
    console.log('✅  MySQL connected');
    conn.release();
    await initSchema();
  })
  .catch((err) => {
    console.error('❌  MySQL connection failed:', err.message);
    console.error('');
    console.error('    Check your .env file:');
    console.error(`      DB_HOST     = ${process.env.DB_HOST     || 'localhost'}`);
    console.error(`      DB_PORT     = ${process.env.DB_PORT     || '3306'}`);
    console.error(`      DB_USER     = ${process.env.DB_USER     || 'root'}`);
    console.error(`      DB_NAME     = ${process.env.DB_NAME     || 'greenvault'}`);
    console.error('');
    // Exit so the developer sees the error immediately instead of getting
    // cryptic 500s at runtime.
    process.exit(1);
  });

module.exports = pool;