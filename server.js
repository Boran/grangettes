const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || process.env.IP || "::";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD_HASH =
  "scrypt$4e4856adb4313849db418589202ff8be$c480266124b794927c767d57931a184bd798fbbdf142b4b87e82cc6a3f397775bb37f2a9209e3953c67edda5f1ce0724b2142298e55a31b2face0e2dea9be2c3";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_PASSWORD_HASH;
const ADMIN_SESSION_COOKIE_NAME = "grangettes_admin_session";
const MEMBER_SESSION_COOKIE_NAME = "grangettes_member_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const SLOT_KEYS = ["morning", "afternoon"];
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SEED_DATA_FILE = path.join(DATA_DIR, "schedule.json");
const LEGACY_RUNTIME_DATA_FILE = path.join(DATA_DIR, "schedule.local.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const DB_FILE = path.join(DATA_DIR, "grangettes.sqlite");

let db = null;

function safeReadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function createSeedData() {
  const members = [
    { id: "sean", name: "Sean" },
    { id: "martine", name: "Martine" },
    { id: "bob", name: "Bob" },
    { id: "camille", name: "Camille" },
    { id: "daniel", name: "Daniel" },
    { id: "emma", name: "Emma" },
    { id: "felix", name: "Felix" },
    { id: "jim", name: "Jim" },
    { id: "julie", name: "Julie" },
    { id: "leo", name: "Leo" },
    { id: "nina", name: "Nina" }
  ];

  const days = buildUpcomingClubDays(new Date(), 12);
  const assignments = {};

  days.forEach((day) => {
    assignments[day] = {
      morning: null,
      afternoon: null,
      comment: ""
    };
  });

  return {
    clubName: "Club des Grangettes",
    slots: SLOT_KEYS,
    members,
    days,
    assignments
  };
}

function createDefaultConfig() {
  return {
    title: "Tableau des permanences Grangettes"
  };
}

function ensureSeedFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(SEED_DATA_FILE)) {
    writeJson(SEED_DATA_FILE, createSeedData());
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    writeJson(CONFIG_FILE, createDefaultConfig());
  }
}

function loadLegacyScheduleSource() {
  const candidateFiles = [LEGACY_RUNTIME_DATA_FILE, SEED_DATA_FILE];

  for (const filePath of candidateFiles) {
    try {
      return safeReadJson(filePath);
    } catch (_error) {
      // Try next file.
    }
  }

  return createSeedData();
}

function loadLegacyConfig() {
  try {
    return {
      ...createDefaultConfig(),
      ...safeReadJson(CONFIG_FILE)
    };
  } catch (_error) {
    return createDefaultConfig();
  }
}

function nextMonday(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay();
  const delta = day === 1 ? 0 : (8 - day) % 7;
  result.setDate(result.getDate() + delta);
  return result;
}

function buildUpcomingClubDays(referenceDate, maxDays) {
  const date = new Date(referenceDate);
  date.setHours(0, 0, 0, 0);
  const results = [];
  const allowedWeekdays = new Set([5, 6, 0]);

  while (results.length < maxDays) {
    if (allowedWeekdays.has(date.getDay())) {
      results.push(formatDateKey(date));
    }
    date.setDate(date.getDate() + 1);
  }

  return results;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function slugifyMemberName(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "membre";
}

function normalizeMembers(rawMembers, existingMembers = []) {
  const usedIds = new Set();

  return rawMembers
    .map((value, index) => {
      if (typeof value === "string") {
        return {
          id: existingMembers[index]?.id || "",
          name: value.trim()
        };
      }

      return {
        id: String(value?.id || existingMembers[index]?.id || "").trim(),
        name: String(value?.name || "").trim(),
        active: value?.active !== false
      };
    })
    .filter((member) => member.name)
    .map((member, index) => {
      const baseId = member.id || slugifyMemberName(member.name) || `membre-${index + 1}`;
      let candidateId = baseId;
      let suffix = 2;

      while (usedIds.has(candidateId)) {
        candidateId = `${baseId}-${suffix}`;
        suffix += 1;
      }

      usedIds.add(candidateId);
      return {
        id: candidateId,
        name: member.name,
        active: member.active !== false
      };
    });
}

function normalizeDays(rawDays) {
  const unique = new Set();

  return rawDays
    .map((value) => String(value || "").trim())
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .filter((value) => {
      if (unique.has(value)) {
        return false;
      }
      unique.add(value);
      return true;
    })
    .sort();
}

function ensureAssignmentsForDays(days, existingAssignments = {}) {
  const nextAssignments = {};

  days.forEach((day) => {
    const current = existingAssignments[day] || {};
    nextAssignments[day] = {
      morning: current.morning || null,
      afternoon: current.afternoon || null,
      comment: current.comment || ""
    };
  });

  return nextAssignments;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function encodeSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(secret, salt).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encodedHash) {
  const [algorithm, salt, storedHashHex] = String(encodedHash || "").split("$");

  if (algorithm !== "scrypt" || !salt || !storedHashHex) {
    return false;
  }

  try {
    const storedHash = Buffer.from(storedHashHex, "hex");
    const candidateHash = hashPassword(password, salt);

    if (storedHash.length !== candidateHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(storedHash, candidateHash);
  } catch (_error) {
    return false;
  }
}

function generateAccessCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let index = 0; index < 8; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return code;
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};

  header.split(";").forEach((part) => {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) {
      return;
    }
    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
  });

  return cookies;
}

function appendSetCookie(response, value) {
  const existing = response.getHeader("Set-Cookie");

  if (!existing) {
    response.setHeader("Set-Cookie", value);
    return;
  }

  if (Array.isArray(existing)) {
    response.setHeader("Set-Cookie", [...existing, value]);
    return;
  }

  response.setHeader("Set-Cookie", [existing, value]);
}

function setSessionCookie(response, cookieName, token) {
  appendSetCookie(
    response,
    `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}`
  );
}

function clearSessionCookie(response, cookieName) {
  appendSetCookie(response, `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function getDb() {
  if (db) {
    return db;
  }

  ensureSeedFiles();
  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  return db;
}

function ensureColumn(database, tableName, columnName, definition) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function initializeDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS days (
      day TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      comment TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS assignments (
      day TEXT NOT NULL,
      slot TEXT NOT NULL,
      member_id TEXT,
      PRIMARY KEY (day, slot),
      FOREIGN KEY (day) REFERENCES days(day) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member_sessions (
      token TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT NOT NULL,
      actor_label TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  ensureColumn(database, "members", "access_code_hash", "TEXT");
  ensureColumn(database, "members", "active", "INTEGER NOT NULL DEFAULT 1");

  const schemaVersionRow = database
    .prepare("SELECT value FROM app_meta WHERE key = ?")
    .get("schema_version");

  if (!schemaVersionRow) {
    importLegacyData(database);
    database
      .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
      .run("schema_version", "2");
    return;
  }

  if (Number(schemaVersionRow.value) < 2) {
    database.prepare("UPDATE members SET active = COALESCE(active, 1)").run();
    database
      .prepare("UPDATE members SET access_code_hash = NULL WHERE access_code_hash = ''")
      .run();
    database
      .prepare("UPDATE app_meta SET value = ? WHERE key = ?")
      .run("2", "schema_version");
  }
}

function importLegacyData(database) {
  const config = loadLegacyConfig();
  const schedule = loadLegacyScheduleSource();
  const assignments = ensureAssignmentsForDays(schedule.days || [], schedule.assignments || {});

  const transaction = database.transaction(() => {
    database.exec(`
      DELETE FROM assignments;
      DELETE FROM days;
      DELETE FROM members;
      DELETE FROM app_meta WHERE key != 'schema_version';
      DELETE FROM admin_sessions;
      DELETE FROM member_sessions;
      DELETE FROM audit_log;
    `);

    database
      .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
      .run("title", String(config.title || createDefaultConfig().title));

    const insertMember = database.prepare(
      "INSERT INTO members (id, name, sort_order, active, access_code_hash) VALUES (?, ?, ?, 1, NULL)"
    );
    (schedule.members || []).forEach((member, index) => {
      insertMember.run(member.id, member.name, index);
    });

    const insertDay = database.prepare(
      "INSERT INTO days (day, sort_order, comment) VALUES (?, ?, ?)"
    );
    const insertAssignment = database.prepare(
      "INSERT INTO assignments (day, slot, member_id) VALUES (?, ?, ?)"
    );

    (schedule.days || []).forEach((day, index) => {
      const current = assignments[day] || { morning: null, afternoon: null, comment: "" };
      insertDay.run(day, index, current.comment || "");

      SLOT_KEYS.forEach((slot) => {
        insertAssignment.run(day, slot, current[slot] || null);
      });
    });
  });

  transaction();
}

function logAudit(actorType, actorLabel, action, details) {
  getDb()
    .prepare(
      "INSERT INTO audit_log (actor_type, actor_label, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(actorType, actorLabel, action, JSON.stringify(details || {}), Date.now());
}

function loadConfig() {
  const titleRow = getDb().prepare("SELECT value FROM app_meta WHERE key = ?").get("title");

  return {
    title: titleRow?.value || createDefaultConfig().title
  };
}

function loadSchedule() {
  const database = getDb();
  const members = database
    .prepare(
      "SELECT id, name, active, access_code_hash IS NOT NULL AS hasAccessCode FROM members ORDER BY sort_order ASC, name ASC"
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      active: Boolean(row.active),
      hasAccessCode: Boolean(row.hasAccessCode)
    }));
  const dayRows = database
    .prepare("SELECT day, comment FROM days ORDER BY sort_order ASC, day ASC")
    .all();
  const assignmentRows = database
    .prepare("SELECT day, slot, member_id FROM assignments")
    .all();

  const assignments = {};
  dayRows.forEach((row) => {
    assignments[row.day] = {
      morning: null,
      afternoon: null,
      comment: row.comment || ""
    };
  });

  assignmentRows.forEach((row) => {
    assignments[row.day] = assignments[row.day] || {
      morning: null,
      afternoon: null,
      comment: ""
    };
    assignments[row.day][row.slot] = row.member_id || null;
  });

  return {
    clubName: "Club des Grangettes",
    slots: SLOT_KEYS,
    members,
    days: dayRows.map((row) => row.day),
    assignments
  };
}

function loadAuditLog(limit = 100) {
  return getDb()
    .prepare(
      "SELECT id, actor_type, actor_label, action, details_json, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit)
    .map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorLabel: row.actor_label,
      action: row.action,
      details: JSON.parse(row.details_json),
      createdAt: row.created_at
    }));
}

function cleanupSessions() {
  const now = Date.now();
  const database = getDb();
  database.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
  database.prepare("DELETE FROM member_sessions WHERE expires_at <= ?").run(now);
}

function createAdminSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  getDb()
    .prepare("INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)")
    .run(token, username, Date.now() + SESSION_TTL_MS);
  return token;
}

function createMemberSession(memberId) {
  const token = crypto.randomBytes(24).toString("hex");
  getDb()
    .prepare("INSERT INTO member_sessions (token, member_id, expires_at) VALUES (?, ?, ?)")
    .run(token, memberId, Date.now() + SESSION_TTL_MS);
  return token;
}

function getAdminSession(request) {
  cleanupSessions();
  const token = parseCookies(request)[ADMIN_SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const session = getDb()
    .prepare("SELECT token, username, expires_at FROM admin_sessions WHERE token = ?")
    .get(token);

  if (!session || session.expires_at <= Date.now()) {
    getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
    return null;
  }

  getDb()
    .prepare("UPDATE admin_sessions SET expires_at = ? WHERE token = ?")
    .run(Date.now() + SESSION_TTL_MS, token);

  return {
    token: session.token,
    username: session.username
  };
}

function getMemberSession(request) {
  cleanupSessions();
  const token = parseCookies(request)[MEMBER_SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const session = getDb()
    .prepare(
      `SELECT ms.token, ms.member_id, ms.expires_at, m.name, m.active
       FROM member_sessions ms
       JOIN members m ON m.id = ms.member_id
       WHERE ms.token = ?`
    )
    .get(token);

  if (!session || !session.active || session.expires_at <= Date.now()) {
    getDb().prepare("DELETE FROM member_sessions WHERE token = ?").run(token);
    return null;
  }

  getDb()
    .prepare("UPDATE member_sessions SET expires_at = ? WHERE token = ?")
    .run(Date.now() + SESSION_TTL_MS, token);

  return {
    token: session.token,
    memberId: session.member_id,
    memberName: session.name
  };
}

function deleteAdminSession(token) {
  getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}

function deleteMemberSession(token) {
  getDb().prepare("DELETE FROM member_sessions WHERE token = ?").run(token);
}

function requireAdmin(request, response) {
  const session = getAdminSession(request);

  if (session) {
    return session;
  }

  response.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: "Authentification administrateur requise" }));
  return null;
}

function requireMemberOrAdmin(request, response) {
  const memberSession = getMemberSession(request);
  if (memberSession) {
    return {
      role: "member",
      session: memberSession
    };
  }

  const adminSession = getAdminSession(request);
  if (adminSession) {
    return {
      role: "admin",
      session: adminSession
    };
  }

  response.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: "Connexion membre ou admin requise" }));
  return null;
}

function updateAssignment(actor, requestedMemberId, day, slot) {
  const database = getDb();
  const dayExists = database.prepare("SELECT 1 FROM days WHERE day = ?").get(day);

  if (!dayExists || !SLOT_KEYS.includes(slot)) {
    throw new Error("Mise a jour du creneau invalide");
  }

  const targetMemberId = actor.role === "member" ? actor.session.memberId : requestedMemberId;
  const memberExists = database
    .prepare("SELECT id, name FROM members WHERE id = ? AND active = 1")
    .get(targetMemberId);

  if (!memberExists) {
    throw new Error("Membre invalide");
  }

  const current = database
    .prepare(
      `SELECT a.member_id, m.name AS member_name
       FROM assignments a
       LEFT JOIN members m ON m.id = a.member_id
       WHERE a.day = ? AND a.slot = ?`
    )
    .get(day, slot);

  if (actor.role === "member" && current?.member_id && current.member_id !== actor.session.memberId) {
    throw new Error("Ce creneau est deja attribue");
  }

  const nextOwner = current?.member_id === targetMemberId ? null : targetMemberId;
  database
    .prepare(
      "INSERT INTO assignments (day, slot, member_id) VALUES (?, ?, ?) ON CONFLICT(day, slot) DO UPDATE SET member_id = excluded.member_id"
    )
    .run(day, slot, nextOwner);

  logAudit(
    actor.role,
    actor.role === "member" ? actor.session.memberName : actor.session.username,
    nextOwner ? "assignment_set" : "assignment_cleared",
    {
      day,
      slot,
      memberId: targetMemberId,
      previousMemberId: current?.member_id || null,
      newMemberId: nextOwner
    }
  );
}

function updateComment(actor, day, comment) {
  const result = getDb()
    .prepare("UPDATE days SET comment = ? WHERE day = ?")
    .run(String(comment || "").slice(0, 280), day);

  if (result.changes === 0) {
    throw new Error("Mise a jour du commentaire invalide");
  }

  logAudit(
    actor.role,
    actor.role === "member" ? actor.session.memberName : actor.session.username,
    "comment_updated",
    {
      day
    }
  );
}

function getAllMembers() {
  return getDb()
    .prepare(
      "SELECT id, name, active, access_code_hash IS NOT NULL AS hasAccessCode FROM members ORDER BY sort_order ASC, name ASC"
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      active: Boolean(row.active),
      hasAccessCode: Boolean(row.hasAccessCode)
    }));
}

function createMember(name) {
  const existingMembers = getAllMembers();
  const normalized = normalizeMembers(
    [{ name, active: true }],
    [{ id: "", name: "" }]
  )[0];

  if (!normalized) {
    throw new Error("Nom de membre invalide");
  }

  let candidateId = normalized.id;
  let suffix = 2;
  const usedIds = new Set(existingMembers.map((member) => member.id));
  while (usedIds.has(candidateId)) {
    candidateId = `${normalized.id}-${suffix}`;
    suffix += 1;
  }

  const accessCode = generateAccessCode();
  const sortOrderRow = getDb().prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM members").get();
  getDb()
    .prepare(
      "INSERT INTO members (id, name, sort_order, access_code_hash, active) VALUES (?, ?, ?, ?, 1)"
    )
    .run(candidateId, name.trim(), Number(sortOrderRow.max_sort) + 1, encodeSecret(accessCode));

  logAudit("admin", ADMIN_USERNAME, "member_created", {
    memberId: candidateId,
    name: name.trim()
  });

  return {
    member: {
      id: candidateId,
      name: name.trim(),
      active: true,
      hasAccessCode: true
    },
    accessCode
  };
}

function updateMember(memberId, payload) {
  const name = String(payload.name || "").trim();
  const active = payload.active !== false;

  if (!name) {
    throw new Error("Nom de membre invalide");
  }

  const result = getDb()
    .prepare("UPDATE members SET name = ?, active = ? WHERE id = ?")
    .run(name, active ? 1 : 0, memberId);

  if (result.changes === 0) {
    throw new Error("Membre introuvable");
  }

  if (!active) {
    getDb()
      .prepare("UPDATE assignments SET member_id = NULL WHERE member_id = ?")
      .run(memberId);
    getDb()
      .prepare("DELETE FROM member_sessions WHERE member_id = ?")
      .run(memberId);
  }

  logAudit("admin", ADMIN_USERNAME, "member_updated", {
    memberId,
    name,
    active
  });
}

function regenerateMemberCode(memberId) {
  const member = getDb().prepare("SELECT name FROM members WHERE id = ?").get(memberId);
  if (!member) {
    throw new Error("Membre introuvable");
  }

  const accessCode = generateAccessCode();
  getDb()
    .prepare("UPDATE members SET access_code_hash = ? WHERE id = ?")
    .run(encodeSecret(accessCode), memberId);
  getDb()
    .prepare("DELETE FROM member_sessions WHERE member_id = ?")
    .run(memberId);

  logAudit("admin", ADMIN_USERNAME, "member_code_regenerated", {
    memberId
  });

  return accessCode;
}

function replaceDays(days) {
  const database = getDb();
  const existingComments = new Map(
    database.prepare("SELECT day, comment FROM days").all().map((row) => [row.day, row.comment || ""])
  );

  const transaction = database.transaction(() => {
    if (days.length > 0) {
      database
        .prepare("DELETE FROM days WHERE day NOT IN (" + days.map(() => "?").join(", ") + ")")
        .run(...days);

      const upsertDay = database.prepare(
        "INSERT INTO days (day, sort_order, comment) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET sort_order = excluded.sort_order"
      );
      const upsertAssignment = database.prepare(
        "INSERT INTO assignments (day, slot, member_id) VALUES (?, ?, NULL) ON CONFLICT(day, slot) DO NOTHING"
      );

      days.forEach((day, index) => {
        upsertDay.run(day, index, existingComments.get(day) || "");
        SLOT_KEYS.forEach((slot) => {
          upsertAssignment.run(day, slot);
        });
      });
    }
  });

  transaction();

  logAudit("admin", ADMIN_USERNAME, "days_updated", {
    count: days.length
  });
}

function resetScheduleFromSeed() {
  const database = getDb();
  const seed = createSeedData();
  const assignments = ensureAssignmentsForDays(seed.days, seed.assignments);
  const existingCodes = new Map(
    database
      .prepare("SELECT id, access_code_hash, active FROM members")
      .all()
      .map((row) => [row.id, { accessCodeHash: row.access_code_hash, active: row.active }])
  );

  const transaction = database.transaction(() => {
    database.exec(`
      DELETE FROM assignments;
      DELETE FROM days;
      DELETE FROM members;
      DELETE FROM member_sessions;
    `);

    const insertMember = database.prepare(
      "INSERT INTO members (id, name, sort_order, access_code_hash, active) VALUES (?, ?, ?, ?, ?)"
    );
    seed.members.forEach((member, index) => {
      const previous = existingCodes.get(member.id);
      insertMember.run(
        member.id,
        member.name,
        index,
        previous?.accessCodeHash || null,
        previous?.active ?? 1
      );
    });

    const insertDay = database.prepare(
      "INSERT INTO days (day, sort_order, comment) VALUES (?, ?, ?)"
    );
    const insertAssignment = database.prepare(
      "INSERT INTO assignments (day, slot, member_id) VALUES (?, ?, ?)"
    );

    seed.days.forEach((day, index) => {
      const current = assignments[day];
      insertDay.run(day, index, current.comment || "");
      SLOT_KEYS.forEach((slot) => {
        insertAssignment.run(day, slot, current[slot] || null);
      });
    });
  });

  transaction();

  logAudit("admin", ADMIN_USERNAME, "schedule_reset", {});
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(text);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon"
  };

  return types[extension] || "application/octet-stream";
}

function serveStatic(requestPath, response) {
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(PUBLIC_DIR, safePath);

  if (safePath === "/" || safePath === ".") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendText(response, 404, "Not found");
        return;
      }

      sendText(response, 500, "Failed to load file");
      return;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(filePath)
    });
    response.end(content);
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function getRequestContext(request) {
  const memberSession = getMemberSession(request);
  const adminSession = getAdminSession(request);

  return {
    memberSession,
    adminSession
  };
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      status: "ok",
      host: HOST,
      port: PORT,
      databaseFile: DB_FILE
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/schedule") {
    sendJson(response, 200, {
      ...loadSchedule(),
      config: loadConfig()
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/session") {
    const session = getAdminSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      username: session?.username || null
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/member/session") {
    const session = getMemberSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      member: session
        ? {
            id: session.memberId,
            name: session.memberName
          }
        : null
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");

    if (username !== ADMIN_USERNAME || !verifyPassword(password, ADMIN_PASSWORD_HASH)) {
      sendJson(response, 401, { error: "Identifiants administrateur invalides" });
      return true;
    }

    const token = createAdminSession(username);
    setSessionCookie(response, ADMIN_SESSION_COOKIE_NAME, token);
    logAudit("admin", username, "admin_login", {});
    sendJson(response, 200, { authenticated: true, username });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const session = getAdminSession(request);

    if (session) {
      deleteAdminSession(session.token);
      logAudit("admin", session.username, "admin_logout", {});
    }

    clearSessionCookie(response, ADMIN_SESSION_COOKIE_NAME);
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/member/login") {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const memberId = String(payload.memberId || "").trim();
    const accessCode = String(payload.accessCode || "").trim().toUpperCase();
    const member = getDb()
      .prepare(
        "SELECT id, name, access_code_hash, active FROM members WHERE id = ?"
      )
      .get(memberId);

    if (!member || !member.active || !member.access_code_hash || !verifyPassword(accessCode, member.access_code_hash)) {
      sendJson(response, 401, { error: "Identifiants membre invalides" });
      return true;
    }

    const token = createMemberSession(member.id);
    setSessionCookie(response, MEMBER_SESSION_COOKIE_NAME, token);
    logAudit("member", member.name, "member_login", {
      memberId: member.id
    });
    sendJson(response, 200, {
      authenticated: true,
      member: {
        id: member.id,
        name: member.name
      }
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/member/logout") {
    const session = getMemberSession(request);

    if (session) {
      deleteMemberSession(session.token);
      logAudit("member", session.memberName, "member_logout", {
        memberId: session.memberId
      });
    }

    clearSessionCookie(response, MEMBER_SESSION_COOKIE_NAME);
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/admin/audit") {
    const adminSession = requireAdmin(request, response);
    if (!adminSession) {
      return true;
    }

    sendJson(response, 200, {
      items: loadAuditLog(150)
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/admin/members") {
    const adminSession = requireAdmin(request, response);
    if (!adminSession) {
      return true;
    }

    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");

    try {
      const result = createMember(payload.name);
      sendJson(response, 200, {
        member: result.member,
        accessCode: result.accessCode,
        schedule: loadSchedule()
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Impossible de creer le membre" });
    }
    return true;
  }

  const updateMemberMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)$/);
  if (request.method === "PUT" && updateMemberMatch) {
    const adminSession = requireAdmin(request, response);
    if (!adminSession) {
      return true;
    }

    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");

    try {
      updateMember(decodeURIComponent(updateMemberMatch[1]), payload);
      sendJson(response, 200, { schedule: loadSchedule() });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Impossible de mettre a jour le membre" });
    }
    return true;
  }

  const regenerateCodeMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)\/regenerate-code$/);
  if (request.method === "POST" && regenerateCodeMatch) {
    const adminSession = requireAdmin(request, response);
    if (!adminSession) {
      return true;
    }

    try {
      const accessCode = regenerateMemberCode(decodeURIComponent(regenerateCodeMatch[1]));
      sendJson(response, 200, {
        accessCode,
        schedule: loadSchedule()
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Impossible de regenerer le code" });
    }
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/availability") {
    const actor = requireMemberOrAdmin(request, response);
    if (!actor) {
      return true;
    }

    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");

    try {
      updateAssignment(actor, payload.memberId, payload.day, payload.slot);
      sendJson(response, 200, loadSchedule());
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Mise a jour du creneau invalide" });
    }
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/comment") {
    const actor = requireMemberOrAdmin(request, response);
    if (!actor) {
      return true;
    }

    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");

    try {
      updateComment(actor, payload.day, payload.comment);
      sendJson(response, 200, loadSchedule());
    } catch (error) {
      sendJson(response, 400, { error: error.message || "Mise a jour du commentaire invalide" });
    }
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/days") {
    const adminSession = requireAdmin(request, response);
    if (!adminSession) {
      return true;
    }

    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const days = normalizeDays(payload.days || []);

    if (days.length === 0) {
      sendJson(response, 400, { error: "La liste des dates est invalide" });
      return true;
    }

    replaceDays(days);
    sendJson(response, 200, loadSchedule());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/reset") {
    const adminSession = requireAdmin(request, response);
    if (!adminSession) {
      return true;
    }

    resetScheduleFromSeed();
    sendJson(response, 200, loadSchedule());
    return true;
  }

  return false;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon"
  };

  return types[extension] || "application/octet-stream";
}

const server = http.createServer(async (request, response) => {
  try {
    const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
    const handled = await handleApi(request, response, parsedUrl.pathname);

    if (handled) {
      return;
    }

    serveStatic(parsedUrl.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Unexpected server error" });
  }
});

function serveStatic(requestPath, response) {
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(PUBLIC_DIR, safePath);

  if (safePath === "/" || safePath === ".") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  }

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        sendText(response, 404, "Not found");
        return;
      }

      sendText(response, 500, "Failed to load file");
      return;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(filePath)
    });
    response.end(content);
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });

    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

getDb();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Grangettes prototype running at http://${HOST}:${PORT}`);
  });
}

module.exports = {
  buildUpcomingClubDays,
  createDefaultConfig,
  createSeedData,
  ensureAssignmentsForDays,
  formatDateKey,
  generateAccessCode,
  getDb,
  hashPassword,
  loadAuditLog,
  loadConfig,
  loadSchedule,
  nextMonday,
  normalizeDays,
  normalizeMembers,
  parseCookies,
  verifyPassword,
  server
};
