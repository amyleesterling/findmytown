#!/usr/bin/env node
// Seeds listing-history.json from the git history of listings.json (daily
// auto-refresh commits). The archive maps each home ever seen in the listings
// feed to its list price, so fetch-sold.js can show sale price vs list price
// after a home sells and drops out of the live feed.
// fetch-listings.js keeps the archive up to date on each daily run; this
// script only needs to be re-run to rebuild the archive from scratch.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

function historyKey(address, city) {
  return `${address}|${city}`.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function main() {
  const log = execSync('git log --reverse --format="%H|%cs" -- listings.json', {
    cwd: repoRoot, encoding: 'utf8'
  }).trim();
  if (!log) {
    console.error('No git history found for listings.json');
    process.exit(1);
  }

  const commits = log.split('\n').map(line => {
    const [sha, date] = line.split('|');
    return { sha, date };
  });
  console.log(`Walking ${commits.length} snapshots of listings.json...`);

  const history = {};
  let parsed = 0;
  for (const { sha, date } of commits) {
    let data;
    try {
      const json = execSync(`git show ${sha}:listings.json`, {
        cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
      });
      data = JSON.parse(json);
    } catch (e) {
      continue; // file missing or unparseable at this commit
    }
    if (!Array.isArray(data.listings)) continue;
    parsed++;

    for (const l of data.listings) {
      if (!l.address || !l.price) continue;
      const key = historyKey(l.address, l.city || '');
      const existing = history[key];
      if (!existing) {
        history[key] = {
          id: l.id,
          address: l.address,
          city: l.city,
          listPrice: l.price,
          origListPrice: l.price,
          firstSeen: date,
          lastSeen: date,
          priceHistory: [{ date, price: l.price, event: 'Listed' }],
          photoUrl: l.photoUrl || null,
          redfinUrl: l.redfinUrl || null,
        };
      } else {
        if (l.price !== existing.listPrice) {
          existing.priceHistory.push({ date, price: l.price, event: 'Price Changed' });
        }
        existing.listPrice = l.price;
        existing.lastSeen = date;
        if (l.photoUrl) existing.photoUrl = l.photoUrl;
        if (l.redfinUrl) existing.redfinUrl = l.redfinUrl;
      }
    }
  }

  const output = {
    homes: history,
    count: Object.keys(history).length,
    builtAt: new Date().toISOString(),
    snapshots: parsed,
  };
  const outPath = path.join(repoRoot, 'listing-history.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`Parsed ${parsed} snapshots, ${output.count} unique homes`);
  console.log(`Saved to ${outPath}`);
}

main();
