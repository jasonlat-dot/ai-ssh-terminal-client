[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$clientRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverRoot = (Resolve-Path (Join-Path $clientRoot '..\ai-ssh-terminal-server')).Path
$bundleRoot = Join-Path $clientRoot 'src-tauri\bundle'
$backendBundle = Join-Path $bundleRoot 'backend'
$runtimeBundle = Join-Path $bundleRoot 'runtime'

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childPath = [System.IO.Path]::GetFullPath($Child)
    if (-not $childPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝操作工作目录之外的路径：$childPath"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Program,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "命令执行失败，exitCode=$LASTEXITCODE：$Program $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Resolve-BundleJdkHome {
    $candidates = @()
    if ($env:BUNDLE_JAVA_HOME) {
        $candidates += $env:BUNDLE_JAVA_HOME
    }
    if ($env:JAVA_HOME) {
        $candidates += $env:JAVA_HOME
    }
    if ($env:USERPROFILE) {
        # IntelliJ IDEA 下载的项目 JDK 通常位于当前用户的 .jdks 目录。
        $candidates += Join-Path $env:USERPROFILE '.jdks\jdk25'
    }

    $javaOnPath = Get-Command 'java.exe' -ErrorAction SilentlyContinue
    if (-not $javaOnPath) {
        $javaOnPath = Get-Command 'java' -ErrorAction SilentlyContinue
    }
    if ($javaOnPath) {
        $candidates += Split-Path -Parent (Split-Path -Parent $javaOnPath.Source)
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $java = Join-Path $candidate 'bin\java.exe'
        $jlink = Join-Path $candidate 'bin\jlink.exe'
        if (-not (Test-Path -LiteralPath $java -PathType Leaf) -or
            -not (Test-Path -LiteralPath $jlink -PathType Leaf)) {
            continue
        }

        # --version 在现代 JDK 中写入标准输出，避免 Windows PowerShell 把 -version 的 stderr 当成异常。
        $versionOutput = (& $java --version | Out-String)
        if ($versionOutput -match '(?:openjdk|java)\s+(?:version\s+")?(?<major>\d+)') {
            $major = [int]$Matches['major']
            if ($major -ge 25) {
                return [System.IO.Path]::GetFullPath($candidate)
            }
        }
    }

    throw '未找到 JDK 25 或更高版本。请设置 BUNDLE_JAVA_HOME，或把 JAVA_HOME 指向用于打包的完整 JDK。'
}

# 每次打包重新生成只读资源，避免把旧 JAR 或旧 Java Runtime 带进新安装包。
Assert-ChildPath -Parent $clientRoot -Child $backendBundle
Assert-ChildPath -Parent $clientRoot -Child $runtimeBundle
if (Test-Path -LiteralPath $backendBundle) {
    Remove-Item -LiteralPath $backendBundle -Recurse -Force
}
if (Test-Path -LiteralPath $runtimeBundle) {
    Remove-Item -LiteralPath $runtimeBundle -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $backendBundle 'default-config') -Force | Out-Null

# Maven 编译和 jlink 必须使用同一个 JDK 25+；这里只修改当前打包进程的环境。
$javaHome = Resolve-BundleJdkHome
$env:JAVA_HOME = $javaHome
$env:Path = (Join-Path $javaHome 'bin') + ';' + $env:Path
$jlink = Join-Path $javaHome 'bin\jlink.exe'

# 构建包含全部依赖的 Spring Boot 可执行 JAR。
$mavenCommand = Get-Command 'mvn.cmd' -ErrorAction SilentlyContinue
if (-not $mavenCommand) {
    $mavenCommand = Get-Command 'mvn' -ErrorAction SilentlyContinue
}
$maven = if ($mavenCommand) { $mavenCommand.Source } else { $null }
if (-not $maven) {
    throw '未找到 Maven，请先安装 Maven 并把 mvn 加入 PATH。'
}
Invoke-Checked -Program $maven `
    -Arguments @('-pl', 'ai-ssh-terminal-server-app', '-am', '-DskipTests', 'package') `
    -WorkingDirectory $serverRoot

$backendJar = Join-Path $serverRoot 'ai-ssh-terminal-server-app\target\ai-ssh-terminal-server-app.jar'
if (-not (Test-Path -LiteralPath $backendJar -PathType Leaf)) {
    throw "后端构建完成但没有找到 JAR：$backendJar"
}
Copy-Item -LiteralPath $backendJar -Destination (Join-Path $backendBundle 'ai-ssh-terminal-server-app.jar')

# 外置配置模板来自后端当前源码，确保安装包配置项与本次打包的后端版本一致。
$applicationSource = Join-Path $serverRoot 'ai-ssh-terminal-server-app\src\main\resources\application.yml'
$prodSource = Join-Path $serverRoot 'ai-ssh-terminal-server-app\src\main\resources\application-prod.yml'
$applicationTarget = Join-Path $backendBundle 'default-config\application.yml'
$prodTarget = Join-Path $backendBundle 'default-config\application-prod.yml'
Copy-Item -LiteralPath $applicationSource -Destination $applicationTarget
Copy-Item -LiteralPath $prodSource -Destination $prodTarget

# 后端源码中的模板已经统一引用 app.config.data-directory，打包时不再改写配置内容。
# 这样源码运行和安装版运行使用完全一致的目录规则，用户修改模板也不会被脚本静默覆盖。

# 使用打包 JDK 自带的 jlink 生成运行时；最终用户不需要安装 Java 或配置 JAVA_HOME。
Invoke-Checked -Program $jlink `
    -Arguments @(
        '--module-path', (Join-Path $javaHome 'jmods'),
        '--add-modules', 'ALL-MODULE-PATH',
        '--bind-services',
        '--strip-debug',
        '--no-header-files',
        '--no-man-pages',
        '--compress=zip-6',
        '--output', $runtimeBundle
    ) `
    -WorkingDirectory $clientRoot

Write-Host "后端与 Java Runtime 已准备完成：$bundleRoot"
