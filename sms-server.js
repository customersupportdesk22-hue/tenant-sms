const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const SMS8_API_KEY = process.env.SMS8_API_KEY;
const SMS8_API_URL = 'https://app.sms8.io/api/v1/messages';
const MONGODB_URI = process.env.MONGODB_URI;

let db, contacts, schedules, logs;

// Connect to Database
async function connectDB() {
    if (!MONGODB_URI) {
        console.error("❌ MONGODB_URI is missing from Render Environment Variables");
        return;
    }
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('sms-app'); // Creates a new database for this project
    contacts = db.collection('contacts');
    schedules = db.collection('schedules');
    logs = db.collection('logs');
    console.log('✅ MongoDB Connected');
}
connectDB();

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ROUTES ---
app.get('/api/contacts', async (req, res) => {
    const list = await contacts.find({}).toArray();
    res.json({ contacts: list });
});

app.post('/api/contacts', async (req, res) => {
    const { numbers } = req.body;
    if (!numbers || numbers.length === 0) return res.status(400).json({ error: 'No numbers provided' });

    const docs = numbers.map(n => ({ phone: n, created_at: new Date() }));
    await contacts.insertMany(docs);
    res.json({ success: true, message: `${numbers.length} numbers saved!` });
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

    await schedules.insertOne({
        message,
        numbers,
        scheduleTime: new Date(scheduleTime),
        status: 'pending',
        created_at: new Date()
    });
    res.json({ success: true, message: 'SMS Scheduled successfully!' });
});

app.get('/api/logs', async (req, res) => {
    const list = await logs.find({}).sort({ created_at: -1 }).limit(100).toArray();
    res.json({ logs: list });
});

// --- CORE LOGIC ---
async function processSMS(numbers, message, type) {
    for (const number of numbers) {
        try {
            const formData = new URLSearchParams();
            formData.append('key', SMS8_API_KEY);
            formData.append('messages', JSON.stringify([{ number, message, type: 'sms' }]));
            formData.append('option', '0');

            const response = await fetch(SMS8_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formData
            });
            const data = await response.json();

            const status = data.success ? 'success' : 'failed';
            await logs.insertOne({ phone: number, message, status, type, created_at: new Date(), error: data.error || null });

        } catch (error) {
            await logs.insertOne({ phone: number, message, status: 'failed', type, created_at: new Date(), error: 'Network error' });
        }
        // Wait 2 seconds before sending the next one
        await new Promise(r => setTimeout(r, 2000));
    }
}

// CRON JOB: Runs every minute to check for scheduled messages
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const pendingSchedules = await schedules.find({ status: 'pending', scheduleTime: { $lte: now } }).toArray();

    for (const schedule of pendingSchedules) {
        await schedules.updateOne({ _id: schedule._id }, { $set: { status: 'processing' } });
        await processSMS(schedule.numbers, schedule.message, 'Scheduled');
        await schedules.updateOne({ _id: schedule._id }, { $set: { status: 'completed' } });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 SMS Server running on port ${PORT}`));