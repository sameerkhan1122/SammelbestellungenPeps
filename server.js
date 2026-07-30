// Einfacher Server für die Sammelbestellungen-App.
// Speichert einen einzigen, gemeinsamen Zustand in einer JSON-Datei auf der
// Festplatte des Servers. Jeder, der den Link öffnet, sieht denselben Stand;
// Änderungen werden sofort gespeichert und von allen anderen Geräten
// per Polling (alle paar Sekunden) automatisch übernommen.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Auf Render/Railway sollte ein "Persistent Disk"/Volume auf diesen Pfad
// gemountet werden, damit die Daten Deployments/Neustarts überleben.
// DATA_DIR kann per Umgebungsvariable überschrieben werden.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "state.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "number" && parsed.state) return parsed;
  } catch (e) {
    /* Datei existiert noch nicht oder ist kaputt -> leer starten */
  }
  return { version: 0, state: null };
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store), "utf8");
}

// Ein einfacher In-Memory-Cache + Datei-Schreiblock, damit gleichzeitige
// Schreibzugriffe von mehreren Nutzern sich nicht gegenseitig kaputt machen.
let store = readStore();
let writeQueue = Promise.resolve();

app.use(express.json({ limit: "2mb" }));

// GET: aktuellen Stand + Versionsnummer liefern
app.get("/api/state", (req, res) => {
  res.json(store);
});

// PUT: neuen Stand speichern. Erhöht die Version, damit andere Clients
// per Polling merken, dass sich etwas geändert hat.
app.put("/api/state", (req, res) => {
  const { state: newState } = req.body || {};
  if (!newState || typeof newState !== "object") {
    return res.status(400).json({ error: "invalid state" });
  }

  writeQueue = writeQueue.then(() => {
    store = { version: store.version + 1, state: newState };
    writeStore(store);
  });

  writeQueue.then(() => {
    res.json({ version: store.version });
  }).catch((e) => {
    res.status(500).json({ error: "write failed" });
  });
});

// Statische Dateien der App (HTML/JS/Icons/Manifest)
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Sammelbestellung-Server läuft auf Port ${PORT}`);
});
