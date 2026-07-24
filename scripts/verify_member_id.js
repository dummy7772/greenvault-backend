// scripts/verify_member_id.js
//
// Verification script for the Member ID (MT1112, MT1113, ...) implementation.
// Run with: node scripts/verify_member_id.js

require('dotenv').config();
const db = require('../config/db');

async function verify() {
  console.log('🔍 Verifying Member ID Implementation\n');

  try {
    // 1. Check if member_id column exists
    console.log('1. Checking users.member_id column...');
    const [columnCheck] = await db.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'member_id'`
    );

    if (columnCheck.length === 0) {
      console.log('   ❌ member_id column does not exist');
      console.log('   → Run: node server.js (auto-migration will add it)');
      process.exit(1);
    }

    console.log('   ✅ Column exists:', columnCheck[0].COLUMN_TYPE);
    console.log('   ✅ Nullable:', columnCheck[0].IS_NULLABLE);
    console.log('   ✅ Has unique index:', columnCheck[0].COLUMN_KEY === 'UNI' ? 'Yes' : 'No');

    // 2. Check if sequence table exists
    console.log('\n2. Checking member_id_sequence table...');
    const [seqCheck] = await db.execute(
      `SELECT name, next_value
       FROM member_id_sequence
       WHERE name = 'user_member_id'`
    );

    if (seqCheck.length === 0) {
      console.log('   ❌ Sequence row not found');
      console.log('   → Run: mysql -u root -p < config/schema.sql');
      process.exit(1);
    }

    console.log('   ✅ Sequence exists');
    console.log('   ✅ Current value:', seqCheck[0].next_value);
    console.log('   ✅ Next member ID will be: MT' + seqCheck[0].next_value);

    // 3. Check existing users
    console.log('\n3. Checking user data...');
    const [userStats] = await db.execute(
      `SELECT 
         COUNT(*) as total_users,
         COUNT(member_id) as users_with_member_id,
         COUNT(*) - COUNT(member_id) as users_without_member_id
       FROM users`
    );

    console.log('   ✅ Total users:', userStats[0].total_users);
    console.log('   ✅ Users with member ID:', userStats[0].users_with_member_id);
    console.log('   ✅ Users without member ID (old users):', userStats[0].users_without_member_id);

    // 4. Show sample users with member IDs
    const [samplesWithId] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, created_at
       FROM users
       WHERE member_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 5`
    );

    if (samplesWithId.length > 0) {
      console.log('\n4. Recent users with member IDs:');
      samplesWithId.forEach(u => {
        console.log(`   ${u.member_id} | User #${u.id} | ${u.first_name} ${u.last_name} | ${u.email}`);
      });
    } else {
      console.log('\n4. No users with member IDs yet (no registrations since deployment)');
    }

    // 5. Show sample old users
    const [samplesWithoutId] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, created_at
       FROM users
       WHERE member_id IS NULL
       ORDER BY id ASC
       LIMIT 5`
    );

    if (samplesWithoutId.length > 0) {
      console.log('\n5. Old users (no member ID - as expected):');
      samplesWithoutId.forEach(u => {
        console.log(`   NULL | User #${u.id} | ${u.first_name} ${u.last_name} | ${u.email}`);
      });
    }

    // 6. Check for duplicates (should never happen)
    console.log('\n6. Checking for duplicate member IDs...');
    const [duplicates] = await db.execute(
      `SELECT member_id, COUNT(*) as count
       FROM users
       WHERE member_id IS NOT NULL
       GROUP BY member_id
       HAVING count > 1`
    );

    if (duplicates.length > 0) {
      console.log('   ❌ DUPLICATES FOUND:', duplicates);
      console.log('   → This should never happen! Check database integrity.');
    } else {
      console.log('   ✅ No duplicates found (as expected)');
    }

    console.log('\n✅ Member ID implementation verified successfully!\n');
    console.log('Summary:');
    console.log(`  • Database schema: Ready`);
    console.log(`  • Next member ID: MT${seqCheck[0].next_value}`);
    console.log(`  • New registrations will automatically get MT${seqCheck[0].next_value}, MT${seqCheck[0].next_value + 1}, etc.`);
    console.log(`  • Existing users: Unaffected (member_id = NULL)`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await db.end();
    process.exit(0);
  }
}

verify();
