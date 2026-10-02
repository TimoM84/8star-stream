"use strict";
// SQLite database (built into Node, one file in the data volume). The schema
// is created and migrated on start-up; every table that belongs to a reseller
// environment carries tenant_id so data can be scoped per environment.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA_VERSION = 1;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "stream.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version < 1) {
    db.exec(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('platform','reseller')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','archived')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL CHECK (role IN ('admin','technician','content')),
        password TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login TEXT
      );
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        account_manager_name TEXT NOT NULL DEFAULT '',
        account_manager_email TEXT NOT NULL DEFAULT '',
        branding TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        function TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'nl'
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        customer_id TEXT REFERENCES customers(id),
        slug TEXT NOT NULL UNIQUE,
        reference TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','test','scheduled','archived')),
        access TEXT NOT NULL DEFAULT 'public' CHECK (access IN ('public','code','registration')),
        access_code TEXT NOT NULL DEFAULT '',
        chat_url TEXT NOT NULL DEFAULT '',
        branding TEXT NOT NULL DEFAULT '{}',
        modules TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        room TEXT NOT NULL DEFAULT '',
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        phase_override TEXT CHECK (phase_override IN ('pre','live','after','vod')),
        sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE languages (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        UNIQUE (event_id, code)
      );
      -- Per session and language: active route, media per phase, VOD.
      CREATE TABLE variants (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
        active_slot TEXT NOT NULL DEFAULT 'primary' CHECK (active_slot IN ('primary','backup')),
        pre_media TEXT NOT NULL DEFAULT '{}',
        after_media TEXT NOT NULL DEFAULT '{}',
        vod TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, language_id)
      );
      CREATE TABLE routes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
        slot TEXT NOT NULL CHECK (slot IN ('primary','backup')),
        provider TEXT NOT NULL DEFAULT 'hls',
        config TEXT NOT NULL DEFAULT '{}',
        bitrate_kbps INTEGER NOT NULL DEFAULT 3000,
        signal TEXT NOT NULL DEFAULT 'unknown',
        signal_detail TEXT NOT NULL DEFAULT '',
        signal_checked_at TEXT,
        signal_changed_at TEXT,
        UNIQUE (session_id, language_id, slot)
      );
      CREATE TABLE route_switches (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        language_id TEXT NOT NULL,
        from_slot TEXT NOT NULL,
        to_slot TEXT NOT NULL,
        reason TEXT NOT NULL,
        user_id TEXT,
        user_email TEXT NOT NULL,
        at TEXT NOT NULL
      );
      -- Watch page content per phase and language: draft and published.
      CREATE TABLE pages (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN ('pre','live','after','vod')),
        language_id TEXT NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
        draft_html TEXT NOT NULL DEFAULT '',
        published_html TEXT NOT NULL DEFAULT '',
        draft_at TEXT,
        draft_by TEXT,
        published_at TEXT,
        published_by TEXT,
        PRIMARY KEY (event_id, phase, language_id)
      );
      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id),
        name TEXT NOT NULL,
        html TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        file TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE forms (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'collect' CHECK (mode IN ('collect','access','approval')),
        fields TEXT NOT NULL DEFAULT '[]',
        texts TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT
      );
      CREATE TABLE registrations (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        session_id TEXT,
        language TEXT NOT NULL DEFAULT '',
        form_version INTEGER NOT NULL,
        fields TEXT NOT NULL,
        answers TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('received','pending','approved','rejected')),
        consent TEXT NOT NULL DEFAULT '[]',
        access_token TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX registrations_event ON registrations(event_id, created_at);
      -- One row per route and minute in which a signal was received.
      CREATE TABLE usage_minutes (
        route_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        language_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('live','test')),
        minute TEXT NOT NULL,
        viewers INTEGER NOT NULL DEFAULT 0,
        gb_estimate REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (route_id, minute)
      );
      CREATE INDEX usage_event ON usage_minutes(event_id, minute);
      CREATE TABLE viewer_stats (
        event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        language_id TEXT NOT NULL,
        peak INTEGER NOT NULL DEFAULT 0,
        peak_at TEXT,
        plays INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_id, session_id, language_id)
      );
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT,
        user_id TEXT,
        user_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '{}',
        result TEXT NOT NULL DEFAULT 'ok',
        at TEXT NOT NULL
      );
      CREATE INDEX audit_tenant ON audit(tenant_id, at);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.exec("PRAGMA user_version = " + SCHEMA_VERSION);
  }
  return db;
}

// Runs fn inside a transaction; rolls back on error.
function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = { open, tx };
