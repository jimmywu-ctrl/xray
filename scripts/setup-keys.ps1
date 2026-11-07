#requires -Version 5.1
param([switch]$DetectOnly)
$ErrorActionPreference = "Stop"

$DataRoot = if ($env:XRAY_DATA_DIR) { $env:XRAY_DATA_DIR } else { Join-Path $env:APPDATA "xray-next" }
$Secrets = Join-Path $DataRoot "secrets"
$Tools = Join-Path $DataRoot "tools"
$Out = Join-Path $Secrets "all_keys.json"
$BundledTool = Join-Path $PSScriptRoot "wcdb_key_tool_windows.py"
$Tool = $BundledTool
$ToolCommit = "79f1b5b92e12c66aa281b4a60a3c478b5f547dfa"
$ToolSha256 = "9de22ccc5070bfc5325ece1bdf4da8ca537eea594b821fc2acd46a62c0e41958"
New-Item -ItemType Directory -Force -Path $Secrets, $Tools | Out-Null

# The share build carries the pinned extractor. Keep the verified download path for
# source checkouts that intentionally omit third-party runtime files.
if (-not (Test-Path -LiteralPath $BundledTool)) {
  $Tool = Join-Path $Tools "wcdb_key_tool_windows.py"
  $ToolDownload = "$Tool.download"
  try {
    Write-Host "Downloading verified wcdb-key-tool Windows script..."
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/TANGandXUE/wcdb-key-tool/$ToolCommit/wcdb_key_tool_windows.py" -OutFile $ToolDownload
    $ActualSha256 = (Get-FileHash -LiteralPath $ToolDownload -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $ToolSha256) { throw "wcdb-key-tool integrity check failed; the script was not run." }
    Move-Item -LiteralPath $ToolDownload -Destination $Tool -Force
  } finally {
    if (Test-Path -LiteralPath $ToolDownload) { Remove-Item -LiteralPath $ToolDownload -Force }
  }
}

$PythonCandidates = @()
if ($env:XRAY_BUNDLED_PYTHON) { $PythonCandidates += $env:XRAY_BUNDLED_PYTHON }
$PythonCandidates += (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "python\python.exe")
$SystemPython = Get-Command "python.exe" -ErrorAction SilentlyContinue
if ($SystemPython) { $PythonCandidates += $SystemPython.Source }
$Python = $PythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $Python) { throw "找不到 Python。分享版应自带运行时；开发版可安装 Python 3.10+ 或设置 XRAY_BUNDLED_PYTHON。" }

# Use the same current-machine discovery as the reader, including WeChat config files.
$AppRoot = Split-Path $PSScriptRoot -Parent
$Node = Join-Path (Split-Path $AppRoot -Parent) "node\node.exe"
if (-not (Test-Path -LiteralPath $Node)) {
  $NodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
  if ($NodeCommand) { $Node = $NodeCommand.Source }
}
if (-not (Test-Path -LiteralPath $Node)) { throw "找不到本机 Node 运行时，分享版应自带运行时。" }
$Loader = Join-Path $AppRoot "node_modules\tsx\dist\loader.mjs"
$LoaderUri = ([System.Uri]$Loader).AbsoluteUri
$Detection = & $Node --import $LoaderUri (Join-Path $PSScriptRoot "detect-wechat-db.mjs")
if ($LASTEXITCODE -ne 0) { throw "微信目录自动探测失败，请确认本机安装完整。" }
$DbDir = ($Detection | ConvertFrom-Json).dbDir
if (-not $DbDir) { throw "未找到本机微信 db_storage。请先登录这台电脑的 Windows 微信 4.x。" }
if ($DetectOnly) { Write-Output $DbDir; return }
Write-Host "db_dir: $DbDir"
Write-Host "Keep Weixin.exe running. Admin may be required if scan fails."
& $Python $Tool extract --db-dir $DbDir --output $Out
if ($LASTEXITCODE -ne 0) { throw "微信密钥提取失败（exit $LASTEXITCODE）" }
if (-not (Test-Path -LiteralPath $Out)) { throw "密钥文件未生成" }
Write-Host "OK -> $Out"


