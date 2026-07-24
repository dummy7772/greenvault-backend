-- ============================================================
--  GreenVault — Support Ticket Schema
--  Append to config/schema.sql  OR  run standalone:
--    mysql -u root -p greenvault < config/schema_support.sql
-- ============================================================

USE greenvault;

-- ── support_tickets ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_tickets (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED  NOT NULL,
  subject     VARCHAR(255)  NOT NULL,
  message     TEXT          NOT NULL,
  status      ENUM('open','in_progress','resolved','closed')
                            NOT NULL DEFAULT 'open',
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_ticket_user   (user_id),
  KEY idx_ticket_status (status),
  CONSTRAINT fk_ticket_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── ticket_replies ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_replies (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  ticket_id   INT UNSIGNED  NOT NULL,
  sender_id   INT UNSIGNED  NOT NULL,       -- user_id of whoever sent this reply
  sender_type ENUM('user','admin')
                            NOT NULL DEFAULT 'user',
  message     TEXT          NOT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_reply_ticket (ticket_id),
  CONSTRAINT fk_reply_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_reply_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;