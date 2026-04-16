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
  newsapiKey: '',
  heygenApiKey: '',
  telegramBotToken: '',
  telegramChatId: '',
  twitterApiKey: ''
};

let scripts = [];
let videoJobs = [];
let cachedTweets = [];

// File paths
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const SCRIPTS_FILE = path.join(__dirname, 'data', 'scripts.json');
const JOBS_FILE = path.join(__dirname, 'data', 'jobs.json');
const TWEETS_FILE = path.join(__dirname, 'data', 'tweets.json');

function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadData() {
  ensureDataDir();
  try { if (fs.existsSync(SETTINGS_FILE)) appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch(e) {}
  try { if (fs.existsSync(SCRIPTS_FILE)) scripts = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8')); } catch(e) {}
  try { if (fs.existsSync(JOBS_FILE)) videoJobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch(e) {}
  try { if (fs.existsSync(TWEETS_FILE)) cachedTweets = JSON.parse(fs.readFileSync(TWEETS_FILE, 'utf8')); } catch(e) {}
}

function saveSettings() { ensureDataDir(); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); }
function saveScripts() { ensureDataDir(); fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(scripts, null, 2)); }
function saveJobs() { ensureDataDir(); fs.writeFileSync(JOBS_FILE, JSON.stringify(videoJobs, null, 2)); }
function saveTweets() { ensureDataDir(); fs.writeFileSync(TWEETS_FILE, JSON.stringify(cachedTweets, null, 2)); }

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

// ============================================================
// NEWS SOURCES - GNews + NewsAPI + RSS Feeds
// ============================================================

// --- Simple XML RSS parser (no extra dependency) ---
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's'));
      return m ? m[1].trim() : '';
    };
    items.push({
      title: get('title'),
      description: get('description').replace(/<[^>]*>/g, '').substring(0, 300),
      url: get('link'),
      source: { name: '' },
      publishedAt: get('pubDate'),
      image: (block.match(/url="([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/) || [])[1] || null
    });
  }
  return items;
}

// RSS feed sources
const RSS_FEEDS = [
  { name: 'Fox News - Politics', url: 'https://moxie.foxnews.com/google-publisher/politics.xml' },
  { name: 'Fox News - World', url: 'https://moxie.foxnews.com/google-publisher/world.xml' },
  { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC US/Canada', url: 'http://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'NY Post', url: 'https://nypost.com/feed/' },
  { name: 'The Hill', url: 'https://thehill.com/feed/' },
  { name: 'Breitbart', url: 'https://feeds.feedburner.com/breitbart' },
  { name: 'Daily Mail', url: 'https://www.dailymail.co.uk/articles.rss' },
  { name: 'CNN World', url: 'http://rss.cnn.com/rss/edition_world.rss' },
];

async function fetchRSSFeeds(searchQuery = '') {
  const results = [];
  const feedPromises = RSS_FEEDS.map(async (feed) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(feed.url, {
        headers: { 'User-Agent': 'NewsForge/1.0' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      const xml = await response.text();
      const items = parseRSSItems(xml);
      items.forEach(item => { item.source.name = feed.name; });
      return items;
    } catch (e) {
      return [];
    }
  });

  const allFeeds = await Promise.allSettled(feedPromises);
  allFeeds.forEach(result => {
    if (result.status === 'fulfilled') results.push(...result.value);
  });

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    return results.filter(item =>
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
    );
  }
  return results;
}

async function fetchGNews(category = 'general', searchQuery = '') {
  const apiKey = appSettings.gnewsApiKey;
  if (!apiKey) return [];
  try {
    let url = searchQuery
      ? `https://gnews.io/api/v4/search?q=${encodeURIComponent(searchQuery)}&lang=en&max=10&apikey=${apiKey}`
      : `https://gnews.io/api/v4/top-headlines?category=${category}&lang=en&max=10&apikey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    return (data.articles || []).map(a => ({ ...a, _source: 'gnews' }));
  } catch (e) { return []; }
}

async function fetchNewsAPI(category = 'general', searchQuery = '') {
  const apiKey = appSettings.newsapiKey;
  if (!apiKey) return [];
  try {
    let url = searchQuery
      ? `https://newsapi.org/v2/everything?q=${encodeURIComponent(searchQuery)}&language=en&sortBy=publishedAt&pageSize=50&apiKey=${apiKey}`
      : `https://newsapi.org/v2/top-headlines?category=${category}&language=en&pageSize=50&apiKey=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();
    return (data.articles || []).map(a => ({
      title: a.title, description: a.description, url: a.url,
      image: a.urlToImage, publishedAt: a.publishedAt,
      source: { name: a.source?.name || 'NewsAPI' }, _source: 'newsapi'
    }));
  } catch (e) { return []; }
}

// --- Combined news endpoint ---
app.get('/api/news', authCheck, async (req, res) => {
  const { category = 'general', q = '', source = 'all' } = req.query;
  try {
    let articles = [];

    if (source === 'all' || source === 'rss') {
      const rss = await fetchRSSFeeds(q);
      articles.push(...rss.map(a => ({ ...a, _source: 'rss' })));
    }
    if (source === 'all' || source === 'gnews') {
      articles.push(...await fetchGNews(category, q));
    }
    if (source === 'all' || source === 'newsapi') {
      articles.push(...await fetchNewsAPI(category, q));
    }

    // Deduplicate
    const seen = new Set();
    articles = articles.filter(a => {
      if (!a.title) return false;
      const key = a.title.toLowerCase().substring(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort newest first
    articles.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    res.json({ articles, totalResults: articles.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch news: ' + e.message });
  }
});

// ============================================================
// TWITTER / X SCRAPER - via twitterapi.io
// ============================================================

function extractTweetData(t) {
  return {
    id: t.id || t.tweet_id,
    url: t.url || `https://x.com/i/status/${t.id || t.tweet_id}`,
    text: t.text || t.full_text || '',
    author: t.author?.userName || t.user?.screen_name || 'Unknown',
    authorName: t.author?.name || t.user?.name || 'Unknown',
    likes: t.likeCount || t.favorite_count || 0,
    retweets: t.retweetCount || t.retweet_count || 0,
    replies: t.replyCount || 0,
    views: t.viewCount || t.views || 0,
    hasVideo: !!(t.extendedEntities?.media?.some(m => m.type === 'video') || t.has_video),
    hasImage: !!(t.extendedEntities?.media?.some(m => m.type === 'photo') || t.has_media),
    mediaUrl: t.extendedEntities?.media?.[0]?.media_url_https || null,
    videoUrl: t.extendedEntities?.media?.[0]?.video_info?.variants?.find(v => v.content_type === 'video/mp4')?.url || null,
    createdAt: t.createdAt || t.created_at || '',
    scrapedAt: new Date().toISOString()
  };
}

app.post('/api/tweets/scrape', authCheck, async (req, res) => {
  if (!appSettings.twitterApiKey) {
    return res.status(400).json({ error: 'Twitter API key not configured. Get one at twitterapi.io and add it in Settings.' });
  }

  const { query = 'politics', queryType = 'Top', pages = 3 } = req.body;
  let allTweets = [];
  let cursor = '';

  try {
    for (let i = 0; i < pages; i++) {
      let url = `https://api.twitterapi.io/twitter/search?query=${encodeURIComponent(query)}&queryType=${queryType}`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const response = await fetch(url, {
        headers: { 'X-API-Key': appSettings.twitterApiKey }
      });
      const data = await response.json();

      if (data.tweets && data.tweets.length > 0) {
        allTweets.push(...data.tweets.map(extractTweetData));
      }

      cursor = data.next_cursor || data.cursor || '';
      if (!cursor) break;
      await new Promise(r => setTimeout(r, 500));
    }

    // Merge with cache (avoid duplicates)
    const existingIds = new Set(cachedTweets.map(t => t.id));
    const newTweets = allTweets.filter(t => !existingIds.has(t.id));
    cachedTweets = [...newTweets, ...cachedTweets].slice(0, 500);
    saveTweets();

    // Telegram alert for viral tweets
    const viralTweets = newTweets.filter(t => t.views >= 50000);
    if (viralTweets.length > 0) {
      sendTelegram(`🔥 <b>${viralTweets.length} Viral Tweet(s) Found!</b>\n\nQuery: "${query}"\nTop: ${viralTweets[0].views.toLocaleString()} views\n"${viralTweets[0].text.substring(0, 100)}..."\n\nTime: ${new Date().toLocaleString()}`);
    }

    res.json({ success: true, scraped: allTweets.length, newTweets: newTweets.length, total: cachedTweets.length });
  } catch (e) {
    res.status(500).json({ error: 'Twitter scrape failed: ' + e.message });
  }
});

app.get('/api/tweets', authCheck, (req, res) => {
  const { minViews = 0, hasVideo, sort = 'views' } = req.query;
  let filtered = [...cachedTweets];
  if (parseInt(minViews) > 0) filtered = filtered.filter(t => t.views >= parseInt(minViews));
  if (hasVideo === 'true') filtered = filtered.filter(t => t.hasVideo);
  if (sort === 'views') filtered.sort((a, b) => b.views - a.views);
  else if (sort === 'likes') filtered.sort((a, b) => b.likes - a.likes);
  else if (sort === 'recent') filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ tweets: filtered, total: filtered.length });
});

app.delete('/api/tweets', authCheck, (req, res) => {
  cachedTweets = [];
  saveTweets();
  res.json({ success: true });
});

// --- Auto-scraper: runs every 2 hours ---
const AUTO_SCRAPE_QUERIES = [
  'Trump', 'Iran', 'immigration breaking', 'Christians Muslims',
  'Sharia law', 'Congress breaking', 'Supreme Court', 'breaking news politics'
];

setInterval(async () => {
  if (!appSettings.twitterApiKey) return;
  console.log('[AutoScraper] Running...');
  for (const query of AUTO_SCRAPE_QUERIES) {
    try {
      const url = `https://api.twitterapi.io/twitter/search?query=${encodeURIComponent(query)}&queryType=Top`;
      const response = await fetch(url, { headers: { 'X-API-Key': appSettings.twitterApiKey } });
      const data = await response.json();
      if (data.tweets && data.tweets.length > 0) {
        const extracted = data.tweets.map(extractTweetData);
        const existingIds = new Set(cachedTweets.map(t => t.id));
        const newTweets = extracted.filter(t => !existingIds.has(t.id));
        cachedTweets = [...newTweets, ...cachedTweets].slice(0, 500);
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {}
  }
  saveTweets();
  console.log(`[AutoScraper] Done. ${cachedTweets.length} tweets cached.`);
}, 2 * 60 * 60 * 1000);

// ============================================================
// SCRIPTS CRUD
// ============================================================
app.get('/api/scripts', authCheck, (req, res) => { res.json(scripts); });

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

// ============================================================
// HEYGEN PROXY
// ============================================================
app.get('/api/heygen/avatars', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  try {
    const r = await fetch('https://api.heygen.com/v2/avatars', { headers: { 'X-Api-Key': appSettings.heygenApiKey } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: 'HeyGen API error: ' + e.message }); }
});

app.get('/api/heygen/voices', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  try {
    const r = await fetch('https://api.heygen.com/v2/voices', { headers: { 'X-Api-Key': appSettings.heygenApiKey } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: 'HeyGen API error: ' + e.message }); }
});

app.post('/api/heygen/generate', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  const { title, script_text, avatar_id, voice_id } = req.body;
  sendTelegram(`🔵 <b>Video Generation STARTED</b>\n\nTitle: ${title}\nTime: ${new Date().toLocaleString()}`);
  try {
    const r = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: { 'X-Api-Key': appSettings.heygenApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_inputs: [{ character: { type: 'avatar', avatar_id, avatar_style: 'normal' }, voice: { type: 'text', input_text: script_text, voice_id } }],
        dimension: { width: 1920, height: 1080 }
      })
    });
    const data = await r.json();
    if (data.data?.video_id) {
      const job = { id: Date.now().toString(), video_id: data.data.video_id, title, status: 'processing', createdAt: new Date().toISOString() };
      videoJobs.unshift(job);
      saveJobs();
      sendTelegram(`🟠 <b>Video Processing</b>\n\nTitle: ${title}\nVideo ID: ${data.data.video_id}\nTime: ${new Date().toLocaleString()}`);
      res.json({ success: true, video_id: data.data.video_id, job });
    } else {
      sendTelegram(`🔴 <b>Video FAILED</b>\n\nTitle: ${title}\nError: ${JSON.stringify(data)}`);
      res.status(400).json({ error: 'HeyGen generation failed', details: data });
    }
  } catch (e) {
    sendTelegram(`🔴 <b>Video FAILED</b>\n\nTitle: ${title}\nError: ${e.message}`);
    res.status(500).json({ error: 'HeyGen API error: ' + e.message });
  }
});

app.get('/api/heygen/status/:videoId', authCheck, async (req, res) => {
  if (!appSettings.heygenApiKey) return res.status(400).json({ error: 'HeyGen API key not configured' });
  try {
    const r = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${req.params.videoId}`, { headers: { 'X-Api-Key': appSettings.heygenApiKey } });
    const data = await r.json();
    const job = videoJobs.find(j => j.video_id === req.params.videoId);
    if (job && data.data) {
      const oldStatus = job.status;
      job.status = data.data.status;
      job.video_url = data.data.video_url || null;
      job.thumbnail_url = data.data.thumbnail_url || null;
      saveJobs();
      if (oldStatus !== 'completed' && data.data.status === 'completed') {
        sendTelegram(`🟢 <b>Video COMPLETE!</b>\n\nTitle: ${job.title}\n🔗 Download ready!\nTime: ${new Date().toLocaleString()}`);
      }
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: 'HeyGen API error: ' + e.message }); }
});

app.get('/api/heygen/jobs', authCheck, (req, res) => { res.json(videoJobs); });

// ============================================================
// SETTINGS
// ============================================================
app.get('/api/settings', authCheck, (req, res) => {
  res.json({
    gnewsApiKey: appSettings.gnewsApiKey ? '••••' + appSettings.gnewsApiKey.slice(-4) : '',
    newsapiKey: appSettings.newsapiKey ? '••••' + appSettings.newsapiKey.slice(-4) : '',
    heygenApiKey: appSettings.heygenApiKey ? '••••' + appSettings.heygenApiKey.slice(-4) : '',
    telegramBotToken: appSettings.telegramBotToken ? '••••' + appSettings.telegramBotToken.slice(-6) : '',
    telegramChatId: appSettings.telegramChatId || '',
    twitterApiKey: appSettings.twitterApiKey ? '••••' + appSettings.twitterApiKey.slice(-4) : '',
    dashboardPassword: '••••••'
  });
});

app.put('/api/settings', authCheck, (req, res) => {
  const fields = ['gnewsApiKey', 'newsapiKey', 'heygenApiKey', 'telegramBotToken', 'telegramChatId', 'twitterApiKey', 'dashboardPassword'];
  fields.forEach(f => {
    if (req.body[f] && !req.body[f].startsWith('••')) appSettings[f] = req.body[f];
  });
  saveSettings();
  if (appSettings.telegramBotToken && appSettings.telegramChatId) {
    sendTelegram(`✅ <b>NewsForge Settings Updated!</b>\nTime: ${new Date().toLocaleString()}`);
  }
  res.json({ success: true, message: 'Settings saved' });
});

app.post('/api/telegram/test', authCheck, async (req, res) => {
  if (!appSettings.telegramBotToken || !appSettings.telegramChatId) return res.status(400).json({ error: 'Telegram not configured' });
  await sendTelegram(`🧪 <b>Test Notification</b>\n\nNewsForge is connected!\nTime: ${new Date().toLocaleString()}`);
  res.json({ success: true });
});

// Fallback
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => {
  console.log(`NewsForge running on port ${PORT}`);
});
