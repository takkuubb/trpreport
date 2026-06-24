const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { execSync } = require('child_process');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3009;
const B = '/trpreport';
const RP_ID = process.env.RP_ID || 'app-ai.xvps.jp';
const RP_ORIGIN = process.env.RP_ORIGIN || 'https://app-ai.xvps.jp';
const upload = multer({ dest: '/tmp/trpreport_uploads/' });

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

function auth(req, res, next) { if (!req.session?.user) return res.status(401).json({ error: 'ログインが必要です' }); next(); }
function admin(req, res, next) { if (req.session?.user?.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' }); next(); }

// Pages
app.get(`${B}/`, (req, res) => { if (!req.session?.user) return res.redirect(`${B}/login`); res.sendFile(path.join(__dirname, 'views', 'app.html')); });
app.get(`${B}/login`, (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

// Auth
app.post(`${B}/api/auth/login`, (req, res) => {
  const u = db.authenticate(req.body.username, req.body.password);
  if (!u) return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません' });
  req.session.user = u; res.json({ success: true, user: u });
});
app.get(`${B}/api/auth/me`, (req, res) => res.json(req.session?.user ? { logged_in: true, user: req.session.user } : { logged_in: false }));
app.post(`${B}/api/auth/logout`, (req, res) => { req.session.destroy(); res.json({ success: true }); });

// Passkey
app.post(`${B}/api/passkey/register-options`, auth, async (req, res) => {
  try {
    const { generateRegistrationOptions } = await import('@simplewebauthn/server');
    const u = req.session.user;
    const existing = db.getPasskeysByUser(u.id);
    const options = await generateRegistrationOptions({
      rpName: 'Airbnb 分析レポート', rpID: RP_ID,
      userID: new TextEncoder().encode(String(u.id)),
      userName: u.username, userDisplayName: u.display_name,
      excludeCredentials: existing.map(k => ({ id: k.id, type: 'public-key' })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
    });
    req.session.pkChallenge = options.challenge;
    res.json(options);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${B}/api/passkey/register-verify`, auth, async (req, res) => {
  try {
    const { verifyRegistrationResponse } = await import('@simplewebauthn/server');
    const v = await verifyRegistrationResponse({
      response: req.body, expectedChallenge: req.session.pkChallenge,
      expectedOrigin: RP_ORIGIN, expectedRPID: RP_ID
    });
    if (v.verified && v.registrationInfo) {
      const ri = v.registrationInfo;
      db.savePasskey(req.session.user.id, ri.credentialID,
        Buffer.from(ri.credentialPublicKey).toString('base64'), ri.counter,
        req.body.deviceName || null);
      res.json({ success: true });
    } else res.status(400).json({ error: '検証失敗' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${B}/api/passkey/auth-options`, async (req, res) => {
  try {
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server');
    const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred' });
    req.session.pkChallenge = options.challenge;
    res.json(options);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post(`${B}/api/passkey/auth-verify`, async (req, res) => {
  try {
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');
    const pk = db.getPasskeyByCred(req.body.id);
    if (!pk) return res.status(400).json({ error: 'パスキー未登録' });
    const v = await verifyAuthenticationResponse({
      response: req.body, expectedChallenge: req.session.pkChallenge,
      expectedOrigin: RP_ORIGIN, expectedRPID: RP_ID,
      credential: { id: pk.id, publicKey: Buffer.from(pk.public_key, 'base64'), counter: pk.counter }
    });
    if (v.verified) {
      db.updatePasskeyCounter(req.body.id, v.authenticationInfo.newCounter);
      const u = db.getUser(pk.user_id);
      if (!u) return res.status(401).json({ error: '無効アカウント' });
      req.session.user = { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
      res.json({ success: true, user: req.session.user });
    } else res.status(400).json({ error: '認証失敗' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Passkey list / delete
app.get(`${B}/api/passkeys`, auth, (req, res) => {
  const pks = db.getPasskeysByUser(req.session.user.id);
  res.json(pks.map(p => ({ id: p.id, device_name: p.device_name, created_at: p.created_at })));
});
app.delete(`${B}/api/passkeys/:id`, auth, (req, res) => {
  db.deletePasskey(req.params.id, req.session.user.id);
  res.json({ success: true });
});

// Dashboard data
app.get(`${B}/api/listings`, auth, (req, res) => {
  if (req.session.user.role === 'admin') return res.json(db.listListings());
  res.json(db.getUserListings(req.session.user.id));
});

app.get(`${B}/api/months`, auth, (req, res) => res.json(db.getAvailableMonths()));

app.get(`${B}/api/data/:listingId/:yearMonth`, auth, (req, res) => {
  const d = db.getMonthlyData(req.params.listingId, req.params.yearMonth);
  if (!d) return res.status(404).json({ error: 'データなし' });
  const l = db.listListings().find(x => x.listing_id === req.params.listingId);
  res.json({ ...d, title: l?.title, nickname: l?.nickname });
});

app.get(`${B}/api/data/:listingId`, auth, (req, res) => {
  res.json(db.getMonthlyDataRange(req.params.listingId));
});

app.get(`${B}/api/overview/:yearMonth`, auth, (req, res) => {
  res.json(db.getMonthlyDataByMonth(req.params.yearMonth));
});

// AI Report
app.get(`${B}/api/ai-report/:listingId/:yearMonth/:type`, auth, async (req, res) => {
  const { listingId, yearMonth, type } = req.params;
  // Check cache
  const cached = db.getAiReport(listingId, yearMonth, type);
  if (cached && !req.query.regenerate) return res.json({ content: cached.content, cached: true });

  // Get data + prompt
  const data = db.getMonthlyData(listingId, yearMonth);
  if (!data) return res.status(404).json({ error: 'データなし' });
  const listing = db.listListings().find(x => x.listing_id === listingId);
  const promptRow = db.getPrompt(type);
  const userPrompt = promptRow?.system_prompt || db.DEFAULT_PROMPTS[type] || '';

  const dataStr = `物件: ${listing?.title || listingId} (${listing?.nickname || ''}, ${listing?.area || ''})\n期間: ${yearMonth}\n`
    + `予約数: ${data.reservations} (前年比: ${data.reservations_yoy || '-'})\n`
    + `予約額: ¥${data.revenue?.toLocaleString()} (前年比: ${data.revenue_yoy || '-'})\n`
    + `稼働泊数: ${data.booked_nights} (前年比: ${data.booked_nights_yoy || '-'})\n`
    + `ADR: ¥${data.adr?.toLocaleString()} (前年比: ${data.adr_yoy || '-'})\n`
    + `平均滞在日数: ${data.avg_stay_days} (前年比: ${data.avg_stay_days_yoy || '-'})\n`
    + `リードタイム: ${data.avg_lead_time}日 (前年比: ${data.avg_lead_time_yoy || '-'})\n`
    + `連絡率: ${data.contact_rate}% (前年比: ${data.contact_rate_yoy || '-'})\n`
    + `予約率: ${data.booking_rate}% (前年比: ${data.booking_rate_yoy || '-'})`;

  try {
    const systemMsg = `${db.SYSTEM_PROMPT}\n\n${userPrompt}`;
    const userMsg = `以下のデータを分析してレポートを作成してください。300文字程度で簡潔にまとめてください。\n\n${dataStr}`;
    const tmpPrompt = `/tmp/trpreport_prompt_${Date.now()}.txt`;
    fs.writeFileSync(tmpPrompt, `${systemMsg}\n\n${userMsg}`);
    let aiContent = null;
    try {
      const raw = execSync(
        `gsk summarize "${tmpPrompt}" --question "上記のプロンプトとデータに基づいて日本語でレポートを作成してください"`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
      // Extract 'answer:' portion from gsk output (JSON has "answer": "..." or stdout has answer: ...)
      try {
        const j = JSON.parse(raw);
        aiContent = j?.data?.result || null;
        if (aiContent) {
          // Extract after 'answer:' if present
          const aIdx = aiContent.indexOf('answer:');
          if (aIdx >= 0) aiContent = aiContent.substring(aIdx + 7).trim();
          // Remove trailing Source: lines
          aiContent = aiContent.replace(/\n*Source:.*$/s, '').trim();
        }
      } catch (_) {
        // Not JSON, try to find answer: in raw text
        const aIdx = raw.indexOf('answer:');
        if (aIdx >= 0) {
          aiContent = raw.substring(aIdx + 7).replace(/\n*Source:.*$/s, '').trim();
        } else {
          aiContent = raw;
        }
      }
    } catch (e2) {
      console.error('gsk summarize error:', e2.message);
    }
    try { fs.unlinkSync(tmpPrompt); } catch (_) {}

    if (!aiContent || aiContent.length < 30) {
      aiContent = generateTemplateReport(type, data, listing, yearMonth);
    }

    db.saveAiReport(listingId, yearMonth, type, aiContent);
    res.json({ content: aiContent, cached: false });
  } catch (e) {
    console.error('AI report error:', e.message);
    const fallback = generateTemplateReport(type, data, listing, yearMonth);
    db.saveAiReport(listingId, yearMonth, type, fallback);
    res.json({ content: fallback, cached: false });
  }
});


function generateTemplateReport(type, data, listing, ym) {
  const name = listing?.nickname || listing?.title || '対象物件';
  const convRate = (data.contact_rate * data.booking_rate / 100).toFixed(2);
  switch (type) {
    case 'summary':
      return `月間予約額¥${Number(data.revenue).toLocaleString()}（前年比${data.revenue_yoy||'-'}）、稼働${data.booked_nights}泊（${data.booked_nights_yoy||'-'}）。ADR¥${Number(data.adr).toLocaleString()}${data.adr_yoy?'(前年比'+data.adr_yoy+')':''}\n予約${data.reservations}件、成約率${convRate}%。運営側で稼働率向上の施策を進める。`;
    case 'funnel':
      return `連絡率${data.contact_rate}%（${data.contact_rate_yoy||'-'}）、予約率${data.booking_rate}%（${data.booking_rate_yoy||'-'}）、全体成約率${convRate}%。\n写真更新や説明文の最適化を運営側で検討する。`;
    case 'pricing':
      return `ADR¥${Number(data.adr).toLocaleString()}（${data.adr_yoy||'-'}）、リードタイム${data.avg_lead_time}日（${data.avg_lead_time_yoy||'-'}）。\n予約単価とタイミングのバランスを考慮した料金戦略を運営側で検討する。`;
    case 'trend':
      return `予約${data.reservations}件（${data.reservations_yoy||'-'}）、予約額¥${Number(data.revenue).toLocaleString()}（${data.revenue_yoy||'-'}）、稼働${data.booked_nights}泊（${data.booked_nights_yoy||'-'}）。\n前年比を踏まえた改善施策を運営側で進める。`;
    default: return 'レポート生成中...';
  }
}

// Admin: CSV Upload
app.post(`${B}/api/admin/csv`, auth, admin, upload.array('files', 20), (req, res) => {
  try {
    if (!req.files?.length) return res.status(400).json({ error: 'ファイルを選択してください' });
    const results = [];
    for (const file of req.files) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const r = db.importCSV(content, null, req.session.user.id, file.originalname);
        results.push({ file: file.originalname, ...r, success: true });
      } catch (e) {
        results.push({ file: file.originalname, error: e.message, success: false });
      } finally {
        try { fs.unlinkSync(file.path); } catch {}
      }
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get(`${B}/api/admin/uploads`, auth, admin, (req, res) => res.json(db.listUploads()));

// Admin: Users
app.get(`${B}/api/admin/users`, auth, admin, (req, res) => {
  const users = db.listUsers().map(u => {
    const listings = db.getUserListings(u.id);
    return { ...u, listings };
  });
  res.json(users);
});
app.post(`${B}/api/admin/users`, auth, admin, (req, res) => {
  try {
    const { username, password, display_name, role, listing_ids } = req.body;
    if (!username || !password || !display_name || !role) return res.status(400).json({ error: '全項目を入力してください' });
    const r = db.createUser(username, password, display_name, role);
    if (listing_ids?.length) db.setUserListings(r.lastInsertRowid, listing_ids);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'ユーザー名重複' : e.message }); }
});
app.put(`${B}/api/admin/users/:id`, auth, admin, (req, res) => {
  db.updateUser(req.params.id, req.body);
  if (req.body.listing_ids) db.setUserListings(req.params.id, req.body.listing_ids);
  res.json({ success: true });
});
app.delete(`${B}/api/admin/users/:id`, auth, admin, (req, res) => {
  db.deleteUser(req.params.id); res.json({ success: true });
});

// Admin: Prompts
app.get(`${B}/api/admin/prompts`, auth, admin, (req, res) => res.json(db.listPrompts()));
app.put(`${B}/api/admin/prompts/:type`, auth, admin, (req, res) => {
  db.updatePrompt(req.params.type, req.body.system_prompt);
  if (req.body.clear_cache) db.clearAiReports(null, null);
  res.json({ success: true });
});

// Init
db.getDb();

// Seed initial CSV if available
try {
  const csvPath = path.join(__dirname, '..', 'trpreport-2026-05.csv');
  const months = db.getAvailableMonths();
  if (months.length === 0 && fs.existsSync(csvPath)) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const r = db.importCSV(content, null, 1, 'trpreport-2026-05.csv');
    console.log(`Seeded initial data: ${r.imported} rows for ${r.yearMonth}`);
  }
} catch (e) { console.log('Initial seed skipped:', e.message); }

app.listen(PORT, '0.0.0.0', () => console.log(`Airbnb 分析レポート on http://0.0.0.0:${PORT}${B}/`));
