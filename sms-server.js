const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
require('dotenv').config();

// 🛡️ SAFE REQUIRE FOR KENYA-UTILS (Prevents MODULE_NOT_FOUND crash)
let isValidKePhone;
try {
    const kenyaUtils = require('kenya-utils');
    isValidKePhone = kenyaUtils.isValidKePhone;
} catch (error) {
    console.log('⚠️ kenya-utils package not found. Using built-in fallback checker.');
    // Fallback: Validates 07... and 01... formats
    isValidKePhone = (phone) => /^(?:\+254|0)(?:7|1)\d{8}$/.test(phone);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- CONFIGURATION ---
const SMSGATE_USER = process.env.SMSGATE_USER;
const SMSGATE_PASS = process.env.SMSGATE_PASS;
const SMSGATE_URL = 'https://api.sms-gate.app/3rdparty/v1/messages';
const MONGODB_URI = process.env.MONGODB_URI;

let db, contacts, schedules, logs;

// --- DATABASE CONNECTION ---
async function connectDB() {
    if (!MONGODB_URI) {
        console.error("❌ MONGODB_URI is missing from Environment Variables");
        return;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db('sms-app'); 
        contacts = db.collection('contacts');
        schedules = db.collection('schedules');
        logs = db.collection('logs');
        console.log('✅ MongoDB Connected');
    } catch (err) {
        console.error('❌ MongoDB Connection Failed:', err.message);
    }
}
connectDB();

// ==========================================
// RANDOM NUMBER GENERATOR (Safaricom + Airtel, 07 + 01)
// ==========================================
const SAFARICOM_PREFIXES = [
    '070','071','072','074','0757','0758','0759','0768','0769','079',       // 07 range
    '0110','0111','0112','0113','0114','0115','0116','0117','0118','0119'   // 01 range
];

const AIRTEL_PREFIXES = [
    '073','0750','0751','0752','0753','0754','0755','0756','078',           // 07 range
    '0100','0101','0102','0103','0104','0105','0106','0107','0108','0109'   // 01 range
];

function randomKenyanNumber(network = 'both') {
    let pool;
    if (network === 'safaricom')   pool = SAFARICOM_PREFIXES;
    else if (network === 'airtel') pool = AIRTEL_PREFIXES;
    else                           pool = [...SAFARICOM_PREFIXES, ...AIRTEL_PREFIXES];

    const prefix = pool[Math.floor(Math.random() * pool.length)];
    const digitsLeft = 10 - prefix.length;

    let suffix = '';
    for (let i = 0; i < digitsLeft; i++) {
        suffix += Math.floor(Math.random() * 10);
    }
    return prefix + suffix;
}

// --- SERVE FRONTEND ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// API ROUTES
// ==========================================

app.get('/api/contacts', async (req, res) => {
    try {
        const list = await contacts.find({}).toArray();
        res.json({ contacts: list });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

app.post('/api/contacts', async (req, res) => {
    const { numbers } = req.body;
    if (!numbers || numbers.length === 0) return res.status(400).json({ error: 'No numbers provided' });

    try {
        const docs = numbers.map(n => ({ phone: n, created_at: new Date() }));
        await contacts.insertMany(docs);
        res.json({ success: true, message: `${numbers.length} numbers saved!` });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save contacts' });
    }
});

app.delete('/api/contacts/all', async (req, res) => {
    try {
        await contacts.deleteMany({}); 
        res.json({ success: true, message: 'All contacts deleted successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete contacts' });
    }
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
        await schedules.insertOne({
            message,
            numbers,
            scheduleTime: new Date(scheduleTime),
            status: 'pending',
            created_at: new Date()
        });
        res.json({ success: true, message: 'SMS Scheduled successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to schedule SMS' });
    }
});

app.get('/api/logs', async (req, res) => {
    try {
        const list = await logs.find({}).sort({ created_at: -1 }).limit(100).toArray();
        res.json({ logs: list });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

app.delete('/api/logs/all', async (req, res) => {
    try {
        await logs.deleteMany({}); 
        res.json({ success: true, message: 'All logs deleted successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete logs' });
    }
});

// 8. Generate random Kenyan numbers
app.post('/api/generate-numbers', (req, res) => {
    const { count = 10, network = 'both', exclude = [] } = req.body;
    const amount = Math.min(Math.max(parseInt(count) || 10, 1), 1000);

    const excludeSet = new Set(exclude.map(n => String(n).trim()).filter(Boolean));
    const result = new Set();
    let safety = 0;
    const maxAttempts = Math.max(amount * 100, 5000);
    
    while (result.size < amount && safety < maxAttempts) {
        const num = randomKenyanNumber(network);
        if (!excludeSet.has(num) && !result.has(num)) {
            result.add(num);
        }
        safety++;
    }

    res.json({ numbers: [...result], count: result.size });
});

// ==========================================
// CORE SMS LOGIC (SMSGATE)
// ==========================================
async function processSMS(numbers, message, type) {
    if (!SMSGATE_USER || !SMSGATE_PASS) {
        console.error('❌ SMSGate credentials missing in Render!');
        return;
    }

    for (const number of numbers) {
        if (typeof isValidKePhone === 'function' && !isValidKePhone(number)) {
            console.log(`⏭️ Skipping invalid format: ${number}`);
            await logs.insertOne({ 
                phone: number, message, status: 'skipped_invalid', type, created_at: new Date(), 
                error: 'Invalid Kenyan mobile number format' 
            });
            continue;
        }

        try {
            const auth = Buffer.from(`${SMSGATE_USER}:${SMSGATE_PASS}`).toString('base64');

            const response = await fetch(SMSGATE_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phoneNumbers: [number],
                    textMessage: { text: message },
                    withDeliveryReport: false
                })
            });

            const isSuccess = response.status === 202 || response.ok;
            let errorMsg = null;

            if (!isSuccess) {
                const data = await response.json().catch(() => ({}));
                errorMsg = JSON.stringify(data) || `HTTP ${response.status}`;
            }

            await logs.insertOne({ 
                phone: number, message, status: isSuccess ? 'success' : 'failed', type, created_at: new Date(), error: errorMsg
            });

        } catch (error) {
            await logs.insertOne({ 
                phone: number, message, status: 'failed', type, created_at: new Date(), error: 'Network error: ' + error.message 
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
        const now = new Date();
        const pendingSchedules = await schedules.find({ status: 'pending', scheduleTime: { $lte: now } }).toArray();

        for (const schedule of pendingSchedules) {
            await schedules.updateOne({ _id: schedule._id }, { $set: { status: 'processing' } });
            await processSMS(schedule.numbers, schedule.message, 'Scheduled');
            await schedules.updateOne({ _id: schedule._id }, { $set: { status: 'completed' } });
        }
    } catch (e) {
        console.error('Cron job error:', e.message);
    }
});

// --- START SERVER ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SMS Server running on port ${PORT}`));