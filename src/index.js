// Notifiche fotovoltaico GoodWe SEMS+ -> Telegram, su Cloudflare Workers.
// Segreti da impostare nel Worker: SEMS_ACCOUNT, SEMS_PASSWORD, STATION_ID, DEBUG_KEY,
// TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
// KV namespace da collegare con nome: STATE.
// Usa il login "web" di SEMS+ (header Token + X-Signature).

// ---- REGOLE (modificale come vuoi) ----
// metric: "soc" (batteria %) oppure "pv" (produzione FV in kW)
// op: "<", ">", ">=" oppure "cross" (notifica quando il valore raggiunge/attraversa la soglia)
// value: soglia; reset: valore oltre il quale la regola si riarma (non serve per "cross")
const RULES = [
  { id: "soc10", metric: "soc", op: "<", value: 10, reset: 15, title: "Batteria sotto il 10%" },
  { id: "soc50", metric: "soc", op: "cross", value: 50, title: "Batteria al 50%" },
  { id: "soc100", metric: "soc", op: ">=", value: 100, reset: 95, title: "Batteria carica al 100%" },
  { id: "pv1", metric: "pv", op: ">", value: 1, reset: 0.8, title: "Produzione FV oltre 1 kW" },
];

const LOGIN_HOSTS = ["https://eu-semsplus.goodwe.com", "https://semsplus.goodwe.com"];
const LOGIN_PATH = "/web/sems/sems-user/api/v1/auth/cross-login";
const FALLBACK_API = "https://eu-gateway.semsportal.com/web/sems";
const OK = new Set([0, "0", "00000"]);

// ---------- Utilità crittografiche ----------
async function digestHex(algo, text) {
  const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SEMS+ vuole base64( md5_esadecimale(password) )
async function encodePassword(pw) {
  return btoa(await digestHex("MD5", pw));
}

// X-Signature = base64( sha256hex("<ms>@<uid>@<token>") + "@" + <ms> )
async function signature(uid, token) {
  const ms = Date.now();
  const h = await digestHex("SHA-256", `${ms}@${uid}@${token}`);
  return btoa(`${h}@${ms}`);
}

// ---------- Login SEMS+ (web) ----------
async function semsLogin(env) {
  const account = String(env.SEMS_ACCOUNT || "").trim();
  const pwd = await encodePassword(String(env.SEMS_PASSWORD || ""));
  const errors = [];
  for (const host of LOGIN_HOSTS) {
    try {
      const r = await fetch(host + LOGIN_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, */*;q=0.5",
          Token: JSON.stringify({ uid: "", timestamp: 0, token: "", client: "semsPlusWeb", version: "", language: "en" }),
          "X-Signature": await signature("", ""),
        },
        body: JSON.stringify({ account, pwd, agreement: 1, isChinese: false, isLocal: false }),
      });
      const text = await r.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch (e) {
        errors.push(`${host}: HTTP ${r.status} risposta non valida`);
        continue;
      }
      if (OK.has(j.code) && j.data && j.data.token) {
        const api = typeof j.api === "string" && j.api ? j.api : j.data.api || FALLBACK_API;
        return { token: j.data, api };
      }
      errors.push(`${host}: code=${j.code} msg=${j.msg || j.description || j.errorMsg || ""}`);
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
    }
  }
  throw new Error("Login SEMS+ fallito: " + errors.join(" | "));
}

// Riusa la sessione per ~30 minuti (evita troppi login e blocchi per rate limit).
async function getSession(env, force = false) {
  if (!force && env.STATE) {
    try {
      const c = await env.STATE.get("session2", { type: "json" });
      if (c && c.exp > Date.now()) return c.s;
    } catch (e) {}
  }
  const s = await semsLogin(env);
  if (env.STATE) {
    try {
      await env.STATE.put("session2", JSON.stringify({ s, exp: Date.now() + 30 * 60 * 1000 }));
    } catch (e) {}
  }
  return s;
}

async function call(session, method, path, body) {
  const t = session.token;
  const r = await fetch(session.api + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Token: JSON.stringify({ ...t, api: session.api }),
      "X-Signature": await signature(t.uid, t.token),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`HTTP ${r.status} risposta non valida`);
  }
  if (!OK.has(j.code)) throw new Error(`code=${j.code} msg=${j.msg || j.description || j.errorMsg || r.status}`);
  return j.data;
}

// ---------- Lettura dati ----------
async function fetchRaw(env, session) {
  const raw = {};
  try {
    raw.flow = await call(session, "GET", `/sems-plant/api/stations/flow?stationId=${encodeURIComponent(env.STATION_ID)}`);
  } catch (e) {
    raw.flow_error = e.message;
  }
  return raw;
}

function num(v) {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// pSystem = potenza FV (kW), soc = stato di carica batteria (%)
function parseReadings(raw) {
  const f = raw.flow || {};
  return { soc: num(f.soc), pv: num(f.pSystem) };
}

async function getReadings(env) {
  let session = await getSession(env);
  let raw = await fetchRaw(env, session);
  if (!raw.flow) {
    session = await getSession(env, true); // sessione scaduta? rifai il login
    raw = await fetchRaw(env, session);
  }
  return { readings: parseReadings(raw), raw };
}

// Elenca gli impianti dell'account (serve a trovare STATION_ID). Prova più endpoint.
async function listStations(env) {
  const session = await getSession(env, true);
  const out = { login: "ok", api: session.api };
  const attempts = [
    ["POST", "/sems-plant/api/portal/stations/page", { current: 1, size: 15 }],
    ["POST", "/sems-plant/api/portal/stations/simple-query", {}],
    ["POST", "/sems-plant/api/stations/simple-query", {}],
    ["GET", "/sems-plant/api/stations/simple-query", undefined],
  ];
  for (const [method, path, body] of attempts) {
    try {
      out[`${method} ${path}`] = await call(session, method, path, body);
    } catch (e) {
      out[`${method} ${path}`] = "errore: " + e.message;
    }
  }
  return out;
}

// ---------- Regole e notifiche ----------
function triggered(rule, v) {
  if (rule.op === "<") return v < rule.value;
  if (rule.op === ">") return v > rule.value;
  return v >= rule.value; // ">="
}
function cleared(rule, v) {
  return rule.op === "<" ? v >= rule.reset : v <= rule.reset;
}

async function notify(env, title, message) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Imposta i secret TELEGRAM_TOKEN e TELEGRAM_CHAT_ID");
  }
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${title}\n${message}` }),
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function run(env) {
  const { readings, raw } = await getReadings(env);
  if (readings.soc === null && readings.pv === null) {
    throw new Error("Nessun dato letto: " + JSON.stringify({ flow: raw.flow_error }));
  }
  for (const rule of RULES) {
    const v = readings[rule.metric];
    if (v === null || v === undefined) continue;
    const unitLabel = rule.metric === "soc" ? "%" : " kW";
    const text = `${rule.metric === "soc" ? "Batteria" : "Produzione FV"}: ${v}${unitLabel}`;
    if (rule.op === "cross") {
      const lastKey = "last:" + rule.id;
      const prev = parseFloat(await env.STATE.get(lastKey));
      const crossed =
        Number.isFinite(prev) &&
        ((prev > rule.value && v <= rule.value) || (prev < rule.value && v >= rule.value));
      if (crossed) await notify(env, rule.title, text);
      await env.STATE.put(lastKey, String(v));
      continue;
    }
    const key = "rule:" + rule.id;
    const active = (await env.STATE.get(key)) === "1";
    if (!active && triggered(rule, v)) {
      await notify(env, rule.title, text);
      await env.STATE.put(key, "1");
    } else if (active && cleared(rule, v)) {
      await env.STATE.put(key, "0");
    }
  }
  return { readings };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).catch((e) => console.error(e.message)));
  },
  // Pagina di debug (protetta da DEBUG_KEY):
  //   ?key=XXX          -> dati letti dall'impianto (grezzi)
  //   ?key=XXX&list=1   -> elenco impianti (per trovare STATION_ID)
  //   ?key=XXX&diag=1   -> controllo delle credenziali ricevute (senza rivelarle)
  async fetch(request, env) {
    const params = new URL(request.url).searchParams;
    if (!env.DEBUG_KEY || params.get("key") !== env.DEBUG_KEY) return new Response("Not found", { status: 404 });
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json" } });
    if (params.get("diag")) {
      const a = String(env.SEMS_ACCOUNT ?? "");
      const p = String(env.SEMS_PASSWORD ?? "");
      return json({
        account_lunghezza: a.length,
        password_lunghezza: p.length,
        station_id_lunghezza: String(env.STATION_ID ?? "").length,
        kv_STATE_collegato: !!env.STATE,
      });
    }
    try {
      // &test=1 invia subito una notifica di prova (senza passare dalle regole)
      if (params.get("test")) {
        await notify(env, "Prova notifica", "Il Worker riesce a inviare notifiche.");
        return json({ inviata: true });
      }
      if (params.get("list")) return json(await listStations(env));
      // &run=1 esegue subito lo stesso controllo del cron (può inviare notifiche) e mostra l'esito
      if (params.get("run")) return json(await run(env));
      const session = await getSession(env, true);
      return json(await fetchRaw(env, session));
    } catch (e) {
      return new Response(e.message, { status: 500 });
    }
  },
};
