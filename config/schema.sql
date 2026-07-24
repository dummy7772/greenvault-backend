-- ============================================================
--  GreenVault Database Schema
--  Run once:  mysql -u root -p < config/schema.sql
--  Safe to re-run — all statements are idempotent.
-- ============================================================

CREATE DATABASE IF NOT EXISTS greenvault
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE greenvault;

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  -- Human-readable member ID assigned only to newly registered users.
  -- Format: MT1112, MT1113, MT1114, ... backed by member_id_sequence.
  -- NULL for users who registered before this feature was introduced;
  -- they are never backfilled. ensureMemberIdSchema() lazily adds this
  -- column via ALTER TABLE if the DB predates schema.sql being re-run.
  member_id     VARCHAR(20)      NULL DEFAULT NULL,
  first_name    VARCHAR(60)      NOT NULL,
  last_name     VARCHAR(60)      NOT NULL,
  email         VARCHAR(191)     NOT NULL,
  phone         CHAR(10)         NOT NULL,
  password_hash VARCHAR(255)     NOT NULL,
  referral_code VARCHAR(30)      DEFAULT NULL,
  email_verified TINYINT(1)      NOT NULL DEFAULT 0,
  phone_verified TINYINT(1)      NOT NULL DEFAULT 0,
  is_active      TINYINT(1)      NOT NULL DEFAULT 1,
  role           ENUM('user','admin') NOT NULL DEFAULT 'user',
  kyc_status     ENUM('not_submitted','pending','approved','rejected')
                                 NOT NULL DEFAULT 'not_submitted',
  balance        DECIMAL(15,2)   NOT NULL DEFAULT 0.00,
  vault_balance  DECIMAL(15,2)   NOT NULL DEFAULT 0.00,

  -- Profile fields
  profile_image  VARCHAR(512)    DEFAULT NULL,
  date_of_birth  DATE            DEFAULT NULL,
  gender         ENUM('male','female','other','prefer_not_to_say') DEFAULT NULL,
  address        TEXT            DEFAULT NULL,

  created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_member_id (member_id),
  UNIQUE KEY uq_email (email),
  UNIQUE KEY uq_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── member_id_sequence ──────────────────────────────────────
-- Backs the human-readable MTxxxx member IDs assigned to newly
-- registered users only (see utils/memberId.js). A dedicated counter
-- table (rather than the users.id AUTO_INCREMENT PK) keeps this
-- sequence independent of the internal primary key, so existing
-- users are never touched and numbers are never reused.
CREATE TABLE IF NOT EXISTS member_id_sequence (
  name        VARCHAR(50)  NOT NULL,
  next_value  INT UNSIGNED NOT NULL,

  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed once: the first newly-registered user becomes MT1112, then
-- MT1113, MT1114, ... This INSERT only ever runs if the row is
-- missing, so re-running this file never resets the counter.
INSERT INTO member_id_sequence (name, next_value)
SELECT 'user_member_id', 1112
WHERE NOT EXISTS (
  SELECT 1 FROM member_id_sequence WHERE name = 'user_member_id'
);

-- ── referral_code_sequence ────────────────────────────────
-- Backs the new MT<seq><FirstInitial><LastInitial> referral codes
-- (e.g. MT001MX) assigned to newly registered users only (see
-- utils/referralCode.js). A dedicated counter table keeps this
-- sequence independent of both users.id and member_id_sequence, so
-- existing users' referral codes (my_referral_code) are never
-- touched and a sequence number is never reused.
CREATE TABLE IF NOT EXISTS referral_code_sequence (
  name        VARCHAR(50)  NOT NULL,
  next_value  INT UNSIGNED NOT NULL,

  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed once: the first newly-registered user's referral code uses
-- sequence 001 (e.g. MT001MX). This INSERT only ever runs if the
-- row is missing, so re-running this file never resets the counter.
INSERT INTO referral_code_sequence (name, next_value)
SELECT 'user_referral_code', 1
WHERE NOT EXISTS (
  SELECT 1 FROM referral_code_sequence WHERE name = 'user_referral_code'
);

-- ── refresh_tokens ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED  NOT NULL,
  token_hash VARCHAR(255)  NOT NULL,
  expires_at TIMESTAMP     NOT NULL,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_user (user_id),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── kyc_submissions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_submissions (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id             INT UNSIGNED  NOT NULL,

  aadhaar_front_path  VARCHAR(512)  NOT NULL,
  aadhaar_back_path   VARCHAR(512)  NOT NULL,
  pan_front_path      VARCHAR(512)  NOT NULL,
  selfie_path         VARCHAR(512)  NOT NULL,

  account_holder_name VARCHAR(120)  NOT NULL,
  account_number      VARCHAR(20)   NOT NULL,
  ifsc_code           CHAR(11)      NOT NULL,
  bank_name           VARCHAR(120)  DEFAULT NULL,
  bank_branch         VARCHAR(120)  DEFAULT NULL,
  bank_city           VARCHAR(80)   DEFAULT NULL,
  bank_state          VARCHAR(80)   DEFAULT NULL,

  status              ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason    TEXT          DEFAULT NULL,
  reviewed_at         TIMESTAMP     NULL DEFAULT NULL,

  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_kyc_user   (user_id),
  KEY idx_kyc_status (status),
  CONSTRAINT fk_kyc_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── deposits ─────────────────────────────────────────────────
-- Business rule: a single deposit can never exceed ₹100,000 (1 Lakh).
-- chk_deposit_amount_max enforces this at the database level for any
-- brand-new install (fresh CREATE TABLE). It is intentionally NOT
-- retro-applied via ALTER TABLE to already-existing `deposits` tables —
-- doing so would validate every historical row and could fail startup
-- if any legacy deposit already exceeds the new cap. The authoritative,
-- always-applied guard for both new and existing databases is the
-- application-level check in controllers/depositController.js
-- (createDeposit), which runs before every INSERT regardless of
-- whether this constraint is present.
CREATE TABLE IF NOT EXISTS deposits (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED    NOT NULL,
  amount           DECIMAL(15,2)   NOT NULL,
  utr_id           VARCHAR(100)    NOT NULL,
  proof_image      VARCHAR(512)    NOT NULL,
  order_status     ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason TEXT            DEFAULT NULL,
  reviewed_at      TIMESTAMP       NULL DEFAULT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_dep_user   (user_id),
  KEY idx_dep_status (order_status),
  CONSTRAINT fk_dep_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_deposit_amount_max CHECK (amount <= 100000.00)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── withdrawals ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED    NOT NULL,
  type             ENUM('wallet','vault') NOT NULL,
  amount           DECIMAL(15,2)   NOT NULL,
  reference_id     VARCHAR(40)     DEFAULT NULL,

  -- Bank details snapshotted from KYC at the time of the request
  account_holder_name VARCHAR(120) DEFAULT NULL,
  account_number      VARCHAR(20)  DEFAULT NULL,
  ifsc_code           CHAR(11)     DEFAULT NULL,
  bank_name            VARCHAR(120) DEFAULT NULL,

  status           ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_remarks    TEXT            DEFAULT NULL,
  reviewed_at      TIMESTAMP       NULL DEFAULT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_wd_user   (user_id),
  KEY idx_wd_status (status),
  KEY idx_wd_type   (type),
  CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;