// Server für die Sammelbestellungen-App.
// Speichert einen einzigen, gemeinsamen Zustand in Upstash Redis (kostenlose
// Cloud-Datenbank). Jeder, der den Link öffnet, sieht denselben Stand;
// Änderungen werden sofort in Redis gespeichert und von allen anderen
// Geräten per Polling (alle paar Sekunden) automatisch übernommen.
//
// Die Daten liegen komplett getrennt vom Server-Prozess: ein Redeploy oder
// Neustart auf Render verliert also NICHT mehr die Daten.

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Diese beiden Werte kommen aus dem Upstash-Dashboard (REST API Sektion)
// und werden als Umgebungsvariablen in Render eingetragen.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn(
    "WARNUNG: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN sind nicht gesetzt. " +
    "Die App kann keine Daten speichern, bis diese Umgebungsvariablen in Render hinterlegt sind."
  );
}

const REDIS_KEY = "sammelbestellung:state"; // ein einziger Schlüssel für den gesamten geteilten Zustand

// Kleiner Helper für Upstash REST-Aufrufe.
// Doku: https://upstash.com/docs/redis/features/restapi
async function redisCommand(commandArray) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commandArray),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstash-Fehler (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Upstash-Fehler: ${data.error}`);
  return data.result;
}

async function readStore() {
  const raw = await redisCommand(["GET", REDIS_KEY]);
  if (!raw) return { version: 0, state: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "number") return parsed;
  } catch (e) {
    /* kaputte Daten -> leer starten */
  }
  return { version: 0, state: null };
}

async function writeStore(store) {
  await redisCommand(["SET", REDIS_KEY, JSON.stringify(store)]);
}

app.use(express.json({ limit: "2mb" }));

// Diagnose-Endpunkt: zeigt, ob die Upstash-Variablen überhaupt gesetzt sind
// (ohne die echten Werte zu verraten) und ob die Verbindung tatsächlich
// funktioniert. Praktisch zum Debuggen über den Browser.
app.get("/api/debug", async (req, res) => {
  const info = {
    upstash_url_set: !!UPSTASH_URL,
    upstash_token_set: !!UPSTASH_TOKEN,
    upstash_url_preview: UPSTASH_URL ? UPSTASH_URL.slice(0, 30) + "..." : null,
  };
  try {
    const pong = await redisCommand(["PING"]);
    info.redis_connection = "OK";
    info.redis_ping_response = pong;
  } catch (e) {
    info.redis_connection = "FEHLER";
    info.redis_error = String(e.message || e);
  }
  res.json(info);
});

// GET: aktuellen Stand + Versionsnummer liefern
app.get("/api/state", async (req, res) => {
  try {
    const store = await readStore();
    res.json(store);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Konnte Daten nicht laden. Sind die Upstash-Umgebungsvariablen gesetzt?", details: String(e.message || e) });
  }
});

// PUT: neuen Stand speichern. Erhöht die Version, damit andere Clients
// per Polling merken, dass sich etwas geändert hat.
//
// Hinweis zu Nebenläufigkeit: bei wirklich zeitgleichen Schreibzugriffen von
// zwei Personen gewinnt schlicht der letzte Schreibvorgang ("last write
// wins"). Für eine kleine Gruppe, die nacheinander Produkte einträgt, ist
// das in der Praxis kein Problem.
app.put("/api/state", async (req, res) => {
  const { state: newState } = req.body || {};
  if (!newState || typeof newState !== "object") {
    return res.status(400).json({ error: "invalid state" });
  }

  try {
    const current = await readStore();
    const next = { version: current.version + 1, state: newState };
    await writeStore(next);
    res.json({ version: next.version });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Konnte Daten nicht speichern. Sind die Upstash-Umgebungsvariablen gesetzt?", details: String(e.message || e) });
  }
});

// Statische Dateien der App (HTML/JS/Icons/Manifest)
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Sammelbestellung-Server läuft auf Port ${PORT}`);
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    console.log("Upstash-Umgebungsvariablen sind gesetzt.");
  }
});
