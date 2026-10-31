<#
.SYNOPSIS
  Сборка релиза Claude Bridge (P-8) в dist\.
.DESCRIPTION
  claude-tunnel.exe (x86_64-pc-windows-msvc), libclaudetunnel.so (aarch64-linux-android, нужен
  Android NDK), release-APK, подписанный ключом команды; SHA256SUMS.txt и RELEASE_NOTES.md с
  SHA-256 артефактов и сертификата подписи APK. Ключ и пароль в репозиторий не попадают.
  Без Android NDK шаг libclaudetunnel.so пропускается с предупреждением (задача 9 подплана 4).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -KeystorePath D:\keys\claude-bridge-team.jks
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk -SkipAndroidTunnel
#>
[CmdletBinding()]
param(
  [string]$KeystorePath,
  [string]$KeyAlias = 'claude-bridge-team',
  [switch]$SkipApk,
  [switch]$SkipAndroidTunnel,
  [string]$NdkVersion = '28.2.13676358',
  [string]$SdkDir = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }),
  [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Join-Path $env:LOCALAPPDATA 'Programs\Temurin\jdk-17' }),
  [string]$OutDir # по умолчанию <корень репозитория>\dist ($PSScriptRoot в значениях param() PS 5.1 пуст)
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }
$Cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $Cargo)) {
  $c = Get-Command cargo -ErrorAction SilentlyContinue
  if ($c) { $Cargo = $c.Source } else { throw 'cargo не найден: установите Rust (https://rustup.rs/)' }
}
$BuildTools = Join-Path $SdkDir 'build-tools\34.0.0'

function Invoke-Checked([string]$What, [scriptblock]$Block) {
  # stderr cargo/gradle — не ошибка PowerShell (см. Invoke-CbNative в bridge\tools\install-lib.ps1)
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw "$What завершился с кодом $LASTEXITCODE" }
}

if (-not $SkipApk) {
  if (-not $KeystorePath) { throw 'Укажите -KeystorePath (хранилище ключа команды) или -SkipApk' }
  if (-not (Test-Path -LiteralPath $KeystorePath)) { throw "Нет файла ключа: $KeystorePath" }
  $KeystorePath = (Resolve-Path -LiteralPath $KeystorePath).Path
}

if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null
$artifacts = New-Object System.Collections.Generic.List[string]

# 1. Туннель для ПК
Write-Output '== claude-tunnel.exe (x86_64-pc-windows-msvc)'
Push-Location (Join-Path $Root 'tunnel')
try { Invoke-Checked 'cargo build (windows)' { & $Cargo build --release --locked } } finally { Pop-Location }
$exe = Join-Path $Root 'tunnel\target\release\claude-tunnel.exe'
Copy-Item -LiteralPath $exe -Destination (Join-Path $OutDir 'claude-tunnel.exe')
$artifacts.Add('claude-tunnel.exe')
New-Item -ItemType Directory -Path (Join-Path $Root 'bridge\bin') -Force | Out-Null
try { Copy-Item -LiteralPath $exe -Destination (Join-Path $Root 'bridge\bin\claude-tunnel.exe') -Force }
catch { Write-Warning "bridge\bin\claude-tunnel.exe не обновлён (занят работающим туннелем?): $($_.Exception.Message)" }

# 2. Туннель для Android (clang.exe NDK напрямую: без .cmd-обёрток и их предела длины командной строки)
$androidTunnelBuilt = $false
$androidTunnelNote = $null
if ($SkipAndroidTunnel) {
  $androidTunnelNote = 'libclaudetunnel.so не собиралась (-SkipAndroidTunnel)'
} else {
  $llvm = Join-Path $SdkDir "ndk\$NdkVersion\toolchains\llvm\prebuilt\windows-x86_64\bin"
  if (-not (Test-Path -LiteralPath (Join-Path $llvm 'clang.exe'))) {
    $androidTunnelNote = "libclaudetunnel.so не собрана: нет Android NDK $NdkVersion ($llvm) — задача 9 подплана 4"
    Write-Warning $androidTunnelNote
  } else {
    Write-Output '== libclaudetunnel.so (aarch64-linux-android)'
    $env:CC_aarch64_linux_android = Join-Path $llvm 'clang.exe'
    $env:CFLAGS_aarch64_linux_android = '--target=aarch64-linux-android26'
    $env:AR_aarch64_linux_android = Join-Path $llvm 'llvm-ar.exe'
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $llvm 'clang.exe'
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS = '-C link-arg=--target=aarch64-linux-android26'
    Push-Location (Join-Path $Root 'tunnel')
    try { Invoke-Checked 'cargo build (android)' { & $Cargo build --release --locked --target aarch64-linux-android } }
    finally { Pop-Location }
    $built = Join-Path $Root 'tunnel\target\aarch64-linux-android\release\claude-tunnel'
    $jni = Join-Path $Root 'android\app\src\main\jniLibs\arm64-v8a'
    New-Item -ItemType Directory -Path $jni -Force | Out-Null
    Copy-Item -LiteralPath $built -Destination (Join-Path $jni 'libclaudetunnel.so') -Force
    Copy-Item -LiteralPath $built -Destination (Join-Path $OutDir 'libclaudetunnel.so')
    $artifacts.Add('libclaudetunnel.so')
    $androidTunnelBuilt = $true
  }
}

# 3. Release-APK, подписанный ключом команды
$certSha = $null
if (-not $SkipApk) {
  Write-Output '== release-APK'
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'android\app\src\main\jniLibs\arm64-v8a\libclaudetunnel.so'))) {
    Write-Warning 'В APK не будет libclaudetunnel.so: на телефоне не будет доступа через интернет'
  }
  $secure = Read-Host -AsSecureString "Пароль хранилища ключа команды ($KeystorePath)"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $env:JAVA_HOME = $JavaHome
  $env:ORG_GRADLE_PROJECT_cbReleaseStoreFile = $KeystorePath
  $env:ORG_GRADLE_PROJECT_cbReleaseKeyAlias = $KeyAlias
  $env:ORG_GRADLE_PROJECT_cbReleaseStorePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:ORG_GRADLE_PROJECT_cbReleaseKeyPassword = $env:ORG_GRADLE_PROJECT_cbReleaseStorePassword
  Push-Location (Join-Path $Root 'android')
  try { Invoke-Checked 'gradlew assembleRelease' { & .\gradlew.bat --no-daemon clean :app:assembleRelease } }
  finally {
    Pop-Location
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    foreach ($n in 'cbReleaseStoreFile', 'cbReleaseKeyAlias', 'cbReleaseStorePassword', 'cbReleaseKeyPassword') {
      Remove-Item -LiteralPath "Env:ORG_GRADLE_PROJECT_$n" -ErrorAction SilentlyContinue
    }
  }
  $apk = Join-Path $Root 'android\app\build\outputs\apk\release\app-release.apk'
  if (-not (Test-Path -LiteralPath $apk)) { throw 'Нет app-release.apk — release не подписан (проверьте ключ и пароль)' }
  $badging = @(Invoke-Checked 'aapt dump badging' { & (Join-Path $BuildTools 'aapt.exe') dump badging $apk })
  if ($badging -match 'application-debuggable') { throw 'APK собран как debuggable — нарушение M-5' }
  $ver = [regex]::Match(($badging -join "`n"), "versionName='([^']+)'").Groups[1].Value
  $certOut = @(Invoke-Checked 'apksigner verify (подпись APK не прошла проверку)' {
      & (Join-Path $BuildTools 'apksigner.bat') verify --print-certs $apk })
  $m = [regex]::Match(($certOut -join "`n"), 'Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})')
  if (-not $m.Success) { throw "Нет SHA-256 сертификата подписи в выводе apksigner:`n$($certOut -join "`n")" }
  $certSha = $m.Groups[1].Value
  $apkName = "ClaudeBridge-$ver.apk"
  Copy-Item -LiteralPath $apk -Destination (Join-Path $OutDir $apkName)
  $artifacts.Add($apkName)
}

# 4. Контрольные суммы и заметки к релизу
$utf8 = New-Object Text.UTF8Encoding $false
$sums = @(foreach ($a in $artifacts) {
    '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutDir $a)).Hash.ToLowerInvariant(), $a
  })
[IO.File]::WriteAllText((Join-Path $OutDir 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"), $utf8)
$commit = ([string](& git -C $Root rev-parse --short HEAD)).Trim()
$rustc = ([string](& (Join-Path (Split-Path -Parent $Cargo) 'rustc.exe') -V)).Trim()
$ndkNote = if ($androidTunnelBuilt) { "; Android NDK $NdkVersion" } else { '' }
$notes = @("# Claude Bridge — релиз $commit", '',
  "Собрано $(Get-Date -Format 'yyyy-MM-dd') из коммита ``$commit``; $rustc$ndkNote.", '',
  '| Файл | SHA-256 |', '|---|---|')
foreach ($s in $sums) { $parts = $s -split '  ', 2; $notes += "| ``$($parts[1])`` | ``$($parts[0])`` |" }
if ($androidTunnelNote) { $notes += @('', "Внимание: $androidTunnelNote.") }
if ($certSha) { $notes += @('', "SHA-256 сертификата подписи APK: ``$certSha`` — должен совпадать с README.") }
$notes += @('', 'Проверка (PowerShell):', '', '```powershell', 'Get-FileHash -Algorithm SHA256 .\claude-tunnel.exe',
  '& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs .\ClaudeBridge-<версия>.apk', '```')
[IO.File]::WriteAllText((Join-Path $OutDir 'RELEASE_NOTES.md'), (($notes -join "`n") + "`n"), $utf8)

Write-Output ''
Write-Output "Готово: $OutDir"
$sums | ForEach-Object { Write-Output "  $_" }
if ($androidTunnelNote) { Write-Output "  ($androidTunnelNote)" }
if ($certSha) { Write-Output "  SHA-256 сертификата подписи APK: $certSha" }
