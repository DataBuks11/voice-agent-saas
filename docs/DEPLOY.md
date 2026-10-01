# Deploy — Vercel (frontend) + Railway (backend)

## 0. Tokens ko chat me mat paste karo (already exposed wale rotate karo)

GitHub PAT, Vercel, Railway, Supabase keys jo chat/screenshots me aaye hain —
unhe rotate kar lo. Aage se tokens sirf apne PowerShell me env var banakar rakho:

```powershell
$env:GITHUB_PAT="ghp_...-yours"
$env:VERCEL_TOKEN="vcp_...-yours"
$env:RAILWAY_TOKEN="...-yours"
$env:SUPABASE_URL="https://jszacqcjnqlyhuzubhkj.supabase.co"
$env:SUPABASE_ANON_KEY="anon-yours"
$env:SUPABASE_SERVICE_ROLE_KEY="service_role-yours"
```

Verify (values print NAHI hongi):

```powershell
@("GITHUB_PAT","VERCEL_TOKEN","RAILWAY_TOKEN") | % { "$_ : $(if ([Environment]::GetEnvironmentVariable($_)) {'SET'} else {'MISSING'})" }
```

## 1. GitHub repo `voice-agent-saas` banao + push

```powershell
cd voice-agent-saas
./scripts/github-push.ps1
```

Ye script `$env:GITHUB_PAT` se `POST https://api.github.com/user/repos`
karke repo banata hai aur `git remote add origin` + push karta hai.
Token kabhi log/file me print nahi hota.

## 2. Supabase schema

Supabase dashboard → SQL editor → `supabase/migrations/0001_init.sql` paste → Run.
`pgvector` extension enable hona chahiye. Keys sirf Railway/Vercel env me dalo,
kabhi repo me commit mat karo.

## 3. Railway (API + voice)

- `railway.json` API service ke liye hai. Dashboard me New → GitHub repo → `voice-agent-saas` → service add.
- Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `LLM_API_KEY`, `EMBEDDING_API_KEY`, `STT_*`, `TTS_*`.
- Voice service ke liye alag service: Dockerfile `docker/Dockerfile.voice`.

CLI se:

```powershell
$env:RAILWAY_TOKEN="yours"   # ek baar apne shell me
railway up --service api
```

## 4. Vercel (web)

```powershell
cd apps/web
vercel --token $env:VERCEL_TOKEN --yes
vercel env add VITE_API_URL production
vercel env add VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_ANON_KEY production
```

`vercel.json` me output `apps/web/dist` set hai.
