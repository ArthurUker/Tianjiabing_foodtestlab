-- Auto-generated SQL to create/update default admin password (hash only)
-- Date: 2026-05-20
-- NOTE: 明文密码不会写入仓库。明文凭证已通过会话单次展示给操作者。

BEGIN;
INSERT INTO users (username, email, password_hash, full_name, role, status, created_at)
VALUES (
  'admin',
  'admin@foodlab.local',
  '$2a$10$/5nPawOe9ggUfJwXgJC1aeHYAXhDGws7M/rzZpx8tRkcUlJ82ieeC',
  'Administrator',
  'admin',
  'active',
  now()
)
ON CONFLICT (username) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      updated_at = now();

COMMIT;
