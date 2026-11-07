$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = if ($env:XRAY_NODE) { $env:XRAY_NODE } else { (Get-Command node.exe -ErrorAction Stop).Source }
Push-Location $project
try {
  & $node --import tsx --test --test-concurrency=2 'test/*.test.mjs' 'test/*.test.cjs'
  exit $LASTEXITCODE
} finally { Pop-Location }
