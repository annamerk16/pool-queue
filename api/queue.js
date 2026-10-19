// Pool table queue API — one Vercel serverless function.
// GET  /api/queue            -> current state
// GET  /api/queue?view=stats -> permanent player records
// POST /api/queue {action..} -> perform an action, returns new state
//
// Storage: Upstash Redis via its REST API (added from Vercel's Storage tab).
// With no Redis env vars set, falls back to in-memory storage (local testing only).

const KEY = "poolqueue:state";
const LOCK = "poolqueue:lock";
const PLAYERS = "poolqueue:players"; // permanent records, never touched by "Clear everything"

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_CODE = process.env.ADMIN_CODE || "";

// ---------- storage ----------
const mem = new Map();

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    // in-memory fallback
    const [op, key, val, ...rest] = cmd;
    if (op === "GET") return mem.has(key) ? mem.get(key) : null;
    if (op === "SET") {
      if (rest.includes("NX") && mem.has(key)) return null;
      mem.set(key, val);
      return "OK";
    }
    if (op === "DEL") { mem.delete(key); return 1; }
    if (op === "MGET") return [key, val, ...rest].map((k) => (mem.has(k) ? mem.get(k) : null));
    throw new Error("unsupported op " + op);
  }
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const emptyState = () => ({ table: [null, null], queue: [], log: [], updatedAt: Date.now() });

async function load() {
  const [raw, rawPlayers] = await redis(["MGET", KEY, PLAYERS]);
  return { s: raw ? JSON.parse(raw) : emptyState(), players: rawPlayers ? JSON.parse(rawPlayers) : {} };
}
async function save(s) {
  s.updatedAt = Date.now();
  await redis(["SET", KEY, JSON.stringify(s)]);
}
async function savePlayers(players) {
  await redis(["SET", PLAYERS, JSON.stringify(players)]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple lock so two taps at the same moment can't corrupt the queue.
async function withLock(fn) {
  for (let i = 0; i < 40; i++) {
    const ok = await redis(["SET", LOCK, "1", "NX", "PX", "5000"]);
    if (ok === "OK") {
      try { return await fn(); }
      finally { await redis(["DEL", LOCK]); }
    }
    await sleep(75);
  }
  throw new Error("Busy, try again");
}

// ---------- game logic ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const clean = (n) => String(n || "").replace(/[<>]/g, "").trim().slice(0, 24);
// "Anna", "anna" and " ANNA " all map to the same record
const nameKey = (n) => clean(n).toLowerCase().replace(/\s+/g, " ");

// Look up (or create) the permanent record for a name. The latest spelling becomes the display name.
function register(players, name) {
  const key = nameKey(name);
  const rec = players[key] || (players[key] = { name, wins: 0, losses: 0, bestStreak: 0, form: "", vs: {}, firstSeen: Date.now(), lastPlayed: null });
  rec.name = name;
  return rec;
}

function recordGame(players, winnerName, loserName, streak) {
  const wk = nameKey(winnerName), lk = nameKey(loserName);
  const w = register(players, winnerName), l = register(players, loserName);
  w.wins++; l.losses++;
  w.bestStreak = Math.max(w.bestStreak, streak);
  w.form = ("W" + w.form).slice(0, 10); // newest first
  l.form = ("L" + l.form).slice(0, 10);
  (w.vs[lk] ||= [0, 0])[0]++; // vs[opponent] = [wins, losses]
  (l.vs[wk] ||= [0, 0])[1]++;
  w.lastPlayed = l.lastPlayed = Date.now();
}

function nameTaken(s, name) {
  const key = nameKey(name);
  return [...s.queue, ...s.table].some((p) => p && nameKey(p.name) === key);
}

function fillTable(s) {
  for (let i = 0; i < 2; i++) {
    if (!s.table[i] && s.queue.length) s.table[i] = { ...s.queue.shift(), streak: 0 };
  }
}

function findClient(s, clientId) {
  if (s.table.some((p) => p && p.clientId === clientId)) return "table";
  if (s.queue.some((p) => p.clientId === clientId)) return "queue";
  return null;
}

class UserError extends Error {}

function apply(s, players, body) {
  const { action, clientId } = body;
  const isAdmin = ADMIN_CODE && body.adminCode === ADMIN_CODE;

  switch (action) {
    case "join": {
      const name = clean(body.name);
      if (!name) throw new UserError("Enter a name");
      if (!clientId) throw new UserError("Missing device id");
      if (findClient(s, clientId)) throw new UserError("You're already in line or on the table");
      if (nameTaken(s, name)) throw new UserError(`Someone named ${name} is already in line`);
      register(players, name);
      s.queue.push({ id: uid(), name, clientId, requeue: !!body.requeue });
      fillTable(s);
      return;
    }

    case "leave": {
      s.queue = s.queue.filter((p) => p.clientId !== clientId);
      s.table = s.table.map((p) => (p && p.clientId === clientId ? null : p));
      fillTable(s);
      return;
    }

    case "setRequeue": {
      for (const p of [...s.queue, ...s.table]) if (p && p.clientId === clientId) p.requeue = !!body.requeue;
      return;
    }

    case "win": {
      const [a, b] = s.table;
      if (!a || !b) throw new UserError("Need two players on the table");
      const reporterOnTable = s.table.some((p) => p.clientId === clientId);
      if (!reporterOnTable && !isAdmin) throw new UserError("Only the two players can report the result");
      const winner = s.table.find((p) => p.id === body.winnerId);
      if (!winner) throw new UserError("That player isn't on the table");
      const loser = winner === a ? b : a;
      const loserSeat = s.table.indexOf(loser);

      winner.streak = (winner.streak || 0) + 1;
      recordGame(players, winner.name, loser.name, winner.streak);
      s.log.unshift({ winner: winner.name, loser: loser.name, at: Date.now() });
      s.log = s.log.slice(0, 15);

      s.table[loserSeat] = null;
      if (loser.requeue) s.queue.push({ id: uid(), name: loser.name, clientId: loser.clientId, requeue: true });
      fillTable(s); // winner keeps their seat; next in line steps up
      return;
    }

    // ---- admin setup tools ----
    case "addPlayer": {
      if (!isAdmin) throw new UserError("Admin code required");
      const name = clean(body.name);
      if (!name) throw new UserError("Enter a name");
      if (nameTaken(s, name)) throw new UserError(`${name} is already in line`);
      register(players, name);
      // admin-added players aren't tied to any phone
      const p = { id: uid(), name, clientId: "admin-" + uid(), requeue: body.requeue !== false, addedByAdmin: true };
      if (body.front) s.queue.unshift(p); else s.queue.push(p);
      fillTable(s);
      return;
    }

    case "move": {
      if (!isAdmin) throw new UserError("Admin code required");
      const i = s.queue.findIndex((p) => p.id === body.playerId);
      if (i < 0) throw new UserError("Player not in line");
      const j = body.to === "front" ? 0 : i + (body.dir > 0 ? 1 : -1);
      if (j < 0 || j >= s.queue.length) return;
      const [p] = s.queue.splice(i, 1);
      s.queue.splice(j, 0, p);
      return;
    }

    case "adminRequeue": {
      if (!isAdmin) throw new UserError("Admin code required");
      for (const p of [...s.queue, ...s.table]) if (p && p.id === body.playerId) p.requeue = !!body.requeue;
      return;
    }

    case "remove": {
      if (!isAdmin) throw new UserError("Admin code required");
      s.queue = s.queue.filter((p) => p.id !== body.playerId);
      s.table = s.table.map((p) => (p && p.id === body.playerId ? null : p));
      fillTable(s);
      return;
    }

    case "reset": {
      if (!isAdmin) throw new UserError("Admin code required");
      Object.assign(s, emptyState());
      return;
    }

    // ---- admin record tools (stats page) ----
    case "deleteRecord": {
      if (!isAdmin) throw new UserError("Admin code required");
      if (!players[body.key]) throw new UserError("No such player");
      delete players[body.key];
      for (const p of Object.values(players)) delete p.vs[body.key];
      return;
    }

    case "mergeRecord": {
      // fold a typo'd name (from) into the real one (into)
      if (!isAdmin) throw new UserError("Admin code required");
      const { from, into } = body;
      const a = players[from], b = players[into];
      if (!a || !b || from === into) throw new UserError("Pick two different players");
      b.wins += a.wins; b.losses += a.losses;
      b.bestStreak = Math.max(b.bestStreak, a.bestStreak);
      b.firstSeen = Math.min(b.firstSeen, a.firstSeen);
      if ((a.lastPlayed || 0) > (b.lastPlayed || 0)) { b.lastPlayed = a.lastPlayed; b.form = a.form; }
      for (const [opp, [w, l]] of Object.entries(a.vs)) {
        if (opp === into) continue;
        const r = (b.vs[opp] ||= [0, 0]); r[0] += w; r[1] += l;
      }
      delete players[from];
      delete b.vs[from];
      for (const [k, p] of Object.entries(players)) {
        if (!p.vs[from]) continue;
        if (k !== into) { const r = (p.vs[into] ||= [0, 0]); r[0] += p.vs[from][0]; r[1] += p.vs[from][1]; }
        delete p.vs[from];
      }
      return;
    }

    case "checkAdmin": {
      if (!isAdmin) throw new UserError("Wrong admin code");
      return;
    }

    default:
      throw new UserError("Unknown action");
  }
}

// Win–loss for whoever is on the table or in line, so the main page can show it
function withRecords(s, players) {
  const records = {};
  for (const p of [...s.table, ...s.queue]) {
    const r = p && players[nameKey(p.name)];
    if (r) records[p.id] = [r.wins, r.losses];
  }
  return { ...s, records, adminEnabled: !!ADMIN_CODE };
}

function statsView(players) {
  return { players: Object.entries(players).map(([key, p]) => ({ key, ...p })), adminEnabled: !!ADMIN_CODE };
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const { s, players } = await load();
      if (req.query && req.query.view === "stats") return res.status(200).json(statsView(players));
      return res.status(200).json(withRecords(s, players));
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const { s, players } = await withLock(async () => {
        const { s, players } = await load();
        const before = JSON.stringify(players);
        apply(s, players, body);
        await save(s);
        if (JSON.stringify(players) !== before) await savePlayers(players);
        return { s, players };
      });
      if (body.view === "stats") return res.status(200).json(statsView(players));
      return res.status(200).json(withRecords(s, players));
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    const status = e instanceof UserError ? 400 : 500;
    return res.status(status).json({ error: e.message || "Server error" });
  }
}
