# 🎱 Pool Queue

A live queue for the dorm pool table. People join from their phones, the winner stays on, and the loser goes back in line if they checked "put me back in line."

- `index.html` is the whole frontend (vanilla JS, polls every 3s)
- `api/queue.js` is one Vercel serverless function holding all the logic
- Storage is Upstash Redis (free tier, added from Vercel's Storage tab)

## Rules it enforces
- One spot per phone. You can't join twice.
- Only the two people currently playing can tap "X won," so random people can't skip the line.
- The winner keeps their seat and builds a streak. The next person in line steps up.
- The loser rejoins the back of the line if their "put me back" box is checked.
- An optional admin code unlocks setup tools: add people by name (to the back or front of the line), reorder the line, toggle anyone's requeue setting, remove people who walked off, report any result, and clear everything. People an admin adds don't need a phone.

## Singles and doubles
- The Singles / Doubles switch above the table sets the mode. Anyone can switch when the table and line are empty. An admin can switch anytime, but that clears the table and line.
- In doubles, one phone joins for a team: your name plus your partner's. The winning team stays on and the losing team rejoins together if their box is checked.
- "Clear everything" keeps the current mode.

## Player records
- No sign-up. A name gets a permanent record the first time it joins, and every win or loss is added to it. Names match regardless of capitals or extra spaces ("anna" = "Anna").
- Two people with the same name can't be in line at the same time, so records don't get mixed up.
- Singles and doubles records are kept separately. In doubles each player gets their own win–loss, plus a record with each partner and against each opponent.
- `stats.html` shows a leaderboard for each mode (sort by wins, win %, games or best streak). Tap a player to see their last 10 games and their head-to-head records (plus partners in doubles).
- "Clear everything" resets the table and line but **never** the records.
- Admins (unlock on the main page first) can **merge** a typo'd name into the real one, or **delete** a record, from that player's entry on the stats page.

## Deploy (about 5 minutes)

1. **Put the code on GitHub.** Create a new repo and upload these files (keep the `api/` folder).
2. **Import to Vercel.** Go to vercel.com → Add New → Project → import the repo. No settings to change, so just click Deploy.
3. **Add the database.** In your Vercel project, open **Storage** → **Create Database** → **Upstash for Redis** (free plan) → connect it to this project. This adds the env vars automatically.
4. **(Optional) Set an admin code.** Go to Settings → Environment Variables → add `ADMIN_CODE` = something secret.
5. **Redeploy.** Open the Deployments tab → ⋯ on the latest → Redeploy, so the new env vars take effect.

Then print a QR code of your `*.vercel.app` URL and tape it next to the table.

**No GitHub?** Run `npx vercel` inside this folder instead of steps 1 and 2. Then do steps 3 to 5 and run `npx vercel --prod`.

## Local testing
`npx vercel dev` runs it locally. With no Redis env vars, the API falls back to in-memory storage, so you can click around without a database (the data resets on restart).
