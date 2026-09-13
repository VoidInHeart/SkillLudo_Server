CREATE TABLE IF NOT EXISTS submissions (
  user_id CHAR(36) NOT NULL,
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('COUNTRY', 'FEEDBACK') NOT NULL,
  document JSON NOT NULL,
  status ENUM('PENDING', 'SENT', 'FAILED', 'UNCERTAIN') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id),
  INDEX idx_submissions_created (created_at),
  CONSTRAINT fk_submissions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
