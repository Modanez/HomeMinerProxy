# ADR-0006: Weekly Championship by Relative Luck and Persistent Farm Achievements

**English** · [Português](0006-weekly-championship-and-achievements.pt-BR.md)

- **Status:** Accepted
- **Date:** 2026-11-03

## Context
A home solo mining farm often mixes miners spanning 7 orders of magnitude in hashrate — from an ESP32/devkit at ~350 kH/s or an Odroid CPU at ~2.7 MH/s to a Bitaxe ASIC at ~1.2 TH/s.
1. If a weekly competition ranked workers by raw difficulty alone, the ASIC would win nearly every week, leaving slow hobbyist devices ("grandpa" miners) with no realistic shot at a trophy.
2. Furthermore, because finding a real Bitcoin block takes thousands of years on average for a home farm, users benefit from intermediate milestones (achievements) that celebrate real mining progress on the dashboard and via Telegram.

## Decision
1. **Weekly Championship Ranked by Relative Luck (`weeklyStandings` in [`src/luck.js`](../../src/luck.js))**:
   - [`src/proxy.js`](../../src/proxy.js) tracks per-worker weekly counters (`shares`, `work`, `best`, `bestAt`) keyed by the Monday ISO date (`weekKey(ms)`), automatically rolling over to `lastWeek` on Monday at 00:00 local time.
   - `weeklyStandings(weekObj, records)` ranks workers primarily by **relative luck factor** ($\text{best} / (W / \ln 2)$) for the week, and falls back to raw best difficulty when proxy work is unavailable. Because relative luck normalizes for total hashes performed, a 350 kH/s ESP32/devkit competes on equal footing with a 1.2 TH/s Bitaxe.
   - The current leader receives a `🏆` badge on Screen 1 ("Farm"), a full podium card on Screen 5 ("Luck"), `/campeonato` (`/championship`) in Telegram, and a Sunday winner announcement in the Telegram daily summary.
2. **Persistent Farm Achievements (`ACHIEVEMENTS`, `evaluateAchievements` in [`src/luck.js`](../../src/luck.js))**:
   - Define 10 bilingual milestones (`first_share`, `diff_1k`, `diff_1m`, `diff_1b`, `shares_1k`, `shares_100k`, `luck_2x`, `luck_10x`, `week_nonstop`, and `underdog` / "Grandpa Trophy").
   - Persist unlocked achievements in `DATA_DIR/achievements.json` (included in `/config` single-file backup/restore), render them on Screen 5 ("Luck"), expose `/conquistas` (`/achievements`) in Telegram, and send a real-time Telegram alert whenever a new achievement is unlocked.

## Consequences
- **Positive:** Every miner on the farm — regardless of hashrate — can win the weekly trophy, and milestones keep solo mining engaging day after day.
- **Negative:** Adds one small JSON file (`achievements.json`) to `DATA_DIR` and two additional fields (`week`, `lastWeek`) to `proxy-stats.json`.

