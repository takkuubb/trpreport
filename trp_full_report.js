const Database = require("better-sqlite3");
const db = new Database("trpreport.db");

const all = db.prepare(`
  SELECT l.listing_id, l.nickname, l.title, l.area,
    m.revenue, m.revenue_yoy, m.reservations, m.reservations_yoy,
    m.booked_nights, m.booked_nights_yoy, m.adr, m.adr_yoy,
    m.avg_stay_days, m.avg_stay_days_yoy, m.avg_lead_time, m.avg_lead_time_yoy,
    m.contact_rate, m.contact_rate_yoy, m.booking_rate, m.booking_rate_yoy
  FROM listings l
  JOIN monthly_data m ON l.listing_id = m.listing_id AND m.year_month = '2026-05'
  ORDER BY m.revenue DESC
`).all();

all.forEach((d, i) => {
  const name = (d.nickname || d.title || d.listing_id).substring(0, 30);
  const conv = (d.contact_rate * d.booking_rate / 100).toFixed(1);
  console.log(JSON.stringify({
    rank: i + 1, name, area: d.area,
    revenue: Math.round(d.revenue), revenue_yoy: d.revenue_yoy || "-",
    reservations: d.reservations, reservations_yoy: d.reservations_yoy || "-",
    nights: d.booked_nights, nights_yoy: d.booked_nights_yoy || "-",
    adr: Math.round(d.adr), adr_yoy: d.adr_yoy || "-",
    stay: d.avg_stay_days, stay_yoy: d.avg_stay_days_yoy || "-",
    lead: d.avg_lead_time, lead_yoy: d.avg_lead_time_yoy || "-",
    contact: d.contact_rate, contact_yoy: d.contact_rate_yoy || "-",
    booking: d.booking_rate, booking_yoy: d.booking_rate_yoy || "-",
    conv: conv + "%"
  }));
});
db.close();
