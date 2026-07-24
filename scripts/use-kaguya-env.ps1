$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot ".tools\node-v24.18.0-win-x64"
$shimDirectory = Join-Path $projectRoot ".tools\bin"

if (-not (Test-Path (Join-Path $nodeDirectory "node.exe"))) {
  throw "Kaguya Node.js runtime is missing. Re-run the environment setup."
}

$env:PATH = "$nodeDirectory;$shimDirectory;$env:PATH"

Write-Output "Kaguya environment loaded: Node $(& node --version), pnpm $(& pnpm --version)"
