#!/usr/bin/env node
// Fetches recently sold homes from Redfin's stingray GIS-CSV API and saves as static JSON.
// The JSON GIS endpoint doesn't return sold data properly, but the CSV endpoint does
// when using the sold_within_days parameter.
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOWN_IDS = {
  "Beverly": 1490, "Boxford": 36095, "Danvers": 36103, "Essex": 36111,
  "Gloucester": 6697, "Hamilton": 29750, "Ipswich": 36126, "Lynn": 9515,
  "Manchester-by-the-Sea": 29618, "Marblehead": 36132, "Middleton": 29803,
  "Nahant": 36139, "Newbury": 29796, "Peabody": 13521,
  "Rockport": 36156, "Rowley": 36157, "Salem": 15302, "Swampscott": 36170,
  "Topsfield": 36171, "Wenham": 29567,
  "Billerica": 29563, "Wilmington": 36184, "Burlington": 36100, "Bedford": 29655,
  "Reading": 36155, "Wakefield": 36174, "Woburn": 20294, "Winchester": 36186,
  "Lexington": 36128, "Saugus": 36162, "Melrose": 10229, "Malden": 9614,
  "Medford": 10142, "North Reading": 29768,
  "Arlington": 36088, "Concord": 29674, "Somerville": 16064, "Stoneham": 36168, "Lynnfield": 36131
};

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    https.get({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const loc = response.headers.location.startsWith('http')
          ? response.headers.location
          : `https://${parsedUrl.hostname}${response.headers.location}`;
        return fetchUrl(loc, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}: ${data.substring(0, 200)}`));
        else resolve(data);
      });
    }).on('error', reject);
  });
}

function formatPrice(amount) {
  if (!amount) return '$0';
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  return `$${(amount / 1000).toFixed(0)}K`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse CSV row handling quoted fields
function parseCSVRow(row) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// Parse sold date like "February-17-2026" to "2026-02-17"
function parseSoldDate(dateStr) {
  if (!dateStr) return null;
  const months = {
    January: '01', February: '02', March: '03', April: '04',
    May: '05', June: '06', July: '07', August: '08',
    September: '09', October: '10', November: '11', December: '12'
  };
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const month = months[parts[0]];
  if (!month) return null;
  return `${parts[2]}-${month}-${parts[1].padStart(2, '0')}`;
}

async function fetchTownSold(townName, regionId) {
  // gis-csv endpoint with sold_within_days=150 returns actual sold data
  // uipt=1 = single-family only
  const params = new URLSearchParams({
    al: '1',
    num_homes: '350',
    ord: 'redfin-recommended-asc',
    page_number: '1',
    sold_within_days: '150',
    uipt: '1',
    v: '8',
    region_id: String(regionId),
    region_type: '6',
  });

  const url = `https://www.redfin.com/stingray/api/gis-csv?${params.toString()}`;
  const csv = await fetchUrl(url, { 'Referer': 'https://www.redfin.com/' });

  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // First line is headers
  const headers = parseCSVRow(lines[0]);
  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });

  const homes = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVRow(lines[i]);
    // Skip disclaimer rows
    if (row[0] === 'In accordance with local MLS rules') continue;
    if (!row[colIdx['ADDRESS']]) continue;

    const price = parseInt(row[colIdx['PRICE']], 10) || 0;
    // Filter: $650K-$1.1M
    if (price < 650000 || price > 1100000) continue;

    const lat = parseFloat(row[colIdx['LATITUDE']]);
    const lon = parseFloat(row[colIdx['LONGITUDE']]);
    if (!lat || !lon) continue;

    const soldDate = parseSoldDate(row[colIdx['SOLD DATE']]);
    const sqft = parseInt(row[colIdx['SQUARE FEET']], 10) || 0;
    const lotSize = parseInt(row[colIdx['LOT SIZE']], 10) || 0;
    const dom = parseInt(row[colIdx['DAYS ON MARKET']], 10) || null;
    const beds = parseInt(row[colIdx['BEDS']], 10) || 0;
    const baths = parseFloat(row[colIdx['BATHS']]) || 0;
    const ppsqft = parseInt(row[colIdx['$/SQUARE FEET']], 10) || null;
    const redfinUrl = row[colIdx['URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)']];

    homes.push({
      address: row[colIdx['ADDRESS']] || 'Unknown',
      city: row[colIdx['CITY']] || townName,
      state: row[colIdx['STATE OR PROVINCE']] || 'MA',
      zip: row[colIdx['ZIP OR POSTAL CODE']] || '',
      lat,
      lon,
      salePrice: price,
      salePriceFormatted: formatPrice(price),
      soldDate,
      beds,
      baths,
      sqft,
      lotSqft: lotSize,
      priceSqft: ppsqft,
      dom,
      redfinUrl: redfinUrl || null,
      status: row[colIdx['STATUS']] || 'Sold',
      townMatch: townName,
    });
  }

  return homes;
}

async function main() {
  // Test with Beverly first
  console.log('Testing with Beverly (region_id=1490)...');
  const testResults = await fetchTownSold('Beverly', 1490);
  console.log(`  Beverly: ${testResults.length} sold homes found in price range`);
  if (testResults.length > 0) {
    const s = testResults[0];
    console.log(`  Sample: ${s.address}, ${s.city} — ${s.salePriceFormatted}, sold ${s.soldDate}, ${s.beds}bd/${s.baths}ba, ${s.sqft}sqft`);
  }

  // Fetch all towns
  console.log(`\nFetching sold homes from ${Object.keys(TOWN_IDS).length} towns...`);
  const allSold = [];
  const townEntries = Object.entries(TOWN_IDS);
  const townCounts = {};

  for (let i = 0; i < townEntries.length; i += 5) {
    const batch = townEntries.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(([name, id]) => fetchTownSold(name, id))
    );
    for (let j = 0; j < results.length; j++) {
      const [townName] = batch[j];
      if (results[j].status === 'fulfilled') {
        const homes = results[j].value;
        townCounts[townName] = homes.length;
        allSold.push(...homes);
      } else {
        townCounts[townName] = `ERROR: ${results[j].reason?.message}`;
        console.error(`  ${townName}: ${results[j].reason?.message}`);
      }
    }
    const batchNames = batch.map(([n]) => n).join(', ');
    console.log(`  Batch ${Math.floor(i / 5) + 1}: ${batchNames}`);
    if (i + 5 < townEntries.length) await sleep(400);
  }

  // Deduplicate by address+city (CSV doesn't have propertyId)
  const seen = new Set();
  const unique = allSold.filter(h => {
    const key = `${h.address}|${h.city}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nTotal: ${unique.length} unique sold homes (${allSold.length} before dedup)`);
  console.log('\nPer-town counts:');
  for (const [town, count] of Object.entries(townCounts).sort((a, b) => {
    const ac = typeof a[1] === 'number' ? a[1] : -1;
    const bc = typeof b[1] === 'number' ? b[1] : -1;
    return bc - ac;
  })) {
    console.log(`  ${town}: ${count}`);
  }

  // Price stats
  if (unique.length > 0) {
    const prices = unique.map(h => h.salePrice).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    console.log(`\nPrice stats: median ${formatPrice(median)}, avg ${formatPrice(avg)}, range ${formatPrice(prices[0])}-${formatPrice(prices[prices.length - 1])}`);
  }

  // Save output
  const output = {
    sold: unique,
    count: unique.length,
    fetchedAt: new Date().toISOString(),
    soldWithinDays: 150,
    priceRange: { min: 650000, max: 1100000 },
    filter: 'single-family only',
  };

  const json = JSON.stringify(output);
  const publicDir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const publicPath = path.join(publicDir, 'sold.json');
  const rootPath = path.join(__dirname, '..', 'sold.json');
  fs.writeFileSync(publicPath, json);
  fs.writeFileSync(rootPath, json);
  console.log(`\nSaved to ${publicPath} and ${rootPath} (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
