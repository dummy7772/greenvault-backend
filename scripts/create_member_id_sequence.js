// scripts/create_member_id_sequence.js
//
// One-off fix for deployments where `users.member_id` already exists
// (added by utils/memberId.js's own inline ALTER TABLE) but the
// `member_id_sequence` counter table was never created — because that
// table only lives in config/schema.sql, and this environment's copy of
// schema.sql predates the member_id feature (or never got the chance to
// run that section).
//
// Safe to run any number of times:
//   • CREATE TABLE IF NOT EXISTS — never touches the table if it exists.
//   • The seed INSERT only runs if the 'user_member_id' row is missing.
//   • Does not touch the `users` table at all — no existing user's
//     member_id, id, or any other column is modified.
//
// Run with:  node scripts/create_member_id_sequence.js

require('dotenv').config();
const db = require('../config/db');

const SEQUENCE_NAME = 'user_member_id';
const START_VALUE = 1112; // first assigned member_id will be MT1112

async function run() {
  console.log('🔧 Creating/verifying member_id_sequence table...\n');

  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS member_id_sequence (
        name        VARCHAR(50)  NOT NULL,
        next_value  INT UNSIGNED NOT NULL,

        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ member_id_sequence table exists (created if it was missing).');

    const [existing] = await db.execute(
      'SELECT next_value FROM member_id_sequence WHERE name = ? LIMIT 1',
      [SEQUENCE_NAME]
    );

    if (existing.length > 0) {
      console.log(
        `ℹ️  Seed row already present — next member ID will be MT${existing[0].next_value}. Nothing changed.`
      );
    } else {
      await db.execute(
        'INSERT INTO member_id_sequence (name, next_value) VALUES (?, ?)',
        [SEQUENCE_NAME, START_VALUE]
      );
      console.log(
        `✅ Seeded sequence '${SEQUENCE_NAME}' starting at ${START_VALUE}.`
      );
      console.log(`✅ Next registered user will become MT${START_VALUE}.`);
    }

    // Sanity check: how many existing users already have a member_id vs not.
    const [stats] = await db.execute(`
      SELECT
        COUNT(*) AS total_users,
        COUNT(member_id) AS users_with_member_id,
        COUNT(*) - COUNT(member_id) AS users_without_member_id
      FROM users
    `);
    console.log('\n📊 Current users table:');
    console.log(`   Total users:            ${stats[0].total_users}`);
    console.log(`   With member_id:         ${stats[0].users_with_member_id}`);
    console.log(`   Without member_id:      ${stats[0].users_without_member_id} (unchanged — as expected)`);

    console.log('\n🎉 Done. New registrations from now on will receive MT#### member IDs.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

run();
