const Database = require("better-sqlite3");
const db = new Database("trpreport.db");

const rows = db.prepare(`
  SELECT id, listing_id, year_month, revenue, revenue_yoy, booked_nights, booked_nights_yoy, adr, adr_yoy
  FROM monthly_data
  WHERE revenue > 0 AND booked_nights > 0
`).all();

const update = db.prepare("UPDATE monthly_data SET adr_yoy=? WHERE id=?");
let fixed = 0, cleared = 0;

for (const r of rows) {
  const revYoy = parseFloat((r.revenue_yoy || '').replace(/[%,'"]/g, ''));
  const nightsYoy = parseFloat((r.booked_nights_yoy || '').replace(/[%,'"]/g, ''));
  
  if (isNaN(revYoy) || isNaN(nightsYoy) || revYoy === -100 || nightsYoy === -100) {
    if (r.adr_yoy && r.adr_yoy !== '-') {
      update.run('-', r.id);
      cleared++;
    }
    continue;
  }
  
  const prevRev = r.revenue / (1 + revYoy / 100);
  const prevNights = r.booked_nights / (1 + nightsYoy / 100);
  if (prevNights <= 0) {
    update.run('-', r.id);
    cleared++;
    continue;
  }
  
  const prevAdr = prevRev / prevNights;
  const curAdr = r.revenue / r.booked_nights;
  const yoyPct = ((curAdr - prevAdr) / prevAdr * 100).toFixed(2);
  const newVal = yoyPct + '%';
  
  if (r.adr_yoy !== newVal) {
    update.run(newVal, r.id);
    fixed++;
  }
}

console.log(`Fixed: ${fixed}, Cleared: ${cleared}, Total checked: ${rows.length}`);

// Verify with samples
const samples = db.prepare(`
  SELECT m.listing_id, l.nickname, m.revenue, m.booked_nights, m.adr, m.adr_yoy,
         m.revenue_yoy, m.booked_nights_yoy
  FROM monthly_data m
  LEFT JOIN listings l ON m.listing_id = l.listing_id
  WHERE m.year_month = '2026-05' AND m.adr_yoy IS NOT NULL AND m.adr_yoy != '-'
  ORDER BY m.revenue DESC LIMIT 10
`).all();

console.log("\nVerification:");
for (const s of samples) {
  const revYoy = parseFloat(s.revenue_yoy.replace(/[%,'"]/g, ''));
  const nightsYoy = parseFloat(s.booked_nights_yoy.replace(/[%,'"]/g, ''));
  const prevRev = s.revenue / (1 + revYoy / 100);
  const prevNights = s.booked_nights / (1 + nightsYoy / 100);
  const prevAdr = prevRev / prevNights;
  console.log(`  ${(s.nickname||'?').substring(0,15)}: ADR=¥${Math.round(s.adr)} → prev ADR=¥${Math.round(prevAdr)} (${s.adr_yoy})`);
}

db.close();
