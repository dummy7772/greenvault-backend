-- ============================================================
--  GreenVault — Investment Plans Schema (additive migration)
--  Run:  mysql -u root -p greenvault < config/schema_plans.sql
-- ============================================================

USE greenvault;

-- ── investment_plans ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investment_plans (
  id                INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  user_id           INT UNSIGNED     NOT NULL,
  plan_type         ENUM('3_month','6_month','12_month') NOT NULL,
  monthly_amount    DECIMAL(15,2)    NOT NULL,
  months_paid       INT UNSIGNED     NOT NULL DEFAULT 0,
  start_date        DATE             DEFAULT NULL,
  maturity_date     DATE             DEFAULT NULL,
  last_payment_date DATE             DEFAULT NULL,
  accrued_roi       DECIMAL(15,4)    NOT NULL DEFAULT 0.0000,
  withdrawn_roi     DECIMAL(15,4)    NOT NULL DEFAULT 0.0000,
  plan_amount       DECIMAL(15,2)    NOT NULL DEFAULT 0.00,
  status            ENUM('under_review','approved','active','completed','rejected')
                                     NOT NULL DEFAULT 'under_review',
  rejection_reason  TEXT             DEFAULT NULL,
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_plan_user   (user_id),
  KEY idx_plan_status (status),
  CONSTRAINT fk_plan_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── plan_instalments ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plan_instalments (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  plan_id     INT UNSIGNED  NOT NULL,
  user_id     INT UNSIGNED  NOT NULL,
  month_number INT UNSIGNED NOT NULL,
  amount      DECIMAL(15,2) NOT NULL,
  utr_id      VARCHAR(100)  NOT NULL,
  proof_image VARCHAR(512)  DEFAULT NULL,
  is_paid     TINYINT(1)    NOT NULL DEFAULT 0,
  paid_at     TIMESTAMP     NULL DEFAULT NULL,
  status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_note  TEXT          DEFAULT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_inst_plan (plan_id),
  KEY idx_inst_user (user_id),
  CONSTRAINT fk_inst_plan FOREIGN KEY (plan_id) REFERENCES investment_plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_inst_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;