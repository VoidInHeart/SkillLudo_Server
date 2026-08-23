import mysql from 'mysql2/promise';

const database = process.env.SKILLLUDO_DB_NAME ?? 'skill_ludo';
const appUser = process.env.SKILLLUDO_DB_USER ?? 'skillludo_app';
const appPassword = process.env.SKILLLUDO_DB_PASSWORD;
const rootPassword = process.env.MYSQL_ROOT_PASSWORD;

if (!/^[A-Za-z0-9_]+$/.test(database) || !/^[A-Za-z0-9_]+$/.test(appUser)) throw new Error('数据库名和应用账号仅允许字母、数字、下划线');
if (!rootPassword || !appPassword) throw new Error('请设置 MYSQL_ROOT_PASSWORD 和 SKILLLUDO_DB_PASSWORD 后再执行初始化');

const host = process.env.SKILLLUDO_DB_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.SKILLLUDO_DB_PORT ?? '3306', 10);
const root = await mysql.createConnection({ host, port, user: 'root', password: rootPassword, multipleStatements: true });
const quoteIdentifier = (value) => `\`${value}\``;
const quoteUser = (name, hostname) => `\`${name}\`@\`${hostname}\``;
const schema = quoteIdentifier(database);

try {
  await root.query(`CREATE DATABASE IF NOT EXISTS ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const user = quoteUser(appUser, hostname);
    const password = root.escape(appPassword);
    await root.query(`CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${password}`);
    await root.query(`ALTER USER ${user} IDENTIFIED BY ${password}`);
    await root.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.* TO ${user}`);
  }
  await root.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.users (
      id CHAR(36) PRIMARY KEY,
      username VARCHAR(32) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      nickname VARCHAR(20) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS ${schema}.player_profiles (
      user_id CHAR(36) PRIMARY KEY,
      avatar_url VARCHAR(512) NULL,
      total_games INT UNSIGNED NOT NULL DEFAULT 0,
      wins INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_player_profiles_user FOREIGN KEY (user_id) REFERENCES ${schema}.users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS ${schema}.user_sessions (
      token_hash BINARY(32) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_sessions_user (user_id),
      INDEX idx_user_sessions_expiry (expires_at),
      CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES ${schema}.users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS ${schema}.game_records (
      id CHAR(36) PRIMARY KEY,
      room_id CHAR(6) NOT NULL,
      players_json JSON NOT NULL,
      result_json JSON NOT NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_game_records_finished (finished_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.info(`MySQL initialized: ${database}; application user: ${appUser}`);
} finally {
  await root.end();
}
