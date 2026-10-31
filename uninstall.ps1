<#
.SYNOPSIS
  Удаление установки Claude Bridge (обратное install.ps1).
.DESCRIPTION
  Задача Планировщика и ярлык автозагрузки (D-25 п. 4), работающий мост, хук моста в settings.json
  (с резервной копией), шим и каталог в PATH; -Firewall — правила брандмауэра (UAC); -RemoveData —
  каталог данных (сопряжения, сертификат, токены): только распознанный каталог данных моста и только
  без живых сессий этого каталога. Живые сессии (keeper'ы) не завершаются.
  -StartupShortcut — убрать только ярлык автозагрузки, задачу Планировщика не трогать.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'),
  [string]$SettingsPath = (Join-Path $env:USERPROFILE '.claude\settings.json'),
  [string]$TaskName = 'ClaudeBridge',
  [string]$StartupDir = [Environment]::GetFolderPath('Startup'),
  [switch]$StartupShortcut,
  [switch]$Firewall,
  [switch]$RemoveData,
  [switch]$SkipTask,
  [switch]$SkipPath,
  [switch]$SkipHook
)
$ErrorActionPreference = 'Stop'
$prevEncoding = [Console]::OutputEncoding
$failed = $false
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  . (Join-Path $PSScriptRoot 'bridge\tools\install-lib.ps1')

  $BridgeDir = Join-Path $PSScriptRoot 'bridge'
  $DataRoot = [IO.Path]::GetFullPath($DataRoot)
  $CustomData = -not (Test-CbSamePath -A $DataRoot -B (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'))
  $SettingsPath = [IO.Path]::GetFullPath($SettingsPath)
  $CustomSettings = -not (Test-CbSamePath -A $SettingsPath -B (Join-Path $env:USERPROFILE '.claude\settings.json'))
  $StartupDir = [IO.Path]::GetFullPath($StartupDir)
  $CustomStartup = -not (Test-CbSamePath -A $StartupDir -B ([Environment]::GetFolderPath('Startup')))
  $BinDir = Join-Path $DataRoot 'bin'
  $Shim = Join-Path $BinDir 'claude-mobile.cmd'
  $Config = Join-Path $DataRoot 'config.json'
  $Pre = if ($DryRun) { '[dry-run] ' } else { '' }
  function Say([string]$Text) { Write-Output ($Pre + $Text) }

  # Защита тестовых запусков (D-26 п. 4), как в install.ps1 (шага npm здесь нет)
  $SafeAutostart = $SkipTask -or ($StartupShortcut -and $CustomStartup)
  $violations = @(Get-CbGuardViolations -CustomData $CustomData -DryRun $DryRun.IsPresent -SkipPath $SkipPath.IsPresent `
      -SafeAutostart $SafeAutostart -CustomSettings $CustomSettings -SkipNpm $false -Firewall $Firewall.IsPresent -NoNpmStep $true)
  if ($violations.Count) {
    throw ("Нестандартный -DataRoot ($DataRoot) — только для проверки: нужны -SkipPath, -SkipTask (или -StartupShortcut " +
      "-StartupDir <временный каталог>), нестандартный -SettingsPath и без -Firewall; или -DryRun. " +
      "Не выполнено: $($violations -join ', ')")
  }

  # -RemoveData проверяется до любых изменений (ревью I-4, I-6): только каталог данных моста и только
  # без живых сессий ЭТОГО каталога (meta-файл <DataRoot>\sessions\<id>.json в командной строке keeper'а)
  if ($RemoveData -and (Test-Path -LiteralPath $DataRoot)) {
    $why = Get-CbDataDirRefusal -Path $DataRoot
    if ($why) { throw "Каталог данных не удаляется: $why" }
    try { $dataKeepers = @(Find-CbKeeperForData -BridgeDir $BridgeDir -DataRoot $DataRoot) }
    catch { throw "Не удалось проверить живые сессии (WMI/CIM: $($_.Exception.Message)) — каталог данных не удаляется" }
    if ($dataKeepers.Count) {
      $msg = "Живые сессии моста ($($dataKeepers.Count)) используют каталог данных — завершите их (выйдите из агентов) и повторите"
      if ($DryRun) { Write-Warning $msg } else { throw $msg }
    }
  }

  # 1. Автозапуск: задача Планировщика и ярлык автозагрузки (D-25 п. 4)
  if (-not $SkipTask) {
    if (-not $StartupShortcut) {
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Say "Удаляю задачу Планировщика «$TaskName»"
        if (-not $DryRun) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
      } else { Write-Output "  Задачи «$TaskName» нет" }
    }
    $lnk = Join-Path $StartupDir ($TaskName + '.lnk')
    if (Test-Path -LiteralPath $lnk) {
      Say "Удаляю ярлык автозагрузки $lnk"
      if (-not $DryRun) { Remove-Item -LiteralPath $lnk -Force }
    }
  }

  # 2. Работающий мост этого репозитория — процесс server.js, слушающий порт моста (ревью I-6).
  #    Порт — только для поиска процесса; испорченный конфиг удалению не мешает (ревью I-2).
  if ($CustomData) { Write-Output '  Процессы моста не затрагиваются (нестандартный -DataRoot)' }
  else {
    try {
      foreach ($s in @(Find-CbOurBridge -BridgeDir $BridgeDir -Port (Get-CbBridgePortOrDefault -ConfigPath $Config))) {
        Say "Останавливаю мост (PID $($s.ProcessId))"
        if (-not $DryRun) { Stop-Process -Id $s.ProcessId -Force }
      }
      $keepers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind keeper)
      if ($keepers.Count) { Write-Warning "Живые сессии ($($keepers.Count)) продолжают работать до выхода из агентов; мост больше не запустится" }
    } catch { Write-Warning "Не удалось проверить процессы моста: $($_.Exception.Message)" }
  }

  # 3. Хук Claude Code
  if (-not $SkipHook) {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { Write-Warning "Node.js не найден — удалите записи с bridge-hook.js из $SettingsPath вручную" }
    else {
      $hookArgs = @((Join-Path $BridgeDir 'tools\install-hooks.js'), 'uninstall', '--settings', $SettingsPath)
      if ($DryRun) { $hookArgs += '--dry-run' }
      Invoke-CbNative { & $node.Source @hookArgs }
      if ($LASTEXITCODE -ne 0) { throw "Хук Claude Code не удалён (код $LASTEXITCODE)" }
    }
  }

  # 4. PATH и шим
  if (-not $SkipPath) {
    $cur = Get-CbUserPath
    $new = Remove-CbPathEntry -PathValue $cur -Entry $BinDir
    if ($new -cne $cur) {
      Say "Убираю $BinDir из PATH пользователя"
      if (-not $DryRun) { Set-CbUserPath -Value $new }
    }
  }
  if (Test-Path -LiteralPath $Shim) {
    Say "Удаляю шим $Shim"
    if (-not $DryRun) {
      Remove-Item -LiteralPath $Shim -Force
      if (-not (Get-ChildItem -LiteralPath $BinDir -Force)) { Remove-Item -LiteralPath $BinDir -Force }
    }
  }

  # 5. Брандмауэр: правила удаляются по имени (порт не нужен); ошибка — предупреждение
  if ($Firewall) { Invoke-CbFirewall -Action remove -Script (Join-Path $BridgeDir 'tools\firewall.ps1') -DryRun:$DryRun }

  # 6. Каталог данных (проверен выше)
  if ($RemoveData) {
    if (Test-Path -LiteralPath $DataRoot) {
      Say "Удаляю каталог данных $DataRoot (сопряжения, сертификат, токены — телефоны придётся сопрячь заново)"
      if (-not $DryRun) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
    }
  } elseif (Test-Path -LiteralPath $DataRoot) {
    Write-Output "  Каталог данных сохранён: $DataRoot (удалить: uninstall.ps1 -RemoveData)"
  }
  Write-Output 'Готово. bridge\node_modules и клон репозитория не удалялись.'
} catch {
  # своё сообщение, пока вывод в UTF-8: необработанную ошибку PowerShell напечатал бы уже
  # после восстановления кодировки консоли (кириллица в перенаправленном выводе ломается)
  Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
  $failed = $true
} finally {
  try { [Console]::OutputEncoding = $prevEncoding } catch { }
}
if ($failed) { exit 1 }
