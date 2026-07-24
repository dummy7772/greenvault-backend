# GreenVault — Auth Backend (Node.js + MySQL)

REST API for the **Login** and **Register** screens of the GreenVault Flutter app.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Create the database
```bash
mysql -u root -p < config/schema.sql
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your MySQL credentials and a strong JWT_SECRET
```

### 4. Run
```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

Server starts at `http://localhost:3000`

---

## Project Structure

```
greenvault-backend/
├── config/
│   ├── db.js           ← MySQL connection pool (mysql2/promise)
│   └── schema.sql      ← Run once to create DB + tables
├── controllers/
│   └── authController.js  ← register / login / me logic
├── middleware/
│   └── auth.js         ← JWT Bearer guard
├── routes/
│   └── auth.js         ← Routes + express-validator rules
├── utils/
│   ├── jwt.js          ← signToken / verifyToken helpers
│   └── response.js     ← ok() / fail() envelope helpers
├── .env.example
├── package.json
└── server.js           ← Express app entry point
```

---

## API Reference

Base URL: `http://localhost:3000/api`

---

### POST `/auth/register`

Register a new user. Mirrors `RegisterViewModel` validation rules exactly.

**Request body (JSON)**
```json
{
  "firstName":     "Guru",
  "lastName":      "Dev",
  "email":         "guru@example.com",
  "phone":         "9876543210",
  "password":      "Secret123",
  "confirmPassword": "Secret123",
  "emailVerified": true,
  "phoneVerified": true,
  "referralCode":  "REF001"
}
```

| Field           | Required | Rules |
|-----------------|----------|-------|
| firstName       | ✅       | non-empty |
| lastName        | ✅       | non-empty |
| email           | ✅       | valid email format |
| phone           | ✅       | exactly 10 digits |
| password        | ✅       | ≥ 8 chars, letters + numbers |
| confirmPassword | ✅       | must match password |
| emailVerified   | ✅       | must be `true` |
| phoneVerified   | ✅       | must be `true` |
| referralCode    | ❌       | max 30 chars |

**201 Created**
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "token": "<JWT>",
    "user": {
      "id": 1,
      "first_name": "Guru",
      "last_name": "Dev",
      "email": "guru@example.com",
      "phone": "9876543210",
      "email_verified": 1,
      "phone_verified": 1,
      "created_at": "2026-06-18T..."
    }
  }
}
```

**Error responses**
| Status | Reason |
|--------|--------|
| 409    | Email or phone already registered |
| 422    | Validation errors (array in `errors` field) |
| 429    | Rate limit (10 req / 15 min) |
| 500    | Server error |

---

### POST `/auth/login`

Login with **email OR 10-digit mobile number**. Mirrors `LoginViewModel`.

**Request body (JSON)**
```json
{
  "identifier": "guru@example.com",
  "password":   "Secret123"
}
```
`identifier` can be an email address **or** a 10-digit phone number.

**200 OK**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "<JWT>",
    "user": { ... }
  }
}
```

**Error responses**
| Status | Reason |
|--------|--------|
| 401    | Invalid credentials |
| 403    | Account deactivated |
| 422    | Validation errors |
| 429    | Rate limit |

---

### GET `/auth/me`  *(protected)*

Returns the logged-in user's profile. Requires `Authorization: Bearer <token>` header.

**200 OK**
```json
{
  "success": true,
  "message": "Profile fetched",
  "data": {
    "id": 1,
    "first_name": "Guru",
    "last_name": "Dev",
    "email": "guru@example.com",
    "phone": "9876543210",
    "email_verified": 1,
    "phone_verified": 1,
    "created_at": "..."
  }
}
```

---

## Flutter Integration

In your `LoginViewModel` and `RegisterViewModel`, replace the `Future.delayed` mock with real Dio calls:

```dart
// LoginViewModel.login()
final response = await _dio.post(
  '/api/auth/login',
  data: {'identifier': identifier, 'password': password},
);
final token = response.data['data']['token'];
// Store token in SharedPreferences / secure storage

// RegisterViewModel.signUp()
final response = await _dio.post(
  '/api/auth/register',
  data: {
    'firstName':      firstName,
    'lastName':       lastName,
    'email':          email,
    'phone':          phone,
    'password':       password,
    'confirmPassword': confirm,
    'emailVerified':  emailVerified,
    'phoneVerified':  phoneVerified,
    'referralCode':   referral,
  },
);
```

---

## Security Notes

- Passwords are hashed with **bcrypt** (12 rounds by default).
- JWTs are signed with `HS256` — set a strong `JWT_SECRET` in `.env`.
- Auth endpoints are rate-limited to **10 requests / 15 minutes** per IP.
- Error messages on login are intentionally generic (no account-enumeration leaks).
- Never commit your `.env` file — add it to `.gitignore`.
