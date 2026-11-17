'use strict';
// Simulated doorway beam counters (smart extension, Part D).
// Every 30 seconds writes one estimated-occupancy reading per gym into sensor_reading.
// Stop with Ctrl+C. Readings are labelled origin='simulation', quality_flag='simulated'.
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, nowLocal } = require('../lib/db');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'gym_crowd_tracker.sqlite');
const { q } = openDb(file);

function tick() {
  q.autoCheckout.run(nowLocal());
  const time = nowLocal();
  for (const g of q.gyms.all()) {
    const estimate = Math.max(0, g.inside + crypto.randomInt(-2, 3)); // counting noise of +/- 2 people
    q.insertReading.run(g.gym_id, time, estimate);
  }
  console.log(`${time}  7 simulated readings saved`);
}

tick();
setInterval(tick, 30e3);
