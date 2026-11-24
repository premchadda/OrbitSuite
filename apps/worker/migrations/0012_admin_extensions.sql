-- Opt-in administration, lightweight role/plan registry and anti-spam.
-- No session credentials, payments or media bytes are stored here.
CREATE TABLE IF NOT EXISTS admin_feature_flags (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
INSERT OR IGNORE INTO admin_feature_flags(name,enabled) VALUES
 ('moderation',0),('antiflood',0),('member_gate',0),('roles',0),
 ('plans',0),('dashboard',0);
CREATE TABLE IF NOT EXISTS admin_moderation_chats (
  chat TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  flood_limit INTEGER NOT NULL DEFAULT 5,
  flood_window INTEGER NOT NULL DEFAULT 30
);
CREATE TABLE IF NOT EXISTS admin_blocked_terms (
  id INTEGER PRIMARY KEY,
  chat TEXT NOT NULL,
  term TEXT NOT NULL COLLATE NOCASE,
  UNIQUE(chat,term)
);
CREATE INDEX IF NOT EXISTS admin_terms_chat ON admin_blocked_terms(chat);
CREATE TABLE IF NOT EXISTS admin_moderation_seen (
  chat TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  handled_at INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  PRIMARY KEY(chat,message_id)
);
CREATE TABLE IF NOT EXISTS admin_antiflood (
  chat TEXT NOT NULL,
  user_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  messages INTEGER NOT NULL,
  PRIMARY KEY(chat,user_id)
);
CREATE TABLE IF NOT EXISTS admin_roles (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('moderator','viewer','disabled')),
  assigned_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_quotas (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  daily_limit INTEGER NOT NULL CHECK(daily_limit BETWEEN 0 AND 5000),
  PRIMARY KEY(user_id,action)
);
CREATE TABLE IF NOT EXISTS admin_quota_usage (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,action,day)
);
CREATE TABLE IF NOT EXISTS admin_required_chats (
  chat TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS admin_plans (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  price_minor INTEGER NOT NULL CHECK(price_minor >= 0),
  currency TEXT NOT NULL CHECK(currency IN ('INR','USD','XTR')),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_id INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_recent ON admin_audit(at DESC,id DESC);
