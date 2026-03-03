const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// HTTP + WEBSOCKET SERVER (same port)
// ============================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================
// IN-MEMORY STORAGE
// ============================================
const alerts = [];
const MAX_ALERTS = 500;
const ALERT_TTL = 5 * 60 * 1000;

const userPresence = new Map();
const PRESENCE_TTL = 15 * 1000;
const PRESENCE_CLEANUP_INTERVAL = 5 * 1000;

let alertIdCounter = Date.now();

// ============================================
// WEBSOCKET MANAGEMENT
// ============================================
const wsClients = new Set();
const wsStats = { connected: 0, peak: 0, totalBroadcasts: 0 };

wss.on('connection', (ws) => {
    wsClients.add(ws);
    wsStats.connected = wsClients.size;
    if (wsClients.size > wsStats.peak) wsStats.peak = wsClients.size;
    console.log(`[WS] + Client | Total: ${wsClients.size}`);

    ws.send(JSON.stringify({ type: 'connected', serverTime: Date.now() }));

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('close', () => {
        wsClients.delete(ws);
        wsStats.connected = wsClients.size;
        console.log(`[WS] - Client | Total: ${wsClients.size}`);
    });

    ws.on('error', () => {
        wsClients.delete(ws);
        wsStats.connected = wsClients.size;
    });
});

setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            wsClients.delete(ws);
            wsStats.connected = wsClients.size;
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);

function broadcastAlert(alert) {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({ type: 'alert', alert });
    let sent = 0;
    for (const ws of wsClients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
            sent++;
        }
    }
    wsStats.totalBroadcasts += sent;
}

// ============================================
// CLEANUP
// ============================================
setInterval(() => {
    const now = Date.now();
    while (alerts.length > 0 && now - alerts[0].timestamp > ALERT_TTL) {
        alerts.shift();
    }
    let cleaned = 0;
    for (const [key, user] of userPresence.entries()) {
        if (now - user.lastSeen > PRESENCE_TTL) {
            userPresence.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[CLEANUP] Removed ${cleaned} stale presence. Active: ${userPresence.size}`);
    }
}, PRESENCE_CLEANUP_INTERVAL);

// ============================================
// ROUTES
// ============================================
app.get('/', (req, res) => {
    res.json({
        service: 'Brainrot Notifier v2.2 (WebSocket)',
        status: 'online',
        stats: {
            alerts: alerts.length,
            activeUsers: userPresence.size,
            ws: { clients: wsStats.connected, peak: wsStats.peak, broadcasts: wsStats.totalBroadcasts },
            uptime: Math.floor(process.uptime()) + 's'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        alerts: alerts.length,
        activeUsers: userPresence.size,
        wsClients: wsStats.connected,
        wsPeak: wsStats.peak,
        timestamp: Date.now()
    });
});

// ============================================
// POST /alert — STORE + INSTANT WS BROADCAST
// ============================================
app.post('/alert', (req, res) => {
    try {
        const { brainrotName, value, serverId, placeId, brainrots, botId, players, priority, total_found } = req.body;

        if (!brainrotName || !serverId) {
            return res.status(400).json({ error: 'Missing required fields: brainrotName, serverId' });
        }

        const alert = {
            id: ++alertIdCounter,
            brainrotName,
            value: value || '0',
            serverId,
            placeId: placeId || '0',
            timestamp: Date.now(),
            brainrots: brainrots || [{ brainrotName, value: value || '0', priority: priority || 0 }],
            total_found: total_found || 1,
            botId: botId || null,
            players: players || 0,
        };

        alerts.push(alert);
        while (alerts.length > MAX_ALERTS) alerts.shift();

        broadcastAlert(alert);

        console.log(`[ALERT] ${brainrotName} +${(alert.brainrots.length - 1)} | ${value} | ${serverId.substring(0, 8)} | WS->${wsStats.connected}`);
        res.json({ success: true, id: alert.id });
    } catch (err) {
        console.error('[ALERT ERROR]', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// GET /alerts — POLLING FALLBACK
// ============================================
app.get('/alerts', (req, res) => {
    try {
        const since = parseInt(req.query.since) || 0;
        const filtered = alerts.filter(a => a.timestamp > since || a.id > since);
        res.json({ alerts: filtered, serverTime: Date.now(), count: filtered.length });
    } catch (err) {
        console.error('[ALERTS ERROR]', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// USER PRESENCE
// ============================================
app.post('/user-presence', (req, res) => {
    try {
        const { username, userId, jobId } = req.body;
        if (!userId || !jobId) return res.status(400).json({ error: 'Missing: userId, jobId' });

        const key = `${userId}-${jobId}`;
        const isNew = !userPresence.has(key);

        userPresence.set(key, {
            username: username || 'Unknown',
            userId: String(userId),
            jobId: String(jobId),
            lastSeen: Date.now()
        });

        if (isNew) {
            let serverCount = 0;
            for (const [, user] of userPresence.entries()) {
                if (user.jobId === String(jobId)) serverCount++;
            }
            console.log(`[PRESENCE] + ${username} (${userId}) -> ${jobId.substring(0, 8)} | ${serverCount} in server`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[PRESENCE POST ERROR]', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/user-presence', (req, res) => {
    try {
        const { jobId } = req.query;

        if (!jobId) {
            const allUsers = [];
            for (const [, user] of userPresence.entries()) {
                allUsers.push({ userId: user.userId, username: user.username, jobId: user.jobId, lastSeen: user.lastSeen });
            }
            return res.json({ users: allUsers, total: allUsers.length });
        }

        const users = [];
        const now = Date.now();
        for (const [, user] of userPresence.entries()) {
            if (user.jobId === String(jobId) && (now - user.lastSeen) < PRESENCE_TTL) {
                users.push({ userId: user.userId, username: user.username });
            }
        }
        res.json({ users });
    } catch (err) {
        console.error('[PRESENCE GET ERROR]', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/user-presence', (req, res) => {
    try {
        const { userId, jobId } = req.body;
        if (!userId || !jobId) return res.status(400).json({ error: 'Missing: userId, jobId' });

        const key = `${userId}-${jobId}`;
        const existed = userPresence.has(key);

        if (existed) {
            const user = userPresence.get(key);
            userPresence.delete(key);
            console.log(`[PRESENCE] - ${user.username} (${userId}) left ${jobId.substring(0, 8)}`);
        }

        res.json({ success: true, removed: existed });
    } catch (err) {
        console.error('[PRESENCE DELETE ERROR]', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// DEBUG
// ============================================
app.get('/debug/presence', (req, res) => {
    const data = {};
    for (const [, user] of userPresence.entries()) {
        if (!data[user.jobId]) data[user.jobId] = [];
        data[user.jobId].push({
            username: user.username, userId: user.userId,
            lastSeen: user.lastSeen, age: Math.floor((Date.now() - user.lastSeen) / 1000) + 's ago'
        });
    }
    res.json({ totalUsers: userPresence.size, servers: Object.keys(data).length, data });
});

app.get('/debug/alerts', (req, res) => {
    const now = Date.now();
    res.json({
        total: alerts.length,
        last1min: alerts.filter(a => now - a.timestamp < 60000).length,
        last5min: alerts.filter(a => now - a.timestamp < 300000).length,
        oldest: alerts.length > 0 ? new Date(alerts[0].timestamp).toISOString() : null,
        newest: alerts.length > 0 ? new Date(alerts[alerts.length - 1].timestamp).toISOString() : null,
        websocket: { clients: wsStats.connected, peak: wsStats.peak, broadcasts: wsStats.totalBroadcasts }
    });
});

// ============================================
// START
// ============================================
server.listen(PORT, () => {
    console.log(`Brainrot Notifier v2.2 on port ${PORT}`);
    console.log(`WebSocket: ws://0.0.0.0:${PORT}`);
    console.log(`Scanner POST /alert -> instant WS broadcast`);
    console.log(`Polling fallback: GET /alerts?since=ts`);
});
