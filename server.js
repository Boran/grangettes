const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD_HASH =
  "scrypt$4e4856adb4313849db418589202ff8be$c480266124b794927c767d57931a184bd798fbbdf142b4b87e82cc6a3f397775bb37f2a9209e3953c67edda5f1ce0724b2142298e55a31b2face0e2dea9be2c3";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_PASSWORD_HASH;
const SESSION_COOKIE_NAME = "grangettes_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const SEED_DATA_FILE = path.join(DATA_DIR, "schedule.json");
const RUNTIME_DATA_FILE = path.join(DATA_DIR, "schedule.local.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const sessions = new Map();

function ensureDataFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(SEED_DATA_FILE)) {
    const seed = createSeedData();
    fs.writeFileSync(SEED_DATA_FILE, JSON.stringify(seed, null, 2));
  }

  if (!fs.existsSync(RUNTIME_DATA_FILE)) {
    fs.copyFileSync(SEED_DATA_FILE, RUNTIME_DATA_FILE);
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    const config = createDefaultConfig();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
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
    slots: ["morning", "afternoon"],
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

function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function cleanupSessions() {
  const now = Date.now();

  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSession(request) {
  cleanupSessions();
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE_NAME];

  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
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

function loadSchedule() {
  return JSON.parse(fs.readFileSync(RUNTIME_DATA_FILE, "utf8"));
}

function saveSchedule(schedule) {
  fs.writeFileSync(RUNTIME_DATA_FILE, JSON.stringify(schedule, null, 2));
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
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
      sessions.delete(session.token);
    }

    clearSessionCookie(response);
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/availability") {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const { memberId, day, slot } = payload;
    const schedule = loadSchedule();
    const memberExists = schedule.members.some((member) => member.id === memberId);
    const dayExists = schedule.days.includes(day);
    const slotExists = schedule.slots.includes(slot);

    if (!memberExists || !dayExists || !slotExists) {
      sendJson(response, 400, { error: "Mise à jour du créneau invalide" });
      return true;
    }

    schedule.assignments[day] = schedule.assignments[day] || {
      morning: null,
      afternoon: null,
      comment: ""
    };

    const currentOwner = schedule.assignments[day][slot];
    schedule.assignments[day][slot] = currentOwner === memberId ? null : memberId;

    saveSchedule(schedule);
    sendJson(response, 200, schedule);
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/comment") {
    const raw = await readRequestBody(request);
    const payload = JSON.parse(raw || "{}");
    const { day, comment } = payload;
    const schedule = loadSchedule();
    const dayExists = schedule.days.includes(day);

    if (!dayExists || typeof comment !== "string") {
      sendJson(response, 400, { error: "Mise à jour du commentaire invalide" });
      return true;
    }

    schedule.assignments[day] = schedule.assignments[day] || {
      morning: null,
      afternoon: null,
      comment: ""
    };
    schedule.assignments[day].comment = comment.slice(0, 280);

    saveSchedule(schedule);
    sendJson(response, 200, schedule);
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

    const allowedMemberIds = new Set(members.map((member) => member.id));
    const assignments = ensureAssignmentsForDays(schedule.days, schedule.assignments);

    schedule.days.forEach((day) => {
      schedule.slots.forEach((slot) => {
        if (!allowedMemberIds.has(assignments[day][slot])) {
          assignments[day][slot] = null;
        }
      });
    });

    schedule.members = members;
    schedule.assignments = assignments;

    saveSchedule(schedule);
    sendJson(response, 200, schedule);
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

    const schedule = loadSchedule();
    schedule.days = days;
    schedule.assignments = ensureAssignmentsForDays(days, schedule.assignments);

    saveSchedule(schedule);
    sendJson(response, 200, schedule);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/reset") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const fresh = createSeedData();
    saveSchedule(fresh);
    sendJson(response, 200, fresh);
    return true;
  }

  return false;
}

ensureDataFile();

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

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Grangettes prototype running at http://${HOST}:${PORT}`);
  });
}

module.exports = {
  buildUpcomingClubDays,
  createSeedData,
  createDefaultConfig,
  ensureAssignmentsForDays,
  hashPassword,
  loadConfig,
  loadSchedule,
  normalizeDays,
  normalizeMembers,
  parseCookies,
  verifyPassword,
  saveSchedule,
  nextMonday,
  formatDateKey,
  server
};
