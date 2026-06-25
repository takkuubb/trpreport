const Database = require("better-sqlite3");
const { execSync } = require("child_process");
const db = new Database("/var/www/trpreport/trpreport.db");

const listings = db.prepare("SELECT listing_id, airbnb_url FROM listings WHERE image_url IS NULL OR image_url = ''").all();
console.log("Fetching OGP for", listings.length, "listings...");

const update = db.prepare("UPDATE listings SET image_url=? WHERE listing_id=?");
let ok = 0, fail = 0;

for (const l of listings) {
  try {
    const url = l.airbnb_url || ("https://www.airbnb.jp/rooms/" + l.listing_id);
    const html = execSync(`curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" --max-time 15 "${url}"`, {
      encoding: "utf-8", maxBuffer: 5 * 1024 * 1024
    });
    const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
      || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
    if (m) {
      const img = m[1].replace(/&amp;/g, "&");
      update.run(img, l.listing_id);
      ok++;
      console.log("  ✅", l.listing_id);
    } else {
      fail++;
      console.log("  ❌", l.listing_id, "no og:image found");
    }
  } catch (e) {
    fail++;
    console.log("  ❌", l.listing_id, e.message.substring(0, 80));
  }
}
console.log("Done: ok=" + ok, "fail=" + fail);
db.close();
