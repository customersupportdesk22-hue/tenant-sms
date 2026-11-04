const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');
const cron = require('node-cron');
require('dotenv').config();

// 🛡️ SAFE REQUIRE FOR KENYA-UTILS
let isValidKePhone;
try {
    const kenyaUtils = require('kenya-utils');
    isValidKePhone = kenyaUtils.isValidKePhone;
} catch (error) {
    console.log('⚠️ kenya-utils not found. Using fallback.');
    isValidKePhone = (phone) => /^(?:\+254|0)(?:7|1)\d{8}$/.test(phone);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- CONFIGURATION ---
const SMSGATE_USER = process.env.SMSGATE_USER;
const SMSGATE_PASS = process.env.SMSGATE_PASS;
const SMSGATE_URL = 'https://api.sms-gate.app/3rdparty/v1/messages';

// --- TURSO DATABASE CONNECTION ---
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// --- CREATE TABLES ON STARTUP ---
async function initDB() {
    try {
        // Run sequentially to prevent the Turso 400 Migration Error
        await db.execute("CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, created_at TEXT)");
        await db.execute("CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, numbers TEXT, schedule_time TEXT, status TEXT, created_at TEXT)");
        await db.execute("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, message TEXT, status TEXT, type TEXT, created_at TEXT, error TEXT)");
        
        console.log('✅ Turso Database Connected & Tables Ready');
    } catch (err) {
        console.error('❌ Turso Connection Failed:', err.message);
    }
}
initDB();

// ==========================================
// RANDOM NUMBER GENERATOR
// ==========================================
const SAFARICOM_PREFIXES = ['070','071','072','074','0757','0758','0759','0768','0769','079','0110','0111','0112','0113','0114','0115','0116','0117','0118','0119'];
const AIRTEL_PREFIXES = ['073','0750','0751','0752','0753','0754','0755','0756','078','0100','0101','0102','0103','0104','0105','0106','0107','0108','0109'];

function randomKenyanNumber(network = 'both') {
    let pool = network === 'safaricom' ? SAFARICOM_PREFIXES : network === 'airtel' ? AIRTEL_PREFIXES : [...SAFARICOM_PREFIXES, ...AIRTEL_PREFIXES];
    const prefix = pool[Math.floor(Math.random() * pool.length)];
    let suffix = '';
    for (let i = 0; i < (10 - prefix.length); i++) suffix += Math.floor(Math.random() * 10);
    return prefix + suffix;
}

// --- SERVE FRONTEND ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==========================================
// API ROUTES
// ==========================================

app.get('/api/contacts', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM contacts");
        res.json({ contacts: result.rows });
    } catch (e) { res.status(500).json({ error: 'Failed to fetch contacts' }); }
});

app.post('/api/contacts', async (req, res) => {
    const { numbers } = req.body;
    if (!numbers || numbers.length === 0) return res.status(400).json({ error: 'No numbers provided' });

    try {
        const now = new Date().toISOString();
        
        // INSERT OR IGNORE handles duplicate protection instantly in SQLite
        const statements = numbers.map(num => ({
            sql: 'INSERT OR IGNORE INTO contacts (phone, created_at) VALUES (?, ?)',
            args: [num, now]
        }));
        
        const result = await db.batch(statements, "write");
        
        const savedCount = result.reduce((acc, curr) => acc + curr.rowsAffected, 0);
        const skippedCount = numbers.length - savedCount;

        res.json({ success: true, message: `Saved ${savedCount} new numbers. (Skipped ${skippedCount} duplicates).` });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to save contacts' });
    }
});

app.delete('/api/contacts/all', async (req, res) => {
    try {
        await db.execute("DELETE FROM contacts");
        res.json({ success: true, message: 'All contacts deleted successfully!' });
    } catch (e) { res.status(500).json({ error: 'Failed to delete contacts' }); }
});

app.post('/api/send-now', async (req, res) => {
    const { message, numbers } = req.body;
    if (!message || !numbers) return res.status(400).json({ error: 'Missing data' });
    res.json({ success: true, message: 'Sending started in background' });
    processSMS(numbers, message, 'Manual');
});

app.post('/api/schedule', async (req, res) => {
    const { message, numbers, scheduleTime } = req.body;
    if (!message || !numbers || !scheduleTime) return res.status(400).json({ error: 'Missing data' });

    try {
        await db.execute({
            sql: 'INSERT INTO schedules (message, numbers, schedule_time, status, created_at) VALUES (?, ?, ?, ?, ?)',
            args: [message, JSON.stringify(numbers), new Date(scheduleTime).toISOString(), 'pending', new Date().toISOString()]
        });
        res.json({ success: true, message: 'SMS Scheduled successfully!' });
    } catch (e) { res.status(500).json({ error: 'Failed to schedule SMS' }); }
});

app.get('/api/logs', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM logs ORDER BY id DESC LIMIT 100");
        res.json({ logs: result.rows });
    } catch (e) { res.status(500).json({ error: 'Failed to fetch logs' }); }
});

app.delete('/api/logs/all', async (req, res) => {
    try {
        await db.execute("DELETE FROM logs");
        res.json({ success: true, message: 'All logs deleted successfully!' });
    } catch (e) { res.status(500).json({ error: 'Failed to delete logs' }); }
});

app.post('/api/generate-numbers', (req, res) => {
    const { count = 10, network = 'both', exclude = [] } = req.body;
    const amount = Math.min(Math.max(parseInt(count) || 10, 1), 5000);
    const excludeSet = new Set(exclude.map(n => String(n).trim()).filter(Boolean));
    const result = new Set();
    let safety = 0;
    
    while (result.size < amount && safety < Math.max(amount * 100, 5000)) {
        const num = randomKenyanNumber(network);
        if (!excludeSet.has(num) && !result.has(num)) result.add(num);
        safety++;
    }
    res.json({ numbers: [...result], count: result.size });
});

// ==========================================
// CORE SMS LOGIC
// ==========================================
async function processSMS(numbers, message, type) {
    if (!SMSGATE_USER || !SMSGATE_PASS) return console.error('❌ SMSGate credentials missing!');

    for (const number of numbers) {
        const now = new Date().toISOString();
        
        if (typeof isValidKePhone === 'function' && !isValidKePhone(number)) {
            await db.execute({
                sql: 'INSERT INTO logs (phone, message, status, type, created_at, error) VALUES (?, ?, ?, ?, ?, ?)',
                args: [number, message, 'skipped_invalid', type, now, 'Invalid Kenyan mobile number format']
            });
            continue;
        }

        try {
            const auth = Buffer.from(`${SMSGATE_USER}:${SMSGATE_PASS}`).toString('base64');
            const response = await fetch(SMSGATE_URL, {
                method: 'POST',
                headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumbers: [number], textMessage: { text: message }, withDeliveryReport: false })
            });

            const isSuccess = response.status === 202 || response.ok;
            let errorMsg = null;

            if (!isSuccess) {
                const data = await response.json().catch(() => ({}));
                errorMsg = JSON.stringify(data) || `HTTP ${response.status}`;
            }

            await db.execute({
                sql: 'INSERT INTO logs (phone, message, status, type, created_at, error) VALUES (?, ?, ?, ?, ?, ?)',
                args: [number, message, isSuccess ? 'success' : 'failed', type, now, errorMsg]
            });

        } catch (error) {
            await db.execute({
                sql: 'INSERT INTO logs (phone, message, status, type, created_at, error) VALUES (?, ?, ?, ?, ?, ?)',
                args: [number, message, 'failed', type, now, 'Network error: ' + error.message]
            });
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ==========================================
// CRON JOB
// ==========================================
cron.schedule('* * * * *', async () => {
    try {
        const now = new Date().toISOString();
        const result = await db.execute({
            sql: "SELECT * FROM schedules WHERE status = 'pending' AND schedule_time <= ?",
            args: [now]
        });

        for (const schedule of result.rows) {
            await db.execute({ sql: "UPDATE schedules SET status = 'processing' WHERE id = ?", args: [schedule.id] });
            
            const numbers = JSON.parse(schedule.numbers);
            await processSMS(numbers, schedule.message, 'Scheduled');

            await db.execute({ sql: "UPDATE schedules SET status = 'completed' WHERE id = ?", args: [schedule.id] });
        }
    } catch (e) { console.error('Cron job error:', e.message); }
});

// --- START SERVER ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SMS Server running on Turso at port ${PORT}`));