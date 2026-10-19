# AlumniAgent – AI-native alumni finder (MVP)

Ask in plain text or voice: *"Find alumni from Universal AI, 2020–26, at Google/Microsoft/Oracle – location, email or LinkedIn."*

An agent pipeline (streamed live to the UI): **parse → check data lake → discover → geocode → upsert lake → auto-invite**.
Alumni who accept an invite (`/join.html?t=…`) write verified data back into the lake.

```bash
npm install
npm start        # http://localhost:3000   (Node 22+, no DB install needed)
```

Copy `.env.example` to `.env` to enable live sources (all optional):
`SERPER_API_KEY` (Google results), `PDL_API_KEY` (licensed data with emails), `GEMINI_API_KEY` / `HF_TOKEN` (LLM parsing), `SMTP_*` (real invite emails).

Notes: emails are never guessed – only returned by a licensed provider or self-reported. Records tagged `sample` are fictional demo data.
