# FindMyTown

**Live site: https://amyleesterling.github.io/findmytown/**

North Shore and Greater Boston MA home search dashboard. Compare 39 towns by school ratings, tax rates, SAT scores, and distance to key destinations. Browse active Redfin listings on an interactive map.

## Features

- Interactive Leaflet map with town boundary choropleth (Niche grade, tax rate, schools, distance)
- Live Redfin single-family listings: $650K--$1.1M, 3+ bed, 1.5+ bath, 1,600+ sqft, 10K+ lot
- Heart/favorite listings with persistence across sessions (even if listings go off-market)
- Visited and dismissed listing tracking
- Town comparison table and bar charts
- Recently sold homes with stats
- Custom destination with driving distance estimates
- Full-text search across listing addresses and descriptions
- Daily auto-refresh via GitHub Actions (7am ET)

## Data Sources

- Listings: Redfin (live)
- Tax rates: MA Almanac FY2025
- School ratings: GreatSchools and Niche (2025--2026)
- SAT scores: MA DESE (2024--25)
- Town boundaries: NBLMC / MassGIS

## Stack

Vanilla HTML/CSS/JS, Leaflet.js, Node.js/Express (local dev server), GitHub Pages (deploy)
