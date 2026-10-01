# Setup (Windows + Mac/Linux)

1. Install: Node 20+, pnpm 9+, Python 3.11+, Docker.
2. Copy env: `cp .env.example .env` (PowerShell: `Copy-Item .env.example .env`)
3. Supabase: create project, enable `pgvector`, run `supabase/migrations/*.sql`, set keys in `.env`.
   Project ref in screenshots: `jszacqcjnqlyhuzubhkj` (region ap-southeast-1) — use your own keys.
4. API: `cd apps/api; pnpm install; pnpm dev`
5. Web: `cd apps/web; pnpm install; pnpm dev`
6. Voice: `cd services/voice; python -m venv .venv; .venv/Scripts/activate (Windows); pip install -r requirements.txt; python src/main.py`
7. Tests: `pnpm -r test` and `pytest services/voice/tests -q`

Never commit `.env`. Rotate any token that was ever pasted in chat / screenshots.
