#!/usr/bin/env node
/**
 * build.js — bundles the Snake Watch design component into a single,
 * self-contained index.html (all JS, CSS, fonts, and images inlined).
 *
 * Source of truth:  "Snake Watch.dc.html"
 * Output:           index.html   (do NOT hand-edit — it is generated)
 *
 * Run with:  npm run bundle
 */

const Inliner = require('inliner');
const fs = require('fs');

const SOURCE = 'Snake Watch.dc.html';
const OUTPUT = 'index.html';

const options = {
  images: true,     // inline <img> (the Hidden Gem emblem) as data URIs
  nosvg: false,     // inline SVG assets too
  collapseWhitespace: false,
  preserveComments: true, // keep the <x-dc> structural comments intact
};

new Inliner(SOURCE, options, (err, html) => {
  if (err) {
    console.error('Bundle failed:', err);
    process.exit(1);
  }
  fs.writeFileSync(OUTPUT, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`Bundled ${SOURCE} -> ${OUTPUT} (${kb} KB)`);
});
