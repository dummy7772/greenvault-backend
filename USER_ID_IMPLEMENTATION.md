# User ID (Member ID) Implementation

## Overview
The GreenVault backend implements a human-readable User ID system in the format **MT1112, MT1113, MT1114...** for newly registered users. This implementation is completely separate from the internal database primary key (`users.id`) and follows these critical requirements:

✅ **Only applies to newly registered users** — existing users are never modified  
✅ **Globally unique** — each ID is used exactly once  
✅ **Never reused** — even if a user is deleted, their ID is never reassigned  
✅ **Auto-increment sequence** — starts at MT1112 and increments by 1  
✅ **Concurrent-safe** — multiple simultaneous registrations never get duplicate IDs  
✅ **Preserves all existing functionality** — internal `users.id` remains unchanged

---

## Database Schema

### 1. Users Table (`users`)
The `users` table has a new column `member_id`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  member_id     VARCHAR(20)      NULL DEFAULT NULL,  -- MT1112, MT1113, ...
  first_name    VARCHAR(60)      NOT NULL,
  -- ... other columns
  
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_id (member_id),
  -- ... other indexes
);
```

**Key Points:**
- `member_id` is **nullable** — existing users have `NULL`, only new registrations get a value
- **Unique index** ensures no duplicates can ever be stored
- Located right after `id` column for visibility
- Separate from `users.id` which continues to be used for all internal operations (foreign keys, JWT tokens, session tracking, etc.)

### 2. Sequence Counter Table (`member_id_sequence`)
A dedicated counter table ensures the sequence is never affected by user deletions or database operations:

```sql
CREATE TABLE IF NOT EXISTS member_id_sequence (
  name        VARCHAR(50)  NOT NULL,
  next_value  INT UNSIGNED NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB;

-- Initial seed: starts at 1112
INSERT INTO member_id_sequence (name, next_value)
SELECT 'user_member_id', 1112
WHERE NOT EXISTS (
  SELECT 1 FROM member_id_sequence WHERE name = 'user_member_id'
);
```

**Key Points:**
- **Independent counter** — not tied to `users.id` AUTO_INCREMENT
- Survives user deletions, registration failures, and database operations
- Seeded with initial value **1112** on first run
- Idempotent INSERT — safe to re-run `schema.sql` without resetting the counter

---

## Implementation Files

### 1. Schema Definition
**File:** `config/schema.sql`

- Defines the `users.member_id` column (with migration fallback in `utils/memberId.js`)
- Creates the `member_id_sequence` table
- Seeds the initial counter value (1112)
- Auto-applied on server startup via `config/db.js`

### 2. Member ID Generator
**File:** `utils/memberId.js`

Contains two key functions:

#### `ensureMemberIdSchema()`
```javascript
// Idempotent migration that adds users.member_id if it doesn't exist
// Safe to call on every startup or before registration
await ensureMemberIdSchema();
```

- Checks if `users.member_id` column exists using `INFORMATION_SCHEMA.COLUMNS`
- If missing, adds the column with `ALTER TABLE` + unique index
- Non-fatal errors — logs but doesn't crash the server
- Called on startup and before each registration as a guard

#### `assignMemberId(userId)`
```javascript
// Atomically assigns the next MT number to a newly created user
const memberId = await assignMemberId(result.insertId);
// Returns: "MT1112", "MT1113", etc.
```

**How it works:**
1. Opens a database transaction with connection pooling
2. Locks the counter row with `SELECT ... FOR UPDATE` (prevents concurrent conflicts)
3. Reads current `next_value` (e.g., 1112)
4. Generates the ID string: `MT${next_value}` → `"MT1112"`
5. Increments the counter: `UPDATE ... SET next_value = next_value + 1`
6. Updates the user's row: `UPDATE users SET member_id = ? WHERE id = ?`
7. Commits the transaction (or rolls back on any error)

**Concurrency Safety:**
- `FOR UPDATE` ensures only one transaction can read/modify the counter at a time
- Other concurrent registrations wait for the lock to be released
- Each registration gets a unique, sequential number even under high load

### 3. Registration Controller
**File:** `controllers/authController.js`

The `register()` function calls `assignMemberId()` immediately after creating the new user:

```javascript
async function register(req, res) {
  await ensureMemberIdSchema();  // Lazy migration guard
  
  // ... validation and duplicate checks ...
  
  // Create the user
  const [result] = await db.execute(
    `INSERT INTO users (first_name, last_name, email, phone, ...) VALUES (?, ?, ?, ?, ...)`,
    [firstName, lastName, email, phone, ...]
  );
  
  // Assign the MT number (only for this brand-new user)
  try {
    user.member_id = await assignMemberId(result.insertId);
  } catch (e) {
    // Non-fatal — logs error but doesn't block registration
    console.error('[register] assignMemberId error:', e.message);
  }
  
  // ... rest of registration flow (token, response) ...
}
```

**Key Points:**
- Called **only once** per user, right after `INSERT INTO users`
- Wrapped in try/catch — errors are logged but don't block account creation
- Never called for existing users — only `result.insertId` (the newly created row)
- Returns the assigned `member_id` in the API response alongside the JWT token

---

## API Response Format

### Registration Success
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": 42,
      "member_id": "MT1112",
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "phone": "9876543210",
      "email_verified": true,
      "phone_verified": true,
      "role": "user",
      "created_at": "2026-07-23T10:30:00.000Z"
    }
  }
}
```

### Login / Profile (`/api/auth/me`)
The `member_id` is also returned in login and profile endpoints:

```javascript
async function me(req, res) {
  const [rows] = await db.execute(
    `SELECT id, member_id, first_name, last_name, email, phone, ...
     FROM users WHERE id = ? LIMIT 1`,
    [req.user.sub]
  );
  
  return ok(res, 'Profile fetched', {
    id: rows[0].id,
    member_id: rows[0].member_id || null,  // null for old users
    // ... other fields
  });
}
```

---

## Migration Strategy

### For Existing Databases
The implementation uses **lazy migration** to avoid disrupting existing deployments:

1. **Schema file** (`schema.sql`) defines `member_id` for fresh installations
2. **Runtime migration** (`ensureMemberIdSchema()`) adds it to existing databases
3. **Non-destructive** — existing users are never touched (their `member_id` stays `NULL`)
4. **Idempotent** — safe to run multiple times

### First Deployment Steps
When deploying this feature to an existing production database:

```bash
# Option 1: Automatic (recommended)
# Just start the server — schema is auto-applied via config/db.js
npm start

# Option 2: Manual (if auto-init is disabled)
mysql -u root -p < config/schema.sql
```

The first new registration after deployment will get `MT1112`, the second `MT1113`, and so on.

### Verification
Check if the feature is active:

```sql
-- Check if column exists
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'member_id';

-- Check the current counter value
SELECT name, next_value FROM member_id_sequence WHERE name = 'user_member_id';

-- Check newly registered users (those with member_id assigned)
SELECT id, member_id, first_name, last_name, email, created_at 
FROM users 
WHERE member_id IS NOT NULL 
ORDER BY id DESC 
LIMIT 10;
```

---

## Testing

### Test New Registration
1. Register a new user via the API
2. Verify the response includes `"member_id": "MT1112"` (or next number)
3. Register another user → should get `"MT1113"`
4. Check the database:
   ```sql
   SELECT id, member_id, first_name, email FROM users ORDER BY id DESC LIMIT 5;
   ```

### Test Existing Users
1. Query an existing user's profile:
   ```bash
   curl -H "Authorization: Bearer <token>" http://localhost:3000/api/auth/me
   ```
2. Response should include `"member_id": null` for users created before this feature

### Test Concurrency
Simulate multiple simultaneous registrations:

```javascript
// Run 10 parallel registrations
const promises = Array.from({ length: 10 }, (_, i) => 
  fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      firstName: `User${i}`,
      lastName: `Test${i}`,
      email: `user${i}@test.com`,
      phone: `98765432${10+i}`,
      password: 'Test@123',
      phoneVerified: true,
      emailVerified: true
    })
  })
);

await Promise.all(promises);
```

Expected result: All 10 users get unique, sequential member IDs with no duplicates.

---

## Rollback / Troubleshooting

### If Something Goes Wrong
The feature can be disabled without data loss:

```sql
-- The member_id column can be dropped (existing users aren't affected)
ALTER TABLE users DROP COLUMN member_id;

-- The counter table can be dropped
DROP TABLE member_id_sequence;
```

All core functionality (login, deposits, withdrawals, plans, etc.) continues to work because they all use `users.id`, not `member_id`.

### If Counter Gets Out of Sync
Manually reset the counter (only do this if certain no registrations are in progress):

```sql
-- Find the highest assigned member_id
SELECT member_id FROM users WHERE member_id IS NOT NULL ORDER BY member_id DESC LIMIT 1;
-- Example result: "MT1234"

-- Set next_value to one more than the highest
UPDATE member_id_sequence 
SET next_value = 1235 
WHERE name = 'user_member_id';
```

### Common Issues

**Issue:** New users not getting member IDs  
**Solution:** Check server logs for `[register] assignMemberId error` and verify the `member_id_sequence` table exists

**Issue:** Duplicate member ID error  
**Solution:** Should never happen due to transaction locking, but if it does, manually increment the counter:
```sql
UPDATE member_id_sequence SET next_value = next_value + 1 WHERE name = 'user_member_id';
```

**Issue:** Old users want member IDs  
**Solution:** This is intentional — the feature is designed to NOT backfill existing users. If required, write a custom migration script (outside the scope of this implementation).

---

## Architecture Decisions

### Why a Separate Sequence Table?
- **Independence:** User deletions don't create gaps in the MT sequence
- **Predictability:** The next MT number is always sequential, regardless of `users.id` gaps
- **Never reused:** Even if a registration transaction rolls back, the counter never goes backward

### Why Not Use `users.id` Directly?
- **Existing users:** Can't retroactively assign MT numbers to users with existing IDs
- **Gaps:** User deletions or failed registrations create gaps in AUTO_INCREMENT
- **Starting point:** Requirement specifies starting at MT1112, not MT1

### Why Transaction + Row Locking?
- **Concurrency:** Multiple simultaneous registrations must never get the same number
- **Atomicity:** Counter increment and user update must succeed or fail together
- **Database-level guarantee:** More reliable than application-level locking

### Why Nullable `member_id`?
- **Backward compatibility:** Existing users have `NULL` — no migration needed
- **Clear distinction:** `NULL` explicitly means "registered before this feature"
- **Non-destructive:** Adding the feature doesn't modify existing rows

---

## Flutter Integration Notes

In your Flutter app's user model:

```dart
class User {
  final int id;
  final String? memberId;  // Nullable — old users don't have it
  final String firstName;
  final String lastName;
  // ... other fields
  
  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      memberId: json['member_id'],  // Can be null
      firstName: json['first_name'],
      // ...
    );
  }
}
```

Display logic:

```dart
// Show member ID if available, otherwise show "N/A" or hide the field
Text(user.memberId ?? 'N/A')

// Or hide the field entirely for old users
if (user.memberId != null)
  Text('Member ID: ${user.memberId}')
```

---

## Summary

✅ **Feature is fully implemented and production-ready**  
✅ **Existing users are unaffected** — their `member_id` stays `NULL`  
✅ **New registrations** automatically get MT1112, MT1113, MT1114...  
✅ **Concurrent-safe** with database-level transaction locking  
✅ **Never reused** — dedicated counter survives all database operations  
✅ **Auto-applied** schema on server startup  
✅ **Non-breaking** — all existing APIs and functionality preserved  

No further code changes are required. The system is ready to use.
