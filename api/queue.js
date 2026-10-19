// Pool table queue API — one Vercel serverless function.
// GET  /api/queue            -> current state
// POST /api/queue {action..} -> perform an action, returns new state
//
// Storage: Upstash Redis via its REST API (added from Vercel's Storage tab).
// With no Redis env vars set, falls back to in-memory storage (local testing only).

const KEY = "poolqueue:state";
const LOCK = "poolqueue:lock";

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
  const raw = await redis(["GET", KEY]);
  return raw ? JSON.parse(raw) : emptyState();
}
async function save(s) {
  s.updatedAt = Date.now();
  await redis(["SET", KEY, JSON.stringify(s)]);
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

function apply(s, body) {
  const { action, clientId } = body;
  const isAdmin = ADMIN_CODE && body.adminCode === ADMIN_CODE;

  switch (action) {
    case "join": {
      const name = clean(body.name);
      if (!name) throw new UserError("Enter a name");
      if (!clientId) throw new UserError("Missing device id");
      if (findClient(s, clientId)) throw new UserError("You're already in line or on the table");
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
      s.log.unshift({ winner: winner.name, loser: loser.name, at: Date.now() });
      s.log = s.log.slice(0, 15);

      s.table[loserSeat] = null;
      if (loser.requeue) s.queue.push({ id: uid(), name: loser.name, clientId: loser.clientId, requeue: true });
      fillTable(s); // winner keeps their seat; next in line steps up
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

    case "checkAdmin": {
      if (!isAdmin) throw new UserError("Wrong admin code");
      return;
    }

    default:
      throw new UserError("Unknown action");
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const s = await load();
      return res.status(200).json({ ...s, adminEnabled: !!ADMIN_CODE });
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const s = await withLock(async () => {
        const s = await load();
        apply(s, body);
        await save(s);
        return s;
      });
      return res.status(200).json({ ...s, adminEnabled: !!ADMIN_CODE });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    const status = e instanceof UserError ? 400 : 500;
    return res.status(status).json({ error: e.message || "Server error" });
  }
}
