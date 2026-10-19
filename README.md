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
