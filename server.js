/**
 * GEO MIST Monitoring - Backend Server
 * ─────────────────────────────────────
 * Real-time IoT sensor data hub using:
 *   • Express  – REST API for sensor registration, history, schedules
 *   • ws       – WebSocket for live push to connected clients
 *   • Sensors POST their readings → server broadcasts to all app clients
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── In-memory store (replace with DB in production) ───────────────────────
const store = {
  sensors: {},          // { sensorId: { meta, latestReading } }
  history: {},          // { sensorId: [readings...] }
  alerts:  [],          // [{ id, type, message, sensorId, ts }]
  schedules: [],        // [{ id, zoneId, time, days, duration, enabled }]
  clients: new Set(),   // WebSocket clients (app users)
};

// Seed demo sensors
const DEMO_SENSORS = [
  { id: 'GMS-001', name: 'Basil Pot',       zone: 'A', plant: 'Basil',          type: 'multi' },
  { id: 'GMS-002', name: 'Tomato Bed',       zone: 'B', plant: 'Tomato',         type: 'multi' },
  { id: 'GMS-003', name: 'Orchid Shelf',     zone: 'C', plant: 'Orchid',         type: 'multi' },
  { id: 'GMS-004', name: 'Lettuce Row',      zone: 'A', plant: 'Lettuce',        type: 'multi' },
  { id: 'GMS-005', name: 'Wheat Field',      zone: 'B', plant: 'Wheat',          type: 'multi' },
  { id: 'GMS-006', name: 'Bell Pepper Pot',  zone: 'C', plant: 'Bell Pepper',    type: 'multi' },
];

DEMO_SENSORS.forEach(s => {
  store.sensors[s.id] = { meta: s, latestReading: generateReading(s.id) };
  store.history[s.id] = generateHistory(s.id, 48);
});

// Seed schedules
store.schedules = [
  { id: 'sch-1', zoneId: 'A', time: '06:00', days: ['Mon','Wed','Fri'], duration: 15, enabled: true },
  { id: 'sch-2', zoneId: 'B', time: '07:30', days: ['Tue','Thu','Sat'], duration: 20, enabled: true },
  { id: 'sch-3', zoneId: 'C', time: '08:00', days: ['Mon','Thu'],       duration: 10, enabled: false },
];

// ─── Reading helpers ────────────────────────────────────────────────────────
function generateReading(sensorId) {
  const bases = {
    'GMS-001': { temp: 23, humidity: 70, moisture: 65 },
    'GMS-002': { temp: 28, humidity: 58, moisture: 42 },
    'GMS-003': { temp: 21, humidity: 74, moisture: 60 },
    'GMS-004': { temp: 30, humidity: 55, moisture: 35 },
    'GMS-005': { temp: 25, humidity: 68, moisture: 72 },
    'GMS-006': { temp: 27, humidity: 63, moisture: 58 },
  };
  const b = bases[sensorId] || { temp: 24, humidity: 65, moisture: 55 };
  return {
    sensorId,
    temperature: +(b.temp  + (Math.random() - 0.5) * 2).toFixed(1),
    humidity:    +(b.humidity + (Math.random() - 0.5) * 3).toFixed(1),
    moisture:    +(b.moisture + (Math.random() - 0.5) * 4).toFixed(1),
    battery:     +(85 + Math.random() * 15).toFixed(0),
    rssi:        -1 * (45 + Math.floor(Math.random() * 30)),
    ts:          Date.now(),
  };
}

function generateHistory(sensorId, hours) {
  const history = [];
  const now = Date.now();
  for (let i = hours; i >= 0; i--) {
    const r = generateReading(sensorId);
    r.ts = now - i * 3600 * 1000;
    history.push(r);
  }
  return history;
}

function checkAlerts(reading) {
  const thresholds = { maxTemp: 29, minMoisture: 40, minHumidity: 55 };
  const alerts = [];
  const sensor = store.sensors[reading.sensorId]?.meta;

  if (reading.temperature > thresholds.maxTemp) {
    alerts.push({ id: `alrt-${Date.now()}-t`, type: 'critical', sensorId: reading.sensorId,
      message: `🌡️ High temp at ${sensor?.name || reading.sensorId}: ${reading.temperature}°C`, ts: Date.now() });
  }
  if (reading.moisture < thresholds.minMoisture) {
    alerts.push({ id: `alrt-${Date.now()}-m`, type: reading.moisture < 30 ? 'critical' : 'warning', sensorId: reading.sensorId,
      message: `💧 Low moisture at ${sensor?.name || reading.sensorId}: ${reading.moisture}%`, ts: Date.now() });
  }
  if (reading.humidity < thresholds.minHumidity) {
    alerts.push({ id: `alrt-${Date.now()}-h`, type: 'warning', sensorId: reading.sensorId,
      message: `💨 Low humidity at ${sensor?.name || reading.sensorId}: ${reading.humidity}%`, ts: Date.now() });
  }
  return alerts;
}

// ─── Broadcast to all connected app clients ─────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  store.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ─── WebSocket handler (app clients connect here) ───────────────────────────
wss.on('connection', (ws) => {
  store.clients.add(ws);
  console.log(`[WS] Client connected. Total: ${store.clients.size}`);

  // Send initial snapshot
  ws.send(JSON.stringify({
    event: 'snapshot',
    data: {
      sensors:   Object.values(store.sensors),
      alerts:    store.alerts.slice(-20),
      schedules: store.schedules,
    },
    ts: Date.now()
  }));

  ws.on('message', (raw) => {
    try {
      const { action, payload } = JSON.parse(raw);
      if (action === 'ack_alert') {
        store.alerts = store.alerts.filter(a => a.id !== payload.id);
        broadcast('alerts_updated', store.alerts.slice(-20));
      }
      if (action === 'toggle_schedule') {
        const sch = store.schedules.find(s => s.id === payload.id);
        if (sch) { sch.enabled = !sch.enabled; broadcast('schedules_updated', store.schedules); }
      }
      if (action === 'trigger_water') {
        broadcast('watering_triggered', { zoneId: payload.zoneId, ts: Date.now() });
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    store.clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${store.clients.size}`);
  });
});

// ─── REST API ────────────────────────────────────────────────────────────────

// GET all sensors
app.get('/api/sensors', (req, res) => {
  res.json(Object.values(store.sensors));
});

// GET sensor history
app.get('/api/sensors/:id/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const cutoff = Date.now() - hours * 3600 * 1000;
  const hist = (store.history[req.params.id] || []).filter(r => r.ts >= cutoff);
  res.json(hist);
});

// POST sensor reading (called by physical IoT sensor)
app.post('/api/ingest', (req, res) => {
  const reading = req.body;
  if (!reading.sensorId) return res.status(400).json({ error: 'sensorId required' });

  // Auto-register unknown sensor
  if (!store.sensors[reading.sensorId]) {
    store.sensors[reading.sensorId] = {
      meta: { id: reading.sensorId, name: reading.name || reading.sensorId, zone: reading.zone || 'Unknown', plant: reading.plant || 'Unknown', type: 'multi' },
      latestReading: reading,
    };
    store.history[reading.sensorId] = [];
  }

  reading.ts = Date.now();
  store.sensors[reading.sensorId].latestReading = reading;
  store.history[reading.sensorId].push(reading);

  // Trim history to 168 readings (7 days hourly)
  if (store.history[reading.sensorId].length > 168) store.history[reading.sensorId].shift();

  // Check alerts
  const newAlerts = checkAlerts(reading);
  if (newAlerts.length) {
    store.alerts.push(...newAlerts);
    if (store.alerts.length > 100) store.alerts = store.alerts.slice(-100);
    broadcast('new_alerts', newAlerts);
  }

  // Broadcast live reading
  broadcast('sensor_update', { sensor: store.sensors[reading.sensorId], reading });

  res.json({ ok: true, alerts: newAlerts.length });
});

// GET alerts
app.get('/api/alerts', (req, res) => res.json(store.alerts.slice(-50)));

// GET/PUT schedules
app.get('/api/schedules',     (req, res) => res.json(store.schedules));
app.post('/api/schedules',    (req, res) => {
  const sch = { id: `sch-${Date.now()}`, ...req.body, enabled: true };
  store.schedules.push(sch);
  broadcast('schedules_updated', store.schedules);
  res.json(sch);
});
app.patch('/api/schedules/:id', (req, res) => {
  const sch = store.schedules.find(s => s.id === req.params.id);
  if (!sch) return res.status(404).json({ error: 'Not found' });
  Object.assign(sch, req.body);
  broadcast('schedules_updated', store.schedules);
  res.json(sch);
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', sensors: Object.keys(store.sensors).length, clients: store.clients.size }));

// ─── Simulate sensor pushes every 5 seconds ──────────────────────────────────
setInterval(() => {
  Object.keys(store.sensors).forEach(id => {
    const reading = generateReading(id);
    store.sensors[id].latestReading = reading;
    store.history[id].push(reading);
    if (store.history[id].length > 168) store.history[id].shift();

    const newAlerts = checkAlerts(reading);
    if (newAlerts.length) {
      store.alerts.push(...newAlerts);
      broadcast('new_alerts', newAlerts);
    }
    broadcast('sensor_update', { sensor: store.sensors[id], reading });
  });
}, 5000);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`
╔══════════════════════════════════════╗
║     GEO MIST Backend  — v1.0         ║
║     http://localhost:${PORT}            ║
╠══════════════════════════════════════╣
║  REST  → /api/sensors                ║
║  REST  → /api/ingest   (POST)        ║
║  REST  → /api/alerts                 ║
║  REST  → /api/schedules              ║
║  WS    → ws://localhost:${PORT}         ║
╚══════════════════════════════════════╝
`));
