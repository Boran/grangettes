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
const SESSION_COOKIE_NAME = "grangettes_admin_session";
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
      // Try the next candidate.
    }
  }

  return createSeedData();
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
        name: String(value?.name || "").trim()
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
      return { id: candidateId, name: member.name };
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
  `);

  const alreadyInitialized = database.prepare("SELECT value FROM app_meta WHERE key = ?").get("schema_version");
  if (alreadyInitialized) {
    return;
  }

  importLegacyData(database);
  database
    .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
    .run("schema_version", "1");
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
    `);

    database
      .prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)")
      .run("title", String(config.title || createDefaultConfig().title));

    const insertMember = database.prepare(
      "INSERT INTO members (id, name, sort_order) VALUES (?, ?, ?)"
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

function loadSchedule() {
  const database = getDb();
  const members = database
    .prepare("SELECT id, name FROM members ORDER BY sort_order ASC, name ASC")
    .all();
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

function loadConfig() {
  const database = getDb();
  const titleRow = database.prepare("SELECT value FROM app_meta WHERE key = ?").get("title");

  return {
    title: titleRow?.value || createDefaultConfig().title
  };
}

function updateAssignment(memberId, day, slot) {
  const database = getDb();
  const memberExists = database.prepare("SELECT 1 FROM members WHERE id = ?").get(memberId);
  const dayExists = database.prepare("SELECT 1 FROM days WHERE day = ?").get(day);

  if (!memberExists || !dayExists || !SLOT_KEYS.includes(slot)) {
    throw new Error("Mise a jour du creneau invalide");
  }

  const current = database
    .prepare("SELECT member_id FROM assignments WHERE day = ? AND slot = ?")
    .get(day, slot);
  const nextOwner = current?.member_id === memberId ? null : memberId;

  database
    .prepare(
      "INSERT INTO assignments (day, slot, member_id) VALUES (?, ?, ?) ON CONFLICT(day, slot) DO UPDATE SET member_id = excluded.member_id"
    )
    .run(day, slot, nextOwner);
}

function updateComment(day, comment) {
  const database = getDb();
  const result = database
    .prepare("UPDATE days SET comment = ? WHERE day = ?")
    .run(String(comment || "").slice(0, 280), day);

  if (result.changes === 0) {
    throw new Error("Mise a jour du commentaire invalide");
  }
}

function replaceMembers(members) {
  const database = getDb();
  const keepIds = new Set(members.map((member) => member.id));
  const placeholders = members.map(() => "(?, ?, ?)").join(", ");
  const values = [];

  members.forEach((member, index) => {
    values.push(member.id, member.name, index);
  });

  const transaction = database.transaction(() => {
    if (members.length > 0) {
      database.prepare("DELETE FROM members WHERE id NOT IN (" + members.map(() => "?").join(", ") + ")").run(...members.map((member) => member.id));
      database
        .prepare(
          "INSERT INTO members (id, name, sort_order) VALUES " +
            placeholders +
            " ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order"
        )
        .run(...values);
    }

    const staleAssignments = database
      .prepare("SELECT day, slot, member_id FROM assignments WHERE member_id IS NOT NULL")
      .all()
      .filter((row) => !keepIds.has(row.member_id));

    const clearAssignment = database.prepare(
      "UPDATE assignments SET member_id = NULL WHERE day = ? AND slot = ?"
    );
    staleAssignments.forEach((row) => {
      clearAssignment.run(row.day, row.slot);
    });
  });

  transaction();
}

function replaceDays(days) {
  const database = getDb();
  const existingComments = new Map(
    database.prepare("SELECT day, comment FROM days").all().map((row) => [row.day, row.comment || ""])
  );

  const transaction = database.transaction(() => {
    if (days.length > 0) {
      database.prepare("DELETE FROM days WHERE day NOT IN (" + days.map(() => "?").join(", ") + ")").run(...days);

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
}

function resetScheduleFromSeed() {
  const database = getDb();
  const seed = createSeedData();
  const assignments = ensureAssignmentsForDays(seed.days, seed.assignments);

  const transaction = database.transaction(() => {
    database.exec(`
      DELETE FROM assignments;
      DELETE FROM days;
      DELETE FROM members;
    `);

    const insertMember = database.prepare(
      "INSERT INTO members (id, name, sort_order) VALUES (?, ?, ?)"
    );
    seed.members.forEach((member, index) => {
      insertMember.run(member.id, member.name, index);
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
}

function cleanupSessions() {
  getDb().prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(Date.now());
}

function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  getDb()
    .prepare("INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)")
    .run(token, username, Date.now() + SESSION_TTL_MS);
  return token;
}

function getSession(request) {
  cleanupSessions();
  const token = parseCookies(request)[SESSION_COOKIE_NAME];

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
    username: session.username,
    expiresAt: session.expires_at
  };
}

function deleteSession(token) {
  getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}

function setSessionCookie(response, token) {
  appendSetCookie(
    response,
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}`
  );
}

function clearSessionCookie(response) {
  appendSetCookie(
    response,
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function requireAdmin(request, response) {
  if (getSession(request)) {
    return true;
  }

  response.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: "Authentification administrateur requise" }));
  return false;
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

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      status: "ok",
      host: HOST,
      port: PORT,
      databaseFile: DB_FILE,
      seedDataFile: SEED_DATA_FILE
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
    const session = getSession(request);
    sendJson(response, 200, {
      authenticated: Boolean(session),
      username: session?.username || null
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

    const token = createSession(username);
    setSessionCookie(response, token);
    sendJson(response, 200, { authenticated: true, username });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const session = getSession(request);

    if (session) {
      deleteSession(session.token);
    }

    clearSessionCookie(response);
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/availability") {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const { memberId, day, slot } = payload;

    try {
      updateAssignment(memberId, day, slot);
      sendJson(response, 200, loadSchedule());
    } catch (_error) {
      sendJson(response, 400, { error: "Mise a jour du creneau invalide" });
    }
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/comment") {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");

    try {
      updateComment(payload.day, payload.comment);
      sendJson(response, 200, loadSchedule());
    } catch (_error) {
      sendJson(response, 400, { error: "Mise a jour du commentaire invalide" });
    }
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/members") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const schedule = loadSchedule();
    const members = normalizeMembers(payload.members || [], schedule.members);

    if (members.length === 0) {
      sendJson(response, 400, { error: "La liste des membres est invalide" });
      return true;
    }

    replaceMembers(members);
    sendJson(response, 200, loadSchedule());
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/days") {
    if (!requireAdmin(request, response)) {
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
    if (!requireAdmin(request, response)) {
      return true;
    }

    resetScheduleFromSeed();
    sendJson(response, 200, loadSchedule());
    return true;
  }

  return false;
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
  getDb,
  hashPassword,
  loadConfig,
  loadSchedule,
  nextMonday,
  normalizeDays,
  normalizeMembers,
  parseCookies,
  verifyPassword,
  server
};
