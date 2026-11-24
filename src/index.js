// Notifiche fotovoltaico GoodWe SEMS+ -> Telegram, su Cloudflare Workers.
// Segreti da impostare nel Worker: SEMS_ACCOUNT, SEMS_PASSWORD, STATION_ID, DEBUG_KEY,
// TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
// KV namespace da collegare con nome: STATE.
// Usa il login "web" di SEMS+ (header Token + X-Signature).
//
// Pagine web (tutte protette da ?key=<DEBUG_KEY>):
//   /impostazioni     -> pagina per attivare/disattivare e personalizzare le notifiche
//   /export.xlsx      -> foglio elettronico: "Rilevazioni" + "Eventi giornalieri"
//   /rilevazioni.csv  -> solo le rilevazioni in CSV
//   /eventi.csv       -> solo gli eventi giornalieri in CSV

// ---- REGOLE PREDEFINITE ----
// Sono i valori di partenza: dalla pagina /impostazioni si possono attivare/disattivare
// e cambiare soglia, riarmo e titolo (salvati in KV, chiave "config").
// metric: "soc" (batteria %) oppure "pv" (produzione FV in kW)
// op: "<", ">", ">=" oppure "cross" (notifica quando il valore raggiunge/attraversa la soglia)
// value: soglia; reset: valore oltre il quale la regola si riarma (non serve per "cross")
const DEFAULT_RULES = [
  { id: "soc10", metric: "soc", op: "<", value: 10, reset: 15, title: "Batteria sotto il 10%" },
  { id: "soc50", metric: "soc", op: "cross", value: 50, title: "Batteria al 50%" },
  { id: "soc100", metric: "soc", op: ">=", value: 100, reset: 95, title: "Batteria carica al 100%" },
  { id: "pv1", metric: "pv", op: ">", value: 1, reset: 0.8, title: "Produzione FV oltre 1 kW" },
];

// Riepilogo giornaliero su Telegram (modificabile dalla pagina /impostazioni)
const DEFAULT_SUMMARY = { enabled: true, hour: 21 };

// Eventi giornalieri registrati nel foglio "Eventi giornalieri" (solo il primo del giorno)
const EVENT_SOC = 50; // ora in cui la batteria sale al 50%
const EVENT_PV_KW = 1; // ora in cui la potenza FV raggiunge 1 kW
const EVENT_ENERGY_KWH = 1; // ora in cui la produzione del giorno raggiunge 1 kWh

const TIMEZONE = "Europe/Rome";

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

// Possibili nomi del campo "produzione di oggi (kWh)" nella risposta SEMS+.
// Se il tuo impianto usa un nome diverso, impostalo nella variabile ENERGY_FIELD del Worker
// (lo vedi nei dati grezzi dell'endpoint di debug ?key=XXX).
const ENERGY_FIELDS = ["eDay", "eday", "eToday", "todayPv", "todayGeneration", "generationToday", "dayGeneration", "todayEnergy", "pvToday"];

function findField(obj, names, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return null;
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined) {
      const v = num(obj[k]);
      if (v !== null) return v;
    }
  }
  for (const v of Object.values(obj)) {
    const found = findField(v, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

// pSystem = potenza FV (kW), soc = stato di carica batteria (%), energy = produzione di oggi (kWh, se disponibile)
function parseReadings(raw, env = {}) {
  const f = raw.flow || {};
  const names = env.ENERGY_FIELD ? [String(env.ENERGY_FIELD)] : ENERGY_FIELDS;
  return { soc: num(f.soc), pv: num(f.pSystem), energy: findField(f, names) };
}

async function getReadings(env) {
  let session = await getSession(env);
  let raw = await fetchRaw(env, session);
  if (!raw.flow) {
    session = await getSession(env, true); // sessione scaduta? rifai il login
    raw = await fetchRaw(env, session);
  }
  return { readings: parseReadings(raw, env), raw };
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

// ---------- Configurazione (pagina /impostazioni) ----------
async function loadConfig(env) {
  let saved = null;
  try {
    saved = await env.STATE.get("config", { type: "json" });
  } catch (e) {}
  saved = saved || {};
  const rules = DEFAULT_RULES.map((r) => {
    const c = (saved.rules && saved.rules[r.id]) || {};
    return {
      ...r,
      enabled: c.enabled !== undefined ? !!c.enabled : true,
      value: Number.isFinite(c.value) ? c.value : r.value,
      reset: r.op === "cross" ? undefined : Number.isFinite(c.reset) ? c.reset : r.reset,
      title: typeof c.title === "string" && c.title.trim() ? c.title.trim() : r.title,
    };
  });
  const summary = { ...DEFAULT_SUMMARY, ...(saved.summary || {}) };
  return { rules, summary };
}

// Legge il modulo inviato dalla pagina e restituisce { config, errors }
function configFromForm(form) {
  const errors = [];
  const out = { rules: {}, summary: {} };
  for (const r of DEFAULT_RULES) {
    const value = num(form.get(`${r.id}_value`));
    const c = { enabled: form.get(`${r.id}_enabled`) === "on", title: String(form.get(`${r.id}_title`) || "").slice(0, 100) };
    if (value === null) errors.push(`${r.title}: soglia non valida`);
    else c.value = value;
    if (r.op !== "cross") {
      const reset = num(form.get(`${r.id}_reset`));
      if (reset === null) errors.push(`${r.title}: riarmo non valido`);
      else c.reset = reset;
      if (value !== null && reset !== null) {
        if (r.op === "<" && reset <= value) errors.push(`${r.title}: il riarmo deve essere maggiore della soglia`);
        if (r.op !== "<" && reset >= value) errors.push(`${r.title}: il riarmo deve essere minore della soglia`);
      }
    }
    out.rules[r.id] = c;
  }
  const hour = parseInt(form.get("summary_hour"), 10);
  if (!(hour >= 0 && hour <= 23)) errors.push("Riepilogo: ora non valida (0-23)");
  out.summary = { enabled: form.get("summary_enabled") === "on", hour: hour >= 0 && hour <= 23 ? hour : DEFAULT_SUMMARY.hour };
  return { config: out, errors };
}

// ---------- Data e ora locali ----------
function localNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: parseInt(parts.hour, 10) };
}

function itDate(day) {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

// ---------- Stato ----------
// Un'unica chiave KV "state" scritta una volta per esecuzione (il piano gratuito KV ha 1000 scritture/giorno):
//   rules: { id: true/false } regole attive; last: { id: valore } per le regole "cross"
//   day, rows: rilevazioni del giorno corrente; events: primi eventi del giorno
//   energyEst: produzione stimata (integrando la potenza), prev: ultima rilevazione
//   summarySent: giorno dell'ultimo riepilogo inviato
// Al cambio di giorno le rilevazioni vengono archiviate nella chiave "log:AAAA-MM-GG".
async function loadState(env) {
  let st = null;
  try {
    st = await env.STATE.get("state", { type: "json" });
  } catch (e) {}
  if (st) return st;
  // Prima esecuzione: recupera lo stato salvato dalla versione precedente (evita notifiche doppie)
  st = { rules: {}, last: {}, day: null, rows: [], events: {}, energyEst: 0, prev: null, summarySent: null };
  for (const r of DEFAULT_RULES) {
    try {
      if (r.op === "cross") {
        const v = parseFloat(await env.STATE.get("last:" + r.id));
        if (Number.isFinite(v)) st.last[r.id] = v;
      } else {
        st.rules[r.id] = (await env.STATE.get("rule:" + r.id)) === "1";
      }
    } catch (e) {}
  }
  return st;
}

function energyOf(st) {
  if (!st.rows.length) return st.energyEst || 0;
  const lastRow = st.rows[st.rows.length - 1];
  return lastRow[3] !== null && lastRow[3] !== undefined ? lastRow[3] : st.energyEst || 0;
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

function fmt(n, digits = 2) {
  return n === null || n === undefined ? "n.d." : String(Math.round(n * 10 ** digits) / 10 ** digits).replace(".", ",");
}

function summaryText(st) {
  const last = st.rows[st.rows.length - 1];
  const portal = last && last[3] !== null && last[3] !== undefined;
  const lines = [
    `Produzione giornaliera: ${fmt(energyOf(st))} kWh${portal ? "" : " (stimata)"}`,
    last ? `Batteria all'ultima rilevazione (${last[0]}): ${fmt(last[1], 0)}%` : "Batteria: nessuna rilevazione oggi",
  ];
  if (st.events.soc) lines.push(`Batteria al ${EVENT_SOC}% alle ${st.events.soc}`);
  if (st.events.kwh) lines.push(`Primo ${EVENT_ENERGY_KWH} kWh prodotto alle ${st.events.kwh}`);
  return lines.join("\n");
}

async function run(env, { forceSummary = false } = {}) {
  const { readings, raw } = await getReadings(env);
  if (readings.soc === null && readings.pv === null) {
    throw new Error("Nessun dato letto: " + JSON.stringify({ flow: raw.flow_error }));
  }
  const config = await loadConfig(env);
  const st = await loadState(env);
  const now = localNow();
  const nowMs = Date.now();
  const errors = [];

  // Cambio giorno: archivia le rilevazioni del giorno precedente
  if (st.day !== now.day) {
    if (st.day && st.rows.length) {
      await env.STATE.put("log:" + st.day, JSON.stringify({ rows: st.rows, events: st.events }));
    }
    st.day = now.day;
    st.rows = [];
    st.events = {};
    st.energyEst = 0;
  }

  // Produzione del giorno stimata integrando la potenza (usata se il portale non la fornisce)
  const prev = st.prev;
  if (prev && readings.pv !== null && prev.pv !== null && prev.day === now.day) {
    const dtH = (nowMs - prev.ts) / 3600000;
    if (dtH > 0 && dtH <= 0.25) st.energyEst = (st.energyEst || 0) + ((prev.pv + readings.pv) / 2) * dtH;
  }
  st.energyEst = Math.round((st.energyEst || 0) * 1000) / 1000;
  const energy = readings.energy !== null ? readings.energy : st.energyEst;

  // Riga del foglio "Rilevazioni": [ora, batteria %, potenza kW, produzione giorno kWh dal portale, produzione stimata]
  st.rows.push([now.time, readings.soc, readings.pv, readings.energy, st.energyEst]);

  // Eventi giornalieri: si salva solo il primo di ogni tipo, mai sovrascritto
  if (!st.events.soc && readings.soc !== null && prev && prev.soc !== null && prev.soc < EVENT_SOC && readings.soc >= EVENT_SOC) {
    st.events.soc = now.time;
  }
  if (!st.events.kw && readings.pv !== null && readings.pv >= EVENT_PV_KW) st.events.kw = now.time;
  if (!st.events.kwh && energy >= EVENT_ENERGY_KWH) st.events.kwh = now.time;

  // Regole di notifica
  for (const rule of config.rules) {
    const v = readings[rule.metric];
    if (v === null || v === undefined) continue;
    const unitLabel = rule.metric === "soc" ? "%" : " kW";
    const text = `${rule.metric === "soc" ? "Batteria" : "Produzione FV"}: ${v}${unitLabel}`;
    if (rule.op === "cross") {
      const p = st.last[rule.id];
      const crossed = Number.isFinite(p) && ((p > rule.value && v <= rule.value) || (p < rule.value && v >= rule.value));
      try {
        if (crossed && rule.enabled) await notify(env, rule.title, text);
        st.last[rule.id] = v;
      } catch (e) {
        errors.push(e.message); // ritenta alla prossima esecuzione
      }
      continue;
    }
    const active = !!st.rules[rule.id];
    if (!active && triggered(rule, v)) {
      try {
        if (rule.enabled) await notify(env, rule.title, text);
        st.rules[rule.id] = true;
      } catch (e) {
        errors.push(e.message);
      }
    } else if (active && cleared(rule, v)) {
      st.rules[rule.id] = false;
    }
  }

  st.prev = { ts: nowMs, day: now.day, soc: readings.soc, pv: readings.pv };

  // Riepilogo giornaliero
  let summarySent = false;
  if (forceSummary || (config.summary.enabled && now.hour >= config.summary.hour && st.summarySent !== now.day)) {
    try {
      await notify(env, `Riepilogo fotovoltaico ${itDate(now.day)}`, summaryText(st));
      if (!forceSummary) st.summarySent = now.day;
      summarySent = true;
    } catch (e) {
      errors.push(e.message);
    }
  }

  await env.STATE.put("state", JSON.stringify(st));
  if (errors.length) throw new Error("Errori: " + errors.join(" | "));
  return { readings, ora: now, eventi: st.events, produzione_kwh: energy, riepilogo_inviato: summarySent };
}

// ---------- Archivio rilevazioni ----------
// Restituisce [{ day, rows, events }] in ordine di data, giorno corrente compreso
async function loadHistory(env, from, to) {
  const days = [];
  let cursor;
  do {
    const res = await env.STATE.list({ prefix: "log:", cursor });
    for (const k of res.keys) days.push(k.name.slice(4));
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  const st = await loadState(env);
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const selected = days.filter((d) => inRange(d) && d !== st.day).sort().slice(-400);
  const out = [];
  for (const d of selected) {
    const v = await env.STATE.get("log:" + d, { type: "json" });
    if (v) out.push({ day: d, rows: v.rows || [], events: v.events || {} });
  }
  if (st.day && inRange(st.day)) out.push({ day: st.day, rows: st.rows, events: st.events });
  return out;
}

const READING_HEADERS = ["Data", "Ora", "Batteria %", "Potenza FV kW", "Produzione giorno kWh (portale)", "Produzione giorno kWh (stimata)"];
const EVENT_HEADERS = ["Data", `Ora batteria ${EVENT_SOC}%`, `Ora prima potenza ${EVENT_PV_KW} kW`, `Ora primo ${EVENT_ENERGY_KWH} kWh prodotto`, "Produzione giorno kWh"];

function eventRow(h) {
  const last = h.rows[h.rows.length - 1];
  const energy = last ? (last[3] !== null && last[3] !== undefined ? last[3] : last[4]) : null;
  return [h.day, h.events.soc || "", h.events.kw || "", h.events.kwh || "", energy ?? ""];
}

function csv(rows) {
  return rows
    .map((r) => r.map((c) => (c === null || c === undefined ? "" : /[;"\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c).replace(".", ","))).join(";"))
    .join("\r\n");
}

// ---------- Generatore XLSX minimale (zip senza compressione) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomi UTF-8
    local.setUint16(8, 0, true); // nessuna compressione
    local.setUint16(10, 0, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, 0, true);
    cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function colName(i) {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
// Celle: { d: "AAAA-MM-GG" } data, { t: "HH:MM" } ora, numero, oppure testo
function cellXml(v, ref, header) {
  if (v === null || v === undefined || v === "") return "";
  if (header) return `<c r="${ref}" t="inlineStr" s="1"><is><t>${xmlEsc(v)}</t></is></c>`;
  if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return `<c r="${ref}" s="2"><v>${Date.UTC(y, m - 1, d) / 86400000 + 25569}</v></c>`;
  }
  if (/^\d{2}:\d{2}$/.test(v)) {
    const [h, mi] = v.split(":").map(Number);
    return `<c r="${ref}" s="3"><v>${(h * 60 + mi) / 1440}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
}
function sheetXml(rows, widths) {
  const body = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cellXml(v, colName(j) + (i + 1), i === 0)).join("")}</row>`)
    .join("");
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}
function buildXlsx(sheets) {
  const ns = "http://schemas.openxmlformats.org";
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${ns}/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, s.widths) })),
  ];
  return zip(files);
}

async function exportData(env, kind, from, to) {
  const hist = await loadHistory(env, from, to);
  const readings = [READING_HEADERS, ...hist.flatMap((h) => h.rows.map((r) => [h.day, ...r]))];
  const events = [EVENT_HEADERS, ...hist.map(eventRow)];
  if (kind === "xlsx") {
    return new Response(
      buildXlsx([
        { name: "Rilevazioni", rows: readings, widths: [12, 8, 12, 15, 30, 30] },
        { name: "Eventi giornalieri", rows: events, widths: [12, 18, 24, 26, 22] },
      ]),
      {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="fotovoltaico.xlsx"',
        },
      }
    );
  }
  const rows = kind === "eventi" ? events : readings;
  return new Response("﻿" + csv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind}.csv"` },
  });
}

// ---------- Pagina impostazioni ----------
function settingsPage(config, key, st, message, errors = []) {
  const k = encodeURIComponent(key);
  const unit = (r) => (r.metric === "soc" ? "%" : "kW");
  const opLabel = { "<": "sotto", ">": "sopra", ">=": "almeno", cross: "attraversa" };
  const rulesHtml = config.rules
    .map(
      (r) => `<fieldset>
  <legend><label><input type="checkbox" name="${r.id}_enabled" ${r.enabled ? "checked" : ""}> ${xmlEsc(r.title)}</label></legend>
  <label>Titolo messaggio <input type="text" name="${r.id}_title" value="${xmlEsc(r.title)}" maxlength="100"></label>
  <div class="row">
    <label>Soglia (${opLabel[r.op]}, ${unit(r)}) <input type="number" step="any" name="${r.id}_value" value="${r.value}" required></label>
    ${r.op === "cross" ? "" : `<label>Riarmo (${unit(r)}) <input type="number" step="any" name="${r.id}_reset" value="${r.reset}" required></label>`}
  </div>
</fieldset>`
    )
    .join("\n");
  const last = st && st.rows && st.rows[st.rows.length - 1];
  const ev = (st && st.events) || {};
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notifiche fotovoltaico</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--mut:#667085;--acc:#e08a00;--bd:#d9dde3}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--fg:#e8eaed;--mut:#9aa3af;--bd:#333a44}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:8px 0 16px}h2{font-size:1.1rem;margin:24px 0 8px}
fieldset{background:var(--card);border:1px solid var(--bd);border-radius:10px;margin:0 0 12px;padding:12px 14px}
legend{font-weight:600;padding:0 4px}
label{display:block;margin:6px 0;color:var(--mut);font-size:.9rem}
legend label{color:var(--fg);font-size:1rem;margin:0}
input[type=text],input[type=number]{display:block;width:100%;box-sizing:border-box;margin-top:2px;padding:8px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg);font-size:1rem}
input[type=checkbox]{width:18px;height:18px;vertical-align:-3px;accent-color:var(--acc)}
.row{display:flex;gap:12px}.row label{flex:1}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:1rem;font-weight:600;width:100%}
.msg{padding:10px 12px;border-radius:8px;margin-bottom:12px;background:#e6f4ea;color:#1e4620}
.err{background:#fdecea;color:#611a15}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 14px}
a{color:var(--acc)}ul{margin:4px 0;padding-left:20px}
</style></head><body><main>
<h1>Notifiche fotovoltaico</h1>
${message ? `<div class="msg">${xmlEsc(message)}</div>` : ""}
${errors.length ? `<div class="msg err">${errors.map(xmlEsc).join("<br>")}</div>` : ""}
<div class="card">
${last ? `Ultima rilevazione: <b>${xmlEsc(last[0])}</b> — batteria <b>${fmt(last[1], 0)}%</b>, potenza <b>${fmt(last[2])} kW</b>, oggi <b>${fmt(energyOf(st))} kWh</b>` : "Nessuna rilevazione oggi."}
<br>Oggi: batteria ${EVENT_SOC}% ${ev.soc ? "alle " + ev.soc : "—"} · ${EVENT_PV_KW} kW ${ev.kw ? "alle " + ev.kw : "—"} · ${EVENT_ENERGY_KWH} kWh ${ev.kwh ? "alle " + ev.kwh : "—"}
</div>
<form method="post" action="/impostazioni?key=${k}">
<h2>Notifiche a soglia</h2>
<p style="color:var(--mut);font-size:.9rem;margin-top:0">Togli la spunta per escludere una notifica. Il riarmo è il valore che va superato nell'altro verso perché la notifica possa ripartire.</p>
${rulesHtml}
<h2>Riepilogo giornaliero</h2>
<fieldset>
  <legend><label><input type="checkbox" name="summary_enabled" ${config.summary.enabled ? "checked" : ""}> Invia il riepilogo su Telegram</label></legend>
  <label>Ora di invio (0-23) <input type="number" name="summary_hour" min="0" max="23" value="${config.summary.hour}" required></label>
</fieldset>
<button type="submit">Salva</button>
</form>
<h2>Dati</h2>
<div class="card"><ul>
<li><a href="/export.xlsx?key=${k}">Scarica foglio Excel</a> (Rilevazioni + Eventi giornalieri)</li>
<li><a href="/rilevazioni.csv?key=${k}">Rilevazioni CSV</a> · <a href="/eventi.csv?key=${k}">Eventi giornalieri CSV</a></li>
<li><a href="/?key=${k}&summary=1">Invia ora il riepilogo di prova</a></li>
</ul></div>
</main></body></html>`;
}

const html = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).catch((e) => console.error(e.message)));
  },
  // Pagine protette da DEBUG_KEY:
  //   /impostazioni?key=XXX  -> pagina impostazioni notifiche
  //   /export.xlsx?key=XXX   -> foglio elettronico (opzionale &from=AAAA-MM-GG&to=AAAA-MM-GG)
  //   /rilevazioni.csv, /eventi.csv -> stessi dati in CSV
  //   ?key=XXX          -> dati letti dall'impianto (grezzi)
  //   ?key=XXX&list=1   -> elenco impianti (per trovare STATION_ID)
  //   ?key=XXX&diag=1   -> controllo delle credenziali ricevute (senza rivelarle)
  async fetch(request, env) {
    const url = new URL(request.url);
    const params = url.searchParams;
    if (!env.DEBUG_KEY || params.get("key") !== env.DEBUG_KEY) return new Response("Not found", { status: 404 });
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json" } });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/impostazioni") {
        if (request.method === "POST") {
          const { config, errors } = configFromForm(await request.formData());
          if (errors.length) {
            // Mostra di nuovo i valori inseriti insieme agli errori, senza salvare
            const shown = await loadConfig({ STATE: { get: async () => config } });
            return html(settingsPage(shown, env.DEBUG_KEY, await loadState(env), "", errors), 400);
          }
          await env.STATE.put("config", JSON.stringify(config));
          return html(settingsPage(await loadConfig(env), env.DEBUG_KEY, await loadState(env), "Impostazioni salvate."));
        }
        return html(settingsPage(await loadConfig(env), env.DEBUG_KEY, await loadState(env), ""));
      }
      const from = params.get("from") || undefined;
      const to = params.get("to") || undefined;
      if (path === "/export.xlsx") return await exportData(env, "xlsx", from, to);
      if (path === "/rilevazioni.csv") return await exportData(env, "rilevazioni", from, to);
      if (path === "/eventi.csv") return await exportData(env, "eventi", from, to);
    } catch (e) {
      return new Response(e.message, { status: 500 });
    }
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
      // &summary=1 invia subito il riepilogo giornaliero (registra anche una rilevazione)
      if (params.get("summary")) return json(await run(env, { forceSummary: true }));
      // &run=1 esegue subito lo stesso controllo del cron (può inviare notifiche) e mostra l'esito
      if (params.get("run")) return json(await run(env));
      const session = await getSession(env, true);
      return json(await fetchRaw(env, session));
    } catch (e) {
      return new Response(e.message, { status: 500 });
    }
  },
};
