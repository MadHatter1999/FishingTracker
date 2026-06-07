<p align="center">
  <img src="public/fishing.png" alt="Nova Scotian Anglers Guild Project logo" width="120" height="120" />
</p>

<h1 align="center">Nova Scotian Anglers Guild Project</h1>

<p align="center">A useful fishing tool for shore anglers in Nova Scotia.</p>

It turns live tide, weather, and marine data into a daily fishing plan for any spot in the province,
starting from McCormacks Beach in Eastern Passage. It keeps a personal catch log that learns from your
own trips, a members-only login, and a live map where guild members appear as coloured hooks. It
installs to a phone like a normal app.

## What it does

- Live conditions: air and water temperature, wind and gusts, barometric pressure and its trend, wave
  height, tide state, moon phase and illumination, sunrise and sunset.
- A 0 to 10 fishing score for each day plus the best windows, worked out from tidal flow, dawn and dusk
  light, wind, waves, pressure trend, cloud cover, and spring/neap moon strength.
- Species forecast: encounter chance, catch chance, best time, best spot, rig, bait, size, eating
  quality, and NS retention legality.
- A tide chart with high and low markers, a "now" line, and the day's windows shaded in.
- An hourly breakdown with a colour rating and the reason behind each hour.
- Hotspot ranking that re-orders the boardwalk, points, seams, flats, and channel edges each day for
  wind shelter and current.
- Tactics and an action plan: setup, lure colours, bait, retrieval, and arrival and departure times.
- A catch log saved in your browser, with pattern analysis that ties your catches to tide stage, time
  of day, wind, moon, and weather. It exports and imports as JSON.
- A full text briefing you can copy in one tap.
- Members-only login. The whole app sits behind a sign-in.
- A live guild map. Turn on location sharing and the guild sees your hook move in near real time.
  Sharing is per device, off by default, and stops the moment you turn it off or close the app.
- Admin member management. The admin creates accounts, sets each member's hook colour, grants or
  revokes admin, and disables members. There is no self-registration.
- A live "you are here" hook that follows your GPS for orientation, plus a Find me button and a mobile
  fullscreen for the map, tide chart, and handbook.
- A built-in viewer for the official NS Anglers' Handbook PDF.
- Lake stocking from Nova Scotia open data: which species were stocked, how many, and when, with
  stocked species weighted up in the forecast.

## Guild membership

The app is members-only. The first admin is Tony, seeded once during the deploy steps below. The
default password is `fishon`; change it after first login under Members, Your account. Once signed in,
Tony adds the rest of the guild from the Members panel using a username and password (no email).

## Backends

The frontend talks to one of two interchangeable backends, picked automatically:

- Firebase (recommended, free). Used when Firebase config is present (`VITE_FIREBASE_*`). It runs on
  Firebase Hosting, Firebase Auth, and Cloud Firestore, all on the free Spark plan with no credit
  card. This is the hosted path.
- Self-hosted Node and SQLite. Used when no Firebase config is set. A small `server/` (its only
  dependency is `ws`; SQLite comes from Node's built-in `node:sqlite`) for local or offline-network
  use. See the self-hosted section below.

## Data sources (free, no API key)

- Tides: Fisheries and Oceans Canada / CHS IWLS API (Halifax gauge, station 00490, the same harbour
  system as Eastern Passage). It falls back to an approximate model if the API is unreachable, and
  flags that clearly.
- Weather and marine: Open-Meteo forecast and marine APIs (wind, pressure, cloud, precipitation, wave
  height, sea-surface temperature, sunrise and sunset).
- Moon phase and spring/neap strength: computed locally.
- Tagged ocean predators: OCEARCH named, satellite-tagged animals via the public Mapotic feed.
- Lake stocking: Nova Scotia open data "Fish Hatchery Stocking Records", matched to each lake by name
  and location. Verify the current
  [NS weekly stocking update](https://novascotia.ca/fish/sportfishing/hatchery-stocking/stocking-update/).

## Deploy to Firebase (free)

Everything here stays on the free Spark plan, so no billing account is needed.

1. Create the project and services in the Firebase console (console.firebase.google.com):
   - Create a project.
   - Build > Authentication > Get started > Sign-in method, then enable Email/Password.
   - Build > Firestore Database > Create database > Production mode (any region).
   - Project settings > General > Your apps > Web app (`</>`), register it, then copy the config.

2. Configure the app:
   ```bash
   npm install
   cp .env.example .env.local        # paste your VITE_FIREBASE_* values into .env.local
   ```

3. Seed the admin (Tony), one time:
   - Console > Project settings > Service accounts > Generate new private key, saved as
     `serviceAccountKey.json` in the project root.
   ```bash
   npm i -D firebase-admin
   node scripts/firebase-seed.mjs    # creates Tony / fishon (override with GUILD_ADMIN_USER / GUILD_ADMIN_PASSWORD)
   ```

4. Authenticate the Firebase CLI and deploy:
   ```bash
   npm i -g firebase-tools
   firebase login                    # opens a browser to sign in with your Google account
   firebase use --add                # pick your project (writes .firebaserc)
   npm run build                     # outputs dist/
   firebase deploy --only firestore:rules,hosting
   ```

Open the Hosting URL, sign in as Tony, and add your guild from the Members panel. Firebase Hosting is
HTTPS by default, so location sharing works for everyone. Use "Install app" in the browser to add the
PWA to a phone home screen.

If you are on a headless machine or a remote shell, use `firebase login --no-localhost` and paste the
code it gives you. For CI or scripts, create a token with `firebase login:ci` and pass it as
`firebase deploy --token "$FIREBASE_TOKEN"`.

On the Spark plan an admin can create members, set hook colours, grant or revoke admin, and disable
accounts, and members can change their own password. Admin password resets and hard account deletion
need the Blaze plan (still about $0 for a small guild); on Spark, disable and recreate instead.

## Run it locally

Against Firebase, using your `.env.local`:

```bash
npm run dev               # http://localhost:5180, talks to your Firebase project
```

### Self-hosted (Node and SQLite, no Firebase)

Leave `VITE_FIREBASE_*` unset and run the bundled server (its only dependency is `ws`; SQLite is
Node's built-in `node:sqlite`):

```bash
# Terminal 1: guild server on http://localhost:8787 (seeds Tony / fishon)
npm run server:install
npm run server
# Terminal 2: the app
npm run dev               # http://localhost:5180, auto-talks to localhost:8787
```

For production self-hosting, run `npm run build` then `npm start` to serve the PWA, API, and WebSocket
on one origin. Location sharing then needs HTTPS (a reverse proxy, or a host such as Render or Fly.io).

You can also run both halves in one terminal with `./dev.ps1` (Windows) or `./dev.sh` (macOS, Linux,
Git Bash, WSL); both shut down cleanly when stopped.

## Regulations

Retention guidance in the app is general. Always verify current DFO Maritimes recreational regulations
(open seasons, size and slot limits, daily limits, licences, barbless-hook rules) before keeping any
fish, and the NS Anglers' Handbook for inland waters. Mackerel, Atlantic cod and haddock (groundfish),
and striped bass are tightly and seasonally regulated. When in doubt, release.

## Project layout

```
src/
  config.ts            location, species DB, NS lakes, weather codes
  types.ts             shared domain types (GuildUser, AnglerPresence, etc.)
  data.ts              orchestrates the live fetch and merge
  services/            weather (Open-Meteo), tides (IWLS), astronomy (moon),
                       ocearch (tagged animals), stocking (NS open data),
                       api (backend facade), presence (live map),
                       firebase (init), firebase-backend (Auth + Firestore + presence)
  engine/              merge, scoring/windows, species, hotspots, tactics,
                       patterns (log analysis + catch-report blend), context, briefing
  store/log.ts         catch-log persistence (localStorage)
  ui/                  app shell, SVG charts, login, admin (Members panel), map
public/
  manifest.webmanifest, sw.js   PWA manifest and offline service worker
firebase.json          Firebase Hosting and Firestore config
firestore.rules        Firestore security rules (members, admin, presence, trips)
.env.example           Firebase web config template (copy to .env.local)
scripts/firebase-seed.mjs   one-time admin (Tony) seed via firebase-admin
server/                optional self-hosted backend (Node and SQLite, dep: ws)
  index.js             HTTP API and WebSocket live presence
  auth.js              scrypt password hashing and signed tokens (node:crypto)
  db.js                node:sqlite schema, admin seed, colour palette
```
