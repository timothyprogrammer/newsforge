const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- In-memory store (persists while server runs) ---
let appSettings = {
  dashboardPassword: process.env.DASHBOARD_PASSWORD || 'admin123',
  gnewsApiKey: process.env.GNEWS_API_KEY || '',
  heygenApiKey: '',
  telegramBotToken: '',
  telegramChatId: ''
};

let scripts = [];
let videoJobs = [];

// Load settings from file if exists
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const SCRIPTS_FILE = path.join(__dirname, 'data', 'scripts.json');
const JOBS_FILE = path.join(__dirname, 'data', 'jobs.json');

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadData() {
  ensureDataDir();
  try { if (fs.existsSync(SETTINGS_FILE)) appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch(e) {}
  try { if (fs.existsSync(SCRIPTS_FILE)) scripts = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8')); } catch(e) {}
  try { if (fs.existsSync(JOBS_FILE)) videoJobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch(e) {}
}

function saveSettings() { ensureDataDir(); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); }
function saveScripts() { ensureDataDir(); fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(scripts, null, 2)); }
function saveJobs() { ensureDataDir(); fs.writeFileSync(JOBS_FILE, JSON.stringify(videoJobs, null, 2)); }

loadData();

// --- Auth middleware ---
function authCheck(req, res, next) {
  const pw = req.headers['x-dashboard-password'] || req.query.pw;
  if (pw === appSettings.dashboardPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// --- Auth endpoint ---
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === appSettings.dashboardPassword) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// --- Telegram helper ---
async function sendTelegram(message) {
  if (!appSettings.telegramBotToken || !appSettings.telegramChatId) return;
  try {
    const url = `https://api.telegram.org/bot${appSettings.telegramBotToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: appSettings.telegramChatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
}

// --- News API proxy ---
app.get('/api/news', authCheck, async (req, res) => {
  const { category = 'general', q = '' } = req.query;
  const apiKey = appSettings.gnewsApiKey;
  if (!apiKey) return res.status(400).json({ error: 'GNews API key not configured. Go to Settings tab.' });
  
  try {
    let url;
    if (q) {
      url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=20&apikey=${apiKey}`;
    } else {
      url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=20&apikey=${apiKey}`;
    }
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch news: ' + e.message });
  }
});

// --- Scripts CRUD ---
app.get('/api/scripts', authCheck, (req, res) => {
  res.json(scripts);
});

app.post('/api/scripts', authCheck, (req, res) => {
  const script = { ...req.body, id: Date.now().toString(), createdAt: new Date().toISOString() };
  scripts.unshift(script);
  saveScripts();
  sendTelegram(`📝 <b>Script Created</b>\n\nTopic: ${script.topic}\nScenes: ${script.scenes ? script.scenes.length : 0}\nTime: ${new Date().toLocaleString()}`);
  res.json(script);
});

app.put('/api/scripts/:id', authCheck, (req, res) => {
  const idx = scripts.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Script not found' });
  scripts[idx] = { ...scripts[idx], ...req.body };
  saveScripts();
  res.json(scripts[idx]);
});

app.delete('/api/scripts/:id', authCheck, (req, res) => {
  scripts = scripts.filter(s => s.id !== req.params.id);
  saveScripts();
  res.json({ success: true });
});

// --- HeyGen proxy endpoints ---
app.get('/api/heygen/avatars', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  try {
    const response = await fetch('https://api.heygen.com/v2/avatars', {
      headers: { 'X-Api-Key': appSettings.heygenApiKey }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'HeyGen API error: ' + e.message });
  }
});

app.get('/api/heygen/voices', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  try {
    const response = await fetch('https://api.heygen.com/v2/voices', {
      headers: { 'X-Api-Key': appSettings.heygenApiKey }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'HeyGen API error: ' + e.message });
  }
});

app.post('/api/heygen/generate', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  
  const { title, script_text, avatar_id, voice_id } = req.body;
  
  sendTelegram(`🔵 <b>Video Generation STARTED</b>\n\nTitle: ${title}\nAvatar: ${avatar_id}\nTime: ${new Date().toLocaleString()}`);
  
  try {
    const response = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: {
        'X-Api-Key': appSettings.heygenApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        video_inputs: [{
          character: {
            type: 'avatar',
            avatar_id: avatar_id,
            avatar_style: 'normal'
          },
          voice: {
            type: 'text',
            input_text: script_text,
            voice_id: voice_id
          }
        }],
        dimension: { width: 1920, height: 1080 }
      })
    });
    
    const data = await response.json();
    
    if (data.data && data.data.video_id) {
      const job = {
        id: Date.now().toString(),
        video_id: data.data.video_id,
        title,
        status: 'processing',
        createdAt: new Date().toISOString()
      };
      videoJobs.unshift(job);
      saveJobs();
      
      sendTelegram(`🟠 <b>Video Processing</b>\n\nTitle: ${title}\nVideo ID: ${data.data.video_id}\nStatus: Processing...\nTime: ${new Date().toLocaleString()}`);
      
      res.json({ success: true, video_id: data.data.video_id, job });
    } else {
      sendTelegram(`🔴 <b>Video Generation FAILED</b>\n\nTitle: ${title}\nError: ${JSON.stringify(data)}\nTime: ${new Date().toLocaleString()}`);
      res.status(400).json({ error: 'HeyGen generation failed', details: data });
    }
  } catch (e) {
    sendTelegram(`🔴 <b>Video Generation FAILED</b>\n\nTitle: ${title}\nError: ${e.message}\nTime: ${new Date().toLocaleString()}`);
    res.status(500).json({ error: 'HeyGen API error: ' + e.message });
  }
});

app.get('/api/heygen/status/:videoId', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  try {
    const response = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${req.params.videoId}`, {
      headers: { 'X-Api-Key': appSettings.heygenApiKey }
    });
    const data = await response.json();
    
    // Update job status
    const job = videoJobs.find(j => j.video_id === req.params.videoId);
    if (job && data.data) {
      const oldStatus = job.status;
      job.status = data.data.status;
      job.video_url = data.data.video_url || null;
      job.thumbnail_url = data.data.thumbnail_url || null;
      saveJobs();
      
      if (oldStatus !== 'completed' && data.data.status === 'completed') {
        sendTelegram(`🟢 <b>Video COMPLETE!</b>\n\nTitle: ${job.title}\nVideo ID: ${job.video_id}\n🔗 Download ready!\nTime: ${new Date().toLocaleString()}`);
      }
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'HeyGen API error: ' + e.message });
  }
});

app.get('/api/heygen/jobs', authCheck, (req, res) => {
  res.json(videoJobs);
});

// --- Settings ---
app.get('/api/settings', authCheck, (req, res) => {
  // Don't send full keys, mask them
  res.json({
    gnewsApiKey: appSettings.gnewsApiKey ? '••••' + appSettings.gnewsApiKey.slice(-4) : '',
    heygenApiKey: appSettings.heygenApiKey ? '••••' + appSettings.heygenApiKey.slice(-4) : '',
    telegramBotToken: appSettings.telegramBotToken ? '••••' + appSettings.telegramBotToken.slice(-6) : '',
    telegramChatId: appSettings.telegramChatId || '',
    dashboardPassword: '••••••'
  });
});

app.put('/api/settings', authCheck, (req, res) => {
  const { gnewsApiKey, heygenApiKey, telegramBotToken, telegramChatId, dashboardPassword } = req.body;
  if (gnewsApiKey && !gnewsApiKey.startsWith('••')) appSettings.gnewsApiKey = gnewsApiKey;
  if (heygenApiKey && !heygenApiKey.startsWith('••')) appSettings.heygenApiKey = heygenApiKey;
  if (telegramBotToken && !telegramBotToken.startsWith('••')) appSettings.telegramBotToken = telegramBotToken;
  if (telegramChatId) appSettings.telegramChatId = telegramChatId;
  if (dashboardPassword && !dashboardPassword.startsWith('••')) appSettings.dashboardPassword = dashboardPassword;
  saveSettings();
  
  // Test telegram if configured
  if (appSettings.telegramBotToken && appSettings.telegramChatId) {
    sendTelegram(`✅ <b>NewsForge Connected!</b>\n\nTelegram notifications are now active.\nTime: ${new Date().toLocaleString()}`);
  }
  
  res.json({ success: true, message: 'Settings saved' });
});

// --- Telegram test ---
app.post('/api/telegram/test', authCheck, async (req, res) => {
  if (!appSettings.telegramBotToken || !appSettings.telegramChatId) {
    return res.status(400).json({ error: 'Telegram not configured' });
  }
  await sendTelegram(`🧪 <b>Test Notification</b>\n\nNewsForge is connected and working!\nTime: ${new Date().toLocaleString()}`);
  res.json({ success: true });
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NewsForge running on port ${PORT}`);
});
