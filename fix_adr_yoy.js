const Database = require("better-sqlite3");
const db = new Database("trpreport.db");

const rows = db.prepare("SELECT id, adr, adr_yoy FROM monthly_data WHERE adr_yoy IS NOT NULL AND adr_yoy != '' AND adr_yoy != '-'").all();
const update = db.prepare("UPDATE monthly_data SET adr_yoy=? WHERE id=?");
let fixed = 0;

for (const r of rows) {
  const raw = r.adr_yoy.replace(/[%,'"]/g, '').trim();
  const prevAdr = parseFloat(raw);
  if (isNaN(prevAdr) || !r.adr) continue;
  
  // If the "YoY" value is > 100, it's actually prev-year ADR in yen
  if (Math.abs(prevAdr) > 100) {
    const realPct = ((r.adr - prevAdr) / prevAdr * 100).toFixed(2);
    const newVal = realPct + '%';
    console.log(`  ${r.id}: ADR=¥${Math.round(r.adr)} "${r.adr_yoy}" → prev¥${Math.round(prevAdr)} → ${newVal}`);
    update.run(newVal, r.id);
    fixed++;
  }
}

console.log(`\nFixed ${fixed}/${rows.length} records`);

// Verify
const sample = db.prepare("SELECT listing_id, adr, adr_yoy FROM monthly_data WHERE adr_yoy IS NOT NULL AND adr_yoy != '' AND adr_yoy != '-' LIMIT 5").all();
sample.forEach(r => console.log(`  ${r.listing_id}: ADR=¥${Math.round(r.adr)} YoY=${r.adr_yoy}`));

db.close();
