param(
  [string]$SshHost,
  [int]$CtId = 0,
  [string]$BindIp,
  [int]$Port = 0,
  [string]$StackDir,
  [string]$PublicHealthUrl,
  [string]$ImagePrefix,
  [string]$SyncMediaPath,
  [switch]$SkipTests,
  [switch]$AllowDirty,
  [switch]$SkipPushCheck,
  [switch]$Rollback
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LocalConfigPath = Join-Path $RepoRoot ".deploy.local.json"

$cfg = @{}
if (Test-Path $LocalConfigPath) {
  $cfg = Get-Content -Raw -Path $LocalConfigPath | ConvertFrom-Json -AsHashtable
}

if (-not $SshHost) { $SshHost = $cfg["sshHost"] }
if ($CtId -le 0 -and $cfg.ContainsKey("ctId")) { $CtId = [int]$cfg["ctId"] }
if (-not $BindIp) { $BindIp = $cfg["bindIp"] }
if ($Port -le 0) { $Port = if ($cfg.ContainsKey("port")) { [int]$cfg["port"] } else { 4660 } }
if (-not $StackDir) { $StackDir = if ($cfg["stackDir"]) { [string]$cfg["stackDir"] } else { "/opt/stacks/vespera" } }
if (-not $PublicHealthUrl) { $PublicHealthUrl = $cfg["publicHealthUrl"] }
if (-not $ImagePrefix) { $ImagePrefix = if ($cfg["imagePrefix"]) { [string]$cfg["imagePrefix"] } else { "release-" } }

if (-not $SshHost -or $CtId -le 0 -or -not $BindIp) {
  throw "Missing deploy target. Set sshHost, ctId, and bindIp in .deploy.local.json or pass -SshHost, -CtId, -BindIp."
}

function Invoke-CtBash {
  param([Parameter(Mandatory = $true)][string]$Script)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  $remoteCmd = "pct exec $CtId -- bash -lc `"echo $b64 | base64 -d | bash`""
  & ssh -o BatchMode=yes -o ConnectTimeout=15 $SshHost $remoteCmd
  if ($LASTEXITCODE -ne 0) {
    throw "Remote container command failed on $SshHost CT $CtId (exit $LASTEXITCODE)."
  }
}

function Run-LocalStep {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  Write-Host "=> $Label"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed (exit $LASTEXITCODE)."
  }
}

if ($SyncMediaPath) {
  $resolvedMedia = (Resolve-Path $SyncMediaPath).Path
  if (-not (Test-Path $resolvedMedia -PathType Container)) {
    throw "SyncMediaPath is not a directory: $SyncMediaPath"
  }
  $parentDir = Split-Path -Parent $resolvedMedia
  $leafName = Split-Path -Leaf $resolvedMedia
  Write-Host "=> Syncing media directory '$leafName' to ${SshHost}:CT${CtId}:$StackDir/data/media/$leafName"
  Invoke-CtBash "set -euo pipefail; mkdir -p '$StackDir/data/media'"
  $pipeCmd = "tar -cf - -C `"$parentDir`" `"$leafName`" | ssh -o BatchMode=yes $SshHost `"pct exec $CtId -- tar -xf - -C '$StackDir/data/media'`""
  & cmd.exe /c $pipeCmd
  if ($LASTEXITCODE -ne 0) {
    throw "Media sync failed (exit $LASTEXITCODE)."
  }
  Write-Host "Media sync complete: $StackDir/data/media/$leafName"
  if (-not $Rollback -and -not $PSBoundParameters.ContainsKey("SkipTests")) {
    return
  }
}

if ($Rollback) {
  Write-Host "=> Rolling back Vespera on ${SshHost} CT ${CtId} ($StackDir)"
  $rollbackScript = @"
set -euo pipefail
latest_backup=`$(ls -1t "$StackDir/releases"/compose.before-*.yaml 2>/dev/null | head -n 1 || true)
if [ -z "`$latest_backup" ]; then
  echo "No rollback compose backup found in $StackDir/releases" >&2
  exit 1
fi
cp "`$latest_backup" "$StackDir/compose.yaml"
docker compose -f "$StackDir/compose.yaml" up -d --remove-orphans
ok=0
for _ in `$(seq 1 30); do
  if curl -fsS "http://${BindIp}:${Port}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1.5
done
if [ "`$ok" -ne 1 ]; then
  docker logs --tail 60 vespera || true
  exit 1
fi
echo "Rolled back cleanly using `$latest_backup"
curl -fsS "http://${BindIp}:${Port}/api/health"
echo
"@
  Invoke-CtBash $rollbackScript
  return
}

Set-Location $RepoRoot

if (-not $AllowDirty) {
  $dirty = git status --porcelain
  if ($dirty) {
    throw "Working tree has uncommitted changes. Commit or pass -AllowDirty before deploying.`n$dirty"
  }
}

if (-not $SkipPushCheck) {
  $upstream = git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null
  if ($LASTEXITCODE -eq 0 -and $upstream) {
    $ahead = [int](git rev-list --count "$upstream..HEAD")
    if ($ahead -gt 0) {
      throw "Local branch is $ahead commit(s) ahead of $upstream. Push first or pass -SkipPushCheck."
    }
  }
}

if (-not $SkipTests) {
  Run-LocalStep "Typecheck" { npm run typecheck }
  Run-LocalStep "Tests (including hygiene)" { npm test }
  Run-LocalStep "Build server" { npm run build:server }
  Run-LocalStep "Build web" { npm run build:web }
}

$sha = (git rev-parse --short=12 HEAD).Trim()
$fullSha = (git rev-parse HEAD).Trim()
$imageTag = "vespera:${ImagePrefix}$sha"
$buildDir = "$StackDir/build/$sha"

Write-Host "=> Preparing CT $CtId directories and verifying channels.local.json"
$prepScript = @"
set -euo pipefail
mkdir -p "$StackDir/data/profiles" "$StackDir/data/evidence" "$StackDir/data/media" "$StackDir/releases" "$StackDir/build"
if [ ! -f "$StackDir/channels.local.json" ]; then
  echo "Missing $StackDir/channels.local.json on CT $CtId" >&2
  exit 1
fi
rm -rf "$buildDir"
mkdir -p "$buildDir"
"@
Invoke-CtBash $prepScript

Write-Host "=> Streaming git archive ($sha) to ${SshHost}:CT${CtId}:$buildDir"
$archiveRef = if ($AllowDirty) { "HEAD" } else { $fullSha }
$archiveCmd = "git -C `"$RepoRoot`" archive --format=tar $archiveRef | ssh -o BatchMode=yes $SshHost `"pct exec $CtId -- tar -xf - -C '$buildDir'`""
& cmd.exe /c $archiveCmd
if ($LASTEXITCODE -ne 0) {
  throw "Failed to stream source archive (exit $LASTEXITCODE)."
}

$composeYaml = @"
name: vespera
services:
  vespera:
    image: $imageTag
    container_name: vespera
    hostname: vespera
    restart: unless-stopped
    shm_size: "1gb"
    ports:
      - "${BindIp}:${Port}:4660"
    environment:
      NODE_ENV: production
      VESPERA_DOCKER: "1"
      VESPERA_HOST: "0.0.0.0"
      VESPERA_PORT: "4660"
      VESPERA_DATA_DIR: "/data"
      VESPERA_CHANNELS_FILE: "/app/channels.local.json"
    env_file:
      - path: "$StackDir/.env"
        required: false
    volumes:
      - "$StackDir/data:/data"
      - "$StackDir/channels.local.json:/app/channels.local.json:ro"
    labels:
      com.centurylinklabs.watchtower.enable: "false"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
"@
$composeB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($composeYaml.Replace("`r`n", "`n")))

Write-Host "=> Building $imageTag on CT $CtId and deploying with automatic rollback guard"
$deployScript = @"
set -euo pipefail
docker build -t "$imageTag" "$buildDir"
backup_file="$StackDir/releases/compose.before-$sha.yaml"
if [ -f "$StackDir/compose.yaml" ]; then
  cp "$StackDir/compose.yaml" "`$backup_file"
fi
echo "$composeB64" | base64 -d > "$StackDir/compose.yaml"
docker compose -f "$StackDir/compose.yaml" up -d --remove-orphans

ok=0
for _ in `$(seq 1 30); do
  if curl -fsS "http://${BindIp}:${Port}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1.5
done

if [ "`$ok" -ne 1 ]; then
  echo "Health check failed for $imageTag; logs follow:" >&2
  docker logs --tail 60 vespera >&2 || true
  if [ -f "`$backup_file" ]; then
    echo "Restoring previous compose from `$backup_file" >&2
    cp "`$backup_file" "$StackDir/compose.yaml"
    docker compose -f "$StackDir/compose.yaml" up -d --remove-orphans || true
  fi
  rm -rf "$buildDir"
  exit 1
fi

rm -rf "$buildDir"

prev_img=""
if [ -f "`$backup_file" ]; then
  prev_img=`$(awk '/image:/ {print `$2; exit}' "`$backup_file" || true)
fi
for img in `$(docker images --format '{{.Repository}}:{{.Tag}}' vespera | grep "^vespera:${ImagePrefix}" || true); do
  if [ "`$img" != "$imageTag" ] && [ "`$img" != "`$prev_img" ]; then
    docker image rm "`$img" >/dev/null 2>&1 || true
  fi
done

echo "DEPLOY_SUCCESS image=$imageTag commit=$fullSha"
curl -fsS "http://${BindIp}:${Port}/api/health"
echo
"@
Invoke-CtBash $deployScript

if ($PublicHealthUrl) {
  Write-Host "=> Verifying $PublicHealthUrl"
  $code = & curl.exe -sS --max-time 10 -o NUL -w "%{http_code}" $PublicHealthUrl
  Write-Host "Public health HTTP code: $code"
}
