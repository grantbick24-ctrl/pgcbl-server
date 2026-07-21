# PGCBL Stats Server

Live stats API for the PGCBL Pitching Coach Dashboard.

## Endpoints
- GET /api/stats — returns all hitter and pitcher stats
- POST /api/refresh — force refresh (clears cache)

## Deploy on Railway
1. Connect this repo to Railway
2. It auto-deploys and runs server.js
3. Stats cache for 1 hour automatically
