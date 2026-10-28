const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increased limit to handle large contact lists

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
        db = client.db('sms-app'); // Dedicated database for this project
        contacts = db.collection('contacts');
        schedules = db.collection('schedules');
        logs = db.collection('logs');
        console.log('✅ MongoDB Connected');
    } catch (err) {
        console.error('❌ MongoDB Connection Failed:', err.message);
    }
}
connectDB();

// --- SERVE FRONTEND ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// API ROUTES
// ==========================================

// 1. Get all contacts
app.get('/api/contacts', async (req, res) => {
    try {
        const list = await contacts.find({}).toArray();
        res.json({ contacts: list });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

// 2. Add bulk contacts
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

// 3. Delete ALL contacts
app.delete('/api/contacts/all', async (req, res) => {
    try {
        await contacts.deleteMany({}); 
        res.json({ success: true, message: 'All contacts deleted successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete contacts' });
    }
});

// 4. Send SMS Now (Manual)
app.post('/api/send-now', async (req, res) => {
    const { message, numbers } = req.body;
    if (!message || !numbers) return res.status(400).json({ error: 'Missing data' });
    
    // Respond immediately so the UI doesn't freeze
    res.json({ success: true, message: 'Sending started in background' });
    
    // Process in background
    processSMS(numbers, message, 'Manual');
});

// 5. Schedule SMS for Later
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

// 6. Get Logs for Frontend Dashboard
app.get('/api/logs', async (req, res) => {
    try {
        const list = await logs.find({}).sort({ created_at: -1 }).limit(100).toArray();
        res.json({ logs: list });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// 7. Delete ALL Logs (New Route)
app.delete('/api/logs/all', async (req, res) => {
    try {
        await logs.deleteMany({}); 
        res.json({ success: true, message: 'All logs deleted successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete logs' });
    }
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
        try {
            // Encode credentials for Basic Auth
            const auth = Buffer.from(`${SMSGATE_USER}:${SMSGATE_PASS}`).toString('base64');

            const response = await fetch(SMSGATE_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phoneNumbers: [number],
                    textMessage: { text: message }
                })
            });

            // SMSGate returns HTTP 202 (Accepted) for successful requests
            const isSuccess = response.status === 202 || response.ok;
            let errorMsg = null;

            if (!isSuccess) {
                const data = await response.json().catch(() => ({}));
                errorMsg = JSON.stringify(data) || `HTTP ${response.status}`;
                console.error(`Failed to send to ${number}:`, errorMsg);
            }

            // Save to database logs
            await logs.insertOne({ 
                phone: number, 
                message, 
                status: isSuccess ? 'success' : 'failed', 
                type, 
                created_at: new Date(), 
                error: errorMsg
            });

        } catch (error) {
            console.error(`Network error sending to ${number}:`, error.message);
            await logs.insertOne({ 
                phone: number, 
                message, 
                status: 'failed', 
                type, 
                created_at: new Date(), 
                error: 'Network error: ' + error.message 
            });
        }
        
        // 🛑 CRITICAL: Wait 3 seconds between messages to prevent carrier spam blocking
        await new Promise(r => setTimeout(r, 3000));
    }
}


// ==========================================
// CRON JOB: Check for Scheduled Messages
// ==========================================
// This runs silently in the background every single minute
cron.schedule('* * * * *', async () => {
    try {
        const now = new Date();
        // Find schedules that are 'pending' and whose time has passed
        const pendingSchedules = await schedules.find({ status: 'pending', scheduleTime: { $lte: now } }).toArray();

        for (const schedule of pendingSchedules) {
            // Mark as processing so it doesn't accidentally run twice
            await schedules.updateOne({ _id: schedule._id }, { $set: { status: 'processing' } });
            
            console.log(`⏰ Running scheduled SMS to ${schedule.numbers.length} people...`);
            
            // Send the messages
            await processSMS(schedule.numbers, schedule.message, 'Scheduled');

            // Mark as completed
            await schedules.updateOne({ _id: schedule._id }, { $set: { status: 'completed' } });
            console.log(`✅ Finished scheduled batch.`);
        }
    } catch (e) {
        console.error('Cron job error:', e.message);
    }
});


// --- START SERVER ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SMS Server running on port ${PORT}`));