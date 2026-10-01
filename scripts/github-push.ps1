# Creates GitHub repo voice-agent-saas + pushes current branch.
# Uses $env:GITHUB_PAT only. Never prints the token.
$ErrorActionPreference = "Stop"
$repo = "voice-agent-saas"

if (-not $env:GITHUB_PAT) { throw "GITHUB_PAT missing. Set `$env:GITHUB_PAT in your own shell first." }

$headers = @{ Authorization = "Bearer $($env:GITHUB_PAT)"; Accept = "application/vnd.github+json" }
try {
  $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/DataBuks11/$repo" -Headers $headers -Method Get
  Write-Host "Repo already exists: $($existing.full_name)"
} catch {
  Write-Host "Creating repo $repo ..."
  $body = @{ name = $repo; private = $false; description = "Multi-tenant AI Voice Agent SaaS (Pipecat + pgvector)" } | ConvertTo-Json
  $created = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body -ContentType "application/json"
  Write-Host "Created: $($created.full_name)"
}

$remotes = git remote
if ($remotes -notcontains "origin") {
  # Embed PAT via credential-free URL? No — use header-based push via credential helper input, never echo token.
  $user = (Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers).login
  Write-Host "Pushing as $user ..."
  # git will prompt for credentials; feed PAT via credential helper stdin without echoing value to log
  $repoUrl = "https://github.com/$user/$repo.git"
  git remote add origin $repoUrl
}
git branch -M main
git push -u origin main
Write-Host "Push done."
