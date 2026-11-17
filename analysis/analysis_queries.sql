-- Gym Crowd Tracker - data analysis queries (Part C / final report section 7)
-- Open gym_crowd_tracker.sqlite in DB Browser for SQLite -> Execute SQL -> paste and run.
-- Only completed visits (check_out_at IS NOT NULL) are analysed; open visits are still in progress.

-- Q1. At which hours do members usually arrive?  (decision: staffing, recommending quiet hours)
SELECT CAST(strftime('%H', check_in_at) AS INTEGER) AS hour, COUNT(*) AS visits
FROM checkin WHERE check_out_at IS NOT NULL
GROUP BY hour ORDER BY hour;

-- Q2. Which gym has the most recorded visits?  (decision: compare workload between gyms)
SELECT g.gym_name AS gym, COUNT(c.checkin_id) AS visits
FROM gym g LEFT JOIN checkin c ON c.gym_id = g.gym_id AND c.check_out_at IS NOT NULL
GROUP BY g.gym_id ORDER BY visits DESC, g.gym_name;

-- Q3. How long do completed visits last, by gym?  (decision: space use, equipment servicing)
-- julianday() gives days; * 1440 converts days to minutes (24 h * 60 min)
SELECT g.gym_name AS gym,
       ROUND(AVG((julianday(c.check_out_at) - julianday(c.check_in_at)) * 1440), 1) AS average_minutes
FROM gym g JOIN checkin c ON c.gym_id = g.gym_id
WHERE c.check_out_at IS NOT NULL
GROUP BY g.gym_id ORDER BY average_minutes DESC;

-- Extra: how many people are inside each gym right now (the live counter)
SELECT g.gym_name, COUNT(c.checkin_id) AS inside_now, g.capacity
FROM gym g LEFT JOIN checkin c ON c.gym_id = g.gym_id AND c.check_out_at IS NULL
GROUP BY g.gym_id;

-- Extra: how visits were closed (qr / manual / auto after 3 hours)
SELECT checkout_method, COUNT(*) FROM checkin WHERE check_out_at IS NOT NULL GROUP BY checkout_method;
