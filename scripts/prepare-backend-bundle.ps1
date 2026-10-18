[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$clientRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverManifest = Join-Path $clientRoot '..\ai-ssh-terminal-server-rust\Cargo.toml'
if (-not (Test-Path -LiteralPath $serverManifest -PathType Leaf)) {
    throw '缺少兄弟目录 ai-ssh-terminal-server-rust，无法编译内置 Rust 后端。'
}
# Cargo links the backend library directly into the Tauri executable. Only this
# informational file is bundled; existing Java/JRE directories are not resources.
$info = Join-Path $clientRoot 'src-tauri\bundle\backend-info.txt'
New-Item -ItemType Directory -Path (Split-Path -Parent $info) -Force | Out-Null
$releaseVersion = (Get-Content -LiteralPath (Join-Path $clientRoot 'package.json') -Raw | ConvertFrom-Json).version
[IO.File]::WriteAllText($info, "ShellPilot ${releaseVersion}: embedded Rust SSH, SFTP, Agent, MCP and Skills backend; no JRE/JAR required.", [Text.UTF8Encoding]::new($false))
Write-Host 'Rust 后端将直接编译到桌面程序；已准备应用资源。'

Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $serverManifest) 'LICENSE') -Destination (Join-Path (Split-Path -Parent $info) 'backend-LICENSE.txt')
