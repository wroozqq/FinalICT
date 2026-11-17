'use strict';
// Run any SQL query against the project database and print the result as a table.
//   npm run sql -- "SELECT gym_name, capacity FROM gym"
//   npm run sql                      (interactive: type a query, press Enter; empty line or Ctrl+C to quit)
// Handy at the defense: run an analysis query and change its GROUP BY live.
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'gym_crowd_tracker.sqlite');
const db = new DatabaseSync(file);

function run(sql) {
  const text = sql.trim();
  if (!text) return;
  try {
    const stmt = db.prepare(text);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(text)) {
      const rows = stmt.all();
      if (rows.length) console.table(rows); else console.log('(no rows)');
      console.log(`${rows.length} row(s)`);
    } else {
      const r = stmt.run();
      console.log(`OK, ${r.changes} row(s) changed`);
    }
  } catch (e) {
    console.log('SQL error:', e.message);
  }
}

const arg = process.argv.slice(2).join(' ');
if (arg) { run(arg); process.exit(0); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sql> ' });
console.log(`Connected to ${path.basename(file)}. Type a query and press Enter (empty line to quit).`);
rl.prompt();
rl.on('line', (line) => { if (!line.trim()) { rl.close(); return; } run(line); rl.prompt(); });
