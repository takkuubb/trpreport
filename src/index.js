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
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'trpreport-session-secret-2026',
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
      rpName: '東方旅泊 Airbnb 分析レポート', rpID: RP_ID,
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

  // For detail type, include all months data
  let rangeData = [];
  if (type === 'detail') {
    rangeData = db.getMonthlyDataRange(listingId) || [];
  }

  const dataStr = type === 'detail'
    ? `物件: ${listing?.title || listingId} (${listing?.nickname || ''}, ${listing?.area || ''})\n`
      + `対象月: ${yearMonth}\n\n【月別実績推移】\n`
      + [...rangeData].sort((a,b) => b.year_month.localeCompare(a.year_month)).map(r =>
        `${r.year_month}: 予約額¥${Number(r.revenue||0).toLocaleString()} / ${r.reservations||0}件 / ADR¥${Number(r.adr||0).toLocaleString()} / ${r.booked_nights||0}泊 / 滞在${r.avg_stay_days||0}日 / 連絡率${r.contact_rate||0}% / 予約率${r.booking_rate||0}% / LT${r.avg_lead_time||0}日`
        + (r.revenue_yoy ? ` (予約額YoY:${r.revenue_yoy})` : '')
      ).join('\n')
    : `物件: ${listing?.title || listingId} (${listing?.nickname || ''}, ${listing?.area || ''})\n期間: ${yearMonth}\n`
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
      aiContent = generateTemplateReport(type, data, listing, yearMonth, listingId);
    }

    db.saveAiReport(listingId, yearMonth, type, aiContent);
    res.json({ content: aiContent, cached: false });
  } catch (e) {
    console.error('AI report error:', e.message);
    const fallback = generateTemplateReport(type, data, listing, yearMonth, listingId);
    db.saveAiReport(listingId, yearMonth, type, fallback);
    res.json({ content: fallback, cached: false });
  }
});


function generateTemplateReport(type, data, listing, ym, listingId) {
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
    case 'detail': {
      const rangeD = db.getMonthlyDataRange(listingId) || [];
      const sorted = rangeD.sort((a,b) => b.year_month.localeCompare(a.year_month));
      if (sorted.length < 2) return `${ym}の実績: 予約額¥${Number(data.revenue).toLocaleString()}、${data.reservations}件、ADR¥${Number(data.adr).toLocaleString()}。比較期間のデータ蓄積後に詳細トレンド分析を行う。`;
      const latest = sorted[0];
      const prev = sorted[1];
      return `直近${sorted.length}ヶ月の推移を確認。${latest.year_month}は予約額¥${Number(latest.revenue).toLocaleString()}（${latest.revenue_yoy||'-'}）、${prev.year_month}は¥${Number(prev.revenue).toLocaleString()}。ADRは¥${Number(latest.adr).toLocaleString()}→¥${Number(prev.adr).toLocaleString()}の推移。データ蓄積に伴い季節変動の把握と価格戦略の精度を高める。`;
    }
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

// Admin: Stay (payout) CSV Upload
app.post(`${B}/api/admin/stay-csv`, auth, admin, upload.array('files', 20), (req, res) => {
  try {
    const yearMonth = req.body.yearMonth;
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) return res.status(400).json({ error: '年月をYYYY-MM形式で指定してください' });
    if (!req.files?.length) return res.status(400).json({ error: 'ファイルを選択してください' });
    const results = [];
    for (const file of req.files) {
      try {
        const content = fs.readFileSync(file.path, 'utf-8');
        const r = db.importStayCSV(content, yearMonth, req.session.user.id, file.originalname);
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

// Admin: Portfolio Report
app.get(`${B}/api/admin/portfolio`, auth, admin, (req, res) => {
  res.json(db.getPortfolioSummary());
});
app.get(`${B}/api/admin/portfolio/:yearMonth`, auth, admin, (req, res) => {
  const ym = req.params.yearMonth;
  const listings = db.getMonthlyDataByMonth(ym);
  const areas = db.getAreaSummary(ym);
  const totals = db.getPortfolioSummary().find(r => r.year_month === ym) || {};
  res.json({ year_month: ym, totals, areas, listings });
});

// Admin: Portfolio AI Report
app.get(`${B}/api/admin/portfolio-ai/:yearMonth`, auth, admin, async (req, res) => {
  const ym = req.params.yearMonth;
  const cacheKey = 'PORTFOLIO';
  const cached = db.getAiReport(cacheKey, ym, 'portfolio');
  if (cached && !req.query.regenerate) return res.json({ content: cached.content, cached: true });

  const portfolio = db.getPortfolioSummary();
  const curMonth = portfolio.find(r => r.year_month === ym);
  if (!curMonth) return res.status(404).json({ error: 'データなし' });

  const listings = db.getMonthlyDataByMonth(ym);
  const areas = db.getAreaSummary(ym);
  const promptRow = db.getPrompt('portfolio');
  const userPrompt = promptRow?.system_prompt || db.DEFAULT_PROMPTS.portfolio || '';

  // Build rich data context
  const yoyPct = (cur, prev) => prev ? ((cur - prev) / prev * 100).toFixed(1) + '%' : '-';
  let dataStr = `=== ${ym} ポートフォリオ全体 ===\n`;
  dataStr += `総予約額: ¥${Number(curMonth.total_revenue).toLocaleString()} (前年同月: ${curMonth.yoy_revenue ? '¥'+Number(curMonth.yoy_revenue).toLocaleString() : '不明'}, YoY: ${yoyPct(curMonth.total_revenue, curMonth.yoy_revenue)})\n`;
  dataStr += `総稼働泊数: ${curMonth.total_nights}泊 (前年同月: ${curMonth.yoy_nights || '不明'}, YoY: ${yoyPct(curMonth.total_nights, curMonth.yoy_nights)})\n`;
  dataStr += `総予約件数: ${curMonth.total_reservations}件 (前年同月: ${curMonth.yoy_reservations || '不明'}, YoY: ${yoyPct(curMonth.total_reservations, curMonth.yoy_reservations)})\n`;
  dataStr += `平均ADR: ¥${Number(curMonth.avg_adr).toLocaleString()}\n`;
  dataStr += `稼働物件: ${curMonth.active_count}/${curMonth.listing_count}\n\n`;

  // Monthly trend
  dataStr += `=== 月次推移 ===\n`;
  for (const m of portfolio) {
    dataStr += `${m.year_month}: ¥${Number(m.total_revenue).toLocaleString()} / ${m.total_nights}泊 / ${m.total_reservations}件 / ADR¥${Number(m.avg_adr).toLocaleString()} / 稼働${m.active_count}件`;
    if (m.yoy_revenue) dataStr += ` (昨対予約額: ¥${Number(m.yoy_revenue).toLocaleString()}, YoY: ${yoyPct(m.total_revenue, m.yoy_revenue)})`;
    dataStr += '\n';
  }

  // Area breakdown
  dataStr += `\n=== エリア別 ===\n`;
  for (const a of areas) {
    const share = (a.total_revenue / (curMonth.total_revenue || 1) * 100).toFixed(1);
    dataStr += `${a.area}: ¥${Number(a.total_revenue).toLocaleString()} (${share}%) / ${a.total_nights}泊 / ${a.listing_count}物件(稼働${a.active_count}) / ADR¥${Number(a.avg_adr).toLocaleString()}\n`;
  }

  // Top 10 + Bottom 5 listings
  dataStr += `\n=== 売上TOP10 ===\n`;
  listings.slice(0, 10).forEach((l, i) => {
    const nm = l.nickname || l.title || l.listing_id;
    dataStr += `${i+1}. ${nm} (${l.area||'-'}): ¥${Number(l.revenue).toLocaleString()} YoY:${l.revenue_yoy||'-'} / ${l.reservations}件 / ${l.booked_nights}泊 / ADR¥${Number(l.adr).toLocaleString()} / 成約${(l.contact_rate*l.booking_rate/100).toFixed(1)}%\n`;
  });
  const activeLs = listings.filter(l => l.booked_nights > 0);
  const bottom5 = activeLs.slice(-5).reverse();
  dataStr += `\n=== 売上ワースト5 (稼働物件のみ) ===\n`;
  bottom5.forEach((l, i) => {
    const nm = l.nickname || l.title || l.listing_id;
    dataStr += `${i+1}. ${nm}: ¥${Number(l.revenue).toLocaleString()} YoY:${l.revenue_yoy||'-'} / ${l.booked_nights}泊 / ADR¥${Number(l.adr).toLocaleString()}\n`;
  });

  // YoY decline/growth
  const declined = listings.filter(l=>l.revenue_yoy&&parseFloat(l.revenue_yoy)<-15).sort((a,b)=>parseFloat(a.revenue_yoy)-parseFloat(b.revenue_yoy));
  const grown = listings.filter(l=>l.revenue_yoy&&parseFloat(l.revenue_yoy)>30).sort((a,b)=>parseFloat(b.revenue_yoy)-parseFloat(a.revenue_yoy));
  if (grown.length) { dataStr += `\n=== 成長物件 (YoY+30%以上) ===\n`; grown.slice(0,5).forEach(l => dataStr += `${l.nickname||l.listing_id}: ${l.revenue_yoy}\n`); }
  if (declined.length) { dataStr += `\n=== 下落物件 (YoY-15%以上) ===\n`; declined.slice(0,5).forEach(l => dataStr += `${l.nickname||l.listing_id}: ${l.revenue_yoy}\n`); }

  try {
    const systemMsg = `${db.SYSTEM_PROMPT}\n\n${userPrompt}`;
    const userMsg = `以下のポートフォリオ全体データを分析して、全体レポートを作成してください。500文字程度で、前年比を含めた分析をお願いします。\n\n${dataStr}`;
    const tmpPrompt = `/tmp/trpreport_portfolio_${Date.now()}.txt`;
    fs.writeFileSync(tmpPrompt, `${systemMsg}\n\n${userMsg}`);
    let aiContent = null;
    try {
      const raw = execSync(
        `gsk summarize "${tmpPrompt}" --question "上記のプロンプトとデータに基づいて日本語でポートフォリオ全体レポートを作成してください"`,
        { encoding: 'utf-8', timeout: 90000 }
      ).trim();
      try {
        const j = JSON.parse(raw);
        aiContent = j?.data?.result || null;
        if (aiContent) {
          const aIdx = aiContent.indexOf('answer:');
          if (aIdx >= 0) aiContent = aiContent.substring(aIdx + 7).trim();
          aiContent = aiContent.replace(/\n*Source:.*$/s, '').trim();
        }
      } catch (_) {
        const aIdx = raw.indexOf('answer:');
        if (aIdx >= 0) aiContent = raw.substring(aIdx + 7).replace(/\n*Source:.*$/s, '').trim();
        else aiContent = raw;
      }
    } catch (e2) { console.error('Portfolio AI error:', e2.message); }
    try { fs.unlinkSync(tmpPrompt); } catch (_) {}

    if (!aiContent || aiContent.length < 50) {
      // Template fallback
      const yoyRevStr = curMonth.yoy_revenue ? `前年同月¥${Number(curMonth.yoy_revenue).toLocaleString()}から${yoyPct(curMonth.total_revenue, curMonth.yoy_revenue)}の変動` : '前年データなし';
      aiContent = `${ym}の全体予約額は¥${Number(curMonth.total_revenue).toLocaleString()}（${yoyRevStr}）、総稼働${curMonth.total_nights}泊、予約${curMonth.total_reservations}件。平均ADR¥${Number(curMonth.avg_adr).toLocaleString()}。${areas[0]?.area||''}エリアが最大シェアで¥${Number(areas[0]?.total_revenue||0).toLocaleString()}。運営側で各エリアの稼働率向上と価格最適化を進めます。`;
    }
    db.saveAiReport(cacheKey, ym, 'portfolio', aiContent);
    res.json({ content: aiContent, cached: false });
  } catch (e) {
    console.error('Portfolio AI error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin: Listings
app.get(`${B}/api/admin/listings`, auth, admin, (req, res) => res.json(db.listListings()));
app.put(`${B}/api/admin/listings/:id`, auth, admin, (req, res) => {
  const { nickname, title, area, airbnb_url, image_url } = req.body;
  db.updateListing(req.params.id, { nickname, title, area, airbnb_url, image_url });
  res.json({ success: true });
});

// Fetch OGP image from Airbnb URL
app.post(`${B}/api/admin/listings/:id/fetch-image`, auth, admin, async (req, res) => {
  try {
    const listing = db.getListing(req.params.id);
    if (!listing?.airbnb_url) return res.status(400).json({ error: 'Airbnb URLが設定されていません' });
    const url = listing.airbnb_url;
    // Fetch HTML and extract og:image
    const html = execSync(`curl -sL -A "Mozilla/5.0" --max-time 15 "${url}"`, { encoding: 'utf-8', maxBuffer: 5*1024*1024 });
    const ogMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
      || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
    if (!ogMatch) return res.status(404).json({ error: 'OG画像が見つかりませんでした' });
    const imageUrl = ogMatch[1].replace(/&amp;/g, '&');
    db.updateListing(req.params.id, { image_url: imageUrl });
    res.json({ success: true, image_url: imageUrl });
  } catch (e) {
    console.error('OGP fetch error:', e.message);
    res.status(500).json({ error: '画像取得に失敗: ' + e.message.substring(0, 100) });
  }
});


// ====== Stay Records API ======
// Import stay data (JSON array)
app.post(`${B}/api/admin/stay/import`, auth, admin, (req, res) => {
  try {
    const { records, year_month } = req.body;
    if (!records?.length || !year_month) return res.status(400).json({ error: 'records配列とyear_monthが必要' });
    const count = db.importStayRecords(records, year_month);
    res.json({ success: true, imported: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get stay months

// Get listing IDs for owner-scoped queries (null for admin = no filter)
function getOwnerListingIds(req) {
  if (req.session.user.role === 'admin') return null;
  return db.getUserListings(req.session.user.id).map(l => l.listing_id);
}

app.get(`${B}/api/stay/months`, auth, (req, res) => {
  res.json(db.getStayMonths(getOwnerListingIds(req)));
});

// Get overall summary for a month
app.get(`${B}/api/stay/overall/:yearMonth`, auth, (req, res) => {
  const d = db.getStayOverall(req.params.yearMonth, getOwnerListingIds(req));
  if (!d) return res.status(404).json({ error: 'データなし' });
  res.json(d);
});

// Get per-listing summary
app.get(`${B}/api/stay/summary/:yearMonth`, auth, (req, res) => {
  res.json(db.getStaySummaryByListing(req.params.yearMonth, getOwnerListingIds(req)));
});

// Get nationality breakdown
app.get(`${B}/api/stay/nationality/:yearMonth`, auth, (req, res) => {
  const lid = req.query.listing_id;
  res.json(db.getStayNationalitySummary(req.params.yearMonth, lid || null, getOwnerListingIds(req)));
});

// Get records for a specific listing
app.get(`${B}/api/stay/records/:yearMonth/:listingId`, auth, (req, res) => {
  const ownerIds = getOwnerListingIds(req);
  if (ownerIds && !ownerIds.includes(req.params.listingId)) return res.status(403).json({ error: 'アクセス権限がありません' });
  res.json(db.getStayRecordsByListing(req.params.listingId, req.params.yearMonth));
});

// Get all records for a month
app.get(`${B}/api/stay/records/:yearMonth`, auth, (req, res) => {
  let records = db.getStayRecordsByMonth(req.params.yearMonth);
  const ownerIds = getOwnerListingIds(req);
  if (ownerIds) records = records.filter(r => ownerIds.includes(r.listing_id));
  res.json(records);
});


// Get nationality grouped by listing
app.get(`${B}/api/stay/nat-by-listing/:yearMonth`, auth, (req, res) => {
  const rows = db.getStayNatGroupByListing(req.params.yearMonth, getOwnerListingIds(req));
  // Group by listing_id
  const result = {};
  for (const r of rows) {
    if (!result[r.listing_id]) result[r.listing_id] = [];
    result[r.listing_id].push({ nationality: r.nationality, cnt: r.cnt });
  }
  res.json(result);
});


// Stay AI report per listing
app.get(`${B}/api/stay/ai/:listingId/:yearMonth`, auth, async (req, res) => {
  const { listingId, yearMonth } = req.params;
  // Owner check
  const ownerIds = getOwnerListingIds(req);
  if (ownerIds && !ownerIds.includes(listingId)) return res.status(403).json({ error: 'アクセス権限がありません' });

  // Check cache
  const cached = db.getAiReport(listingId, yearMonth, 'stay');
  if (cached && !req.query.regenerate) return res.json({ content: cached.content, cached: true });

  // Gather stay data
  const records = db.getStayRecordsByListing(listingId, yearMonth);
  const natData = db.getStayNationalitySummary(yearMonth, listingId);
  const listing = db.listListings().find(x => x.listing_id === listingId);
  if (!records.length) return res.status(404).json({ error: 'データなし' });

  const totalAmount = records.reduce((s,r) => s + r.amount, 0);
  const totalNights = records.reduce((s,r) => s + r.nights, 0);
  const totalGuests = records.reduce((s,r) => s + r.total_guests, 0);
  const totalAdults = records.reduce((s,r) => s + r.adults, 0);
  const totalChildren = records.reduce((s,r) => s + r.children, 0);
  const totalInfants = records.reduce((s,r) => s + r.infants, 0);
  const totalNetRev = records.reduce((s,r) => s + r.net_revenue, 0);
  const totalOwnerRev = records.reduce((s,r) => s + r.owner_revenue, 0);
  const totalCleanFee = records.reduce((s,r) => s + r.cleaning_fee, 0);
  const avgNightlyRate = totalNights > 0 ? Math.round(totalAmount / totalNights) : 0;

  const natStr = natData.map(n => `${n.nationality}: ${n.cnt}件(${(n.cnt/records.length*100).toFixed(1)}%) ${n.adults}A/${n.children}C/${n.infants}I`).join('\n');

  const dataStr = `物件: ${listing?.title || listingId} (${listing?.nickname || ''}, ${listing?.area || ''})
期間: ${yearMonth}
予約件数: ${records.length}件
総泊数: ${totalNights}泊
ゲスト合計: ${totalGuests}名 (大人${totalAdults}/子供${totalChildren}/幼児${totalInfants})
平均ゲスト数: ${(totalGuests/records.length).toFixed(1)}名/件
金額合計: ¥${totalAmount.toLocaleString()}
泊単価: ¥${avgNightlyRate.toLocaleString()}
清掃料金合計: ¥${totalCleanFee.toLocaleString()}
純売上: ¥${totalNetRev.toLocaleString()} (純売上率: ${(totalNetRev/totalAmount*100).toFixed(1)}%)
オーナー収益: ¥${totalOwnerRev.toLocaleString()} (収益率: ${(totalOwnerRev/totalAmount*100).toFixed(1)}%)

【国籍構成】
${natStr}

【個別予約明細】
${records.map(r => `${r.start_date} ${r.nights}泊 ${r.guest_name}(${r.nationality}) ${r.total_guests}名 ¥${r.amount.toLocaleString()}`).join('\n')}`;

  const promptRow = db.getPrompt('stay');
  const userPrompt = promptRow?.system_prompt || db.DEFAULT_PROMPTS.stay || '';

  try {
    const systemMsg = `${db.SYSTEM_PROMPT}\n\n${userPrompt}`;
    const userMsg = `以下の宿泊実績データを分析してレポートを作成してください。300文字程度で簡潔にまとめてください。\n\n${dataStr}`;
    const tmpPrompt = `/tmp/trpreport_stay_prompt_${Date.now()}.txt`;
    fs.writeFileSync(tmpPrompt, `${systemMsg}\n\n${userMsg}`);
    let aiContent = null;
    try {
      const raw = execSync(
        `gsk summarize "${tmpPrompt}" --question "上記のプロンプトとデータに基づいて日本語で宿泊実績分析レポートを作成してください"`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
      try {
        const j = JSON.parse(raw);
        aiContent = j?.data?.result || null;
        if (aiContent) {
          const aIdx = aiContent.indexOf('answer:');
          if (aIdx >= 0) aiContent = aiContent.substring(aIdx + 7).trim();
          aiContent = aiContent.replace(/\n*Source:.*$/s, '').trim();
        }
      } catch (_) {
        const aIdx = raw.indexOf('answer:');
        if (aIdx >= 0) aiContent = raw.substring(aIdx + 7).replace(/\n*Source:.*$/s, '').trim();
        else aiContent = raw;
      }
    } catch (e2) { console.error('gsk summarize error (stay):', e2.message); }
    try { fs.unlinkSync(tmpPrompt); } catch (_) {}

    if (!aiContent || aiContent.length < 30) {
      // Template fallback
      const jpCnt = natData.find(n => n.nationality === 'Japan')?.cnt || 0;
      const intlPct = records.length > 0 ? Math.round((records.length - jpCnt) / records.length * 100) : 0;
      const topNat = natData.slice(0, 3).map(n => n.nationality).join('・');
      aiContent = `${yearMonth}の宿泊実績は${records.length}件・${totalNights}泊、ゲスト${totalGuests}名です。泊単価¥${avgNightlyRate.toLocaleString()}、純売上¥${totalNetRev.toLocaleString()}（純売上率${(totalNetRev/totalAmount*100).toFixed(1)}%）。国籍構成はインバウンド比率${intlPct}%で、主要国籍は${topNat}です。平均ゲスト数${(totalGuests/records.length).toFixed(1)}名/件となっています。`;
    }

    db.saveAiReport(listingId, yearMonth, 'stay', aiContent);
    res.json({ content: aiContent, cached: false });
  } catch (e) {
    console.error('Stay AI report error:', e.message);
    const jpCnt = natData.find(n => n.nationality === 'Japan')?.cnt || 0;
    const intlPct = records.length > 0 ? Math.round((records.length - jpCnt) / records.length * 100) : 0;
    const fallback = `${yearMonth}は${records.length}件・${totalNights}泊。泊単価¥${avgNightlyRate.toLocaleString()}、純売上率${(totalNetRev/totalAmount*100).toFixed(1)}%。インバウンド${intlPct}%。`;
    db.saveAiReport(listingId, yearMonth, 'stay', fallback);
    res.json({ content: fallback, cached: false });
  }
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

app.listen(PORT, '0.0.0.0', () => console.log(`東方旅泊 Airbnb 分析レポート on http://0.0.0.0:${PORT}${B}/`));
