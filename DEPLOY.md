# Deploying AlumniAgent

## Option A: instant public link (already running)
A Cloudflare quick tunnel exposes the local app over HTTPS. No account is needed.
```powershell
npm start
& "$env:USERPROFILE\.cloudflared-bin\cloudflared.exe" tunnel --no-autoupdate --url http://localhost:3000
```
The URL (`https://<random>.trycloudflare.com`) only works while this laptop is on and both commands are running. Put the URL in `.env` as `BASE_URL` so invite links point to it.

## Option B: permanent website on Render (free)
1. Create an empty repository on https://github.com/new (e.g. `alumni-agent`, private is fine).
2. Push this folder:
   ```powershell
   git remote add origin https://github.com/<your-username>/alumni-agent.git
   git push -u origin main
   ```
3. Go to https://dashboard.render.com, click **New**, then **Blueprint**, and pick the repo. `render.yaml` is detected automatically.
4. When asked, fill in the secret env vars:
   - `SERPER_API_KEY`: your Serper key
   - `GEMINI_API_KEY`: your Gemini key
   - `BASE_URL`: the Render URL, e.g. `https://alumni-agent.onrender.com` (you can add it after the first deploy)
5. Click **Apply**. In about 3 minutes the site is live at `https://alumni-agent.onrender.com`.

Notes:
- **Free plan sleeps:** the free plan sleeps after 15 minutes idle, and the first visit then takes about 30–50 s to wake.
- **Data lake resets:** the data lake (SQLite) lives on the instance disk and resets on redeploy. That's fine for a demo; use a Render Disk or Postgres for production.
- **Credit protection** (`MAX_SEARCHES_PER_DAY=40`, `MAX_SEARCHES_PER_IP_HOUR=8`; deep search counts as 3). Optionally set `ACCESS_CODE=xyz` and share `https://…/?code=xyz` to make it private.
