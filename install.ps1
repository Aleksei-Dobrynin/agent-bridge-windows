<#
.SYNOPSIS
  Установка Claude Bridge на личный Windows-ПК (P-4, P-6, P-8).
.DESCRIPTION
  Проверка Node.js / Claude Code / opencode, npm ci в bridge\, каталог данных и config.json,
  шим claude-mobile в PATH пользователя, хук Claude Code в settings.json пользователя (с резервной
  копией), задача Планировщика «при входе» (если её не зарегистрировать — ярлык в папке
  автозагрузки, D-25 п. 4), запуск моста. -Firewall — правила брандмауэра (UAC).
  -StartupShortcut — сразу ярлык автозагрузки вместо задачи Планировщика.
  Повторный запуск безопасен (обновление после git pull).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Firewall
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
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
  [switch]$SkipNpm,
  [switch]$SkipTask,
  [switch]$SkipPath,
  [switch]$SkipHook,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$prevEncoding = [Console]::OutputEncoding
$failed = $false
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  . (Join-Path $PSScriptRoot 'bridge\tools\install-lib.ps1')

  $RepoRoot = $PSScriptRoot
  $BridgeDir = Join-Path $RepoRoot 'bridge'
  $DataRoot = [IO.Path]::GetFullPath($DataRoot)
  $CustomData = -not (Test-CbSamePath -A $DataRoot -B (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'))
  $StartupDir = [IO.Path]::GetFullPath($StartupDir)
  $CustomStartup = -not (Test-CbSamePath -A $StartupDir -B ([Environment]::GetFolderPath('Startup')))
  $BinDir = Join-Path $DataRoot 'bin'
  $Shim = Join-Path $BinDir 'claude-mobile.cmd'
  $Config = Join-Path $DataRoot 'config.json'
  $Pre = if ($DryRun) { '[dry-run] ' } else { '' }
  function Say([string]$Text) { Write-Output ($Pre + $Text) }

  # автозапуск при проверках: не трогать (-SkipTask) или ярлык во временном каталоге
  $SafeAutostart = $SkipTask -or ($StartupShortcut -and $CustomStartup)
  if ($CustomData -and -not $DryRun -and -not ($SafeAutostart -and $SkipPath)) {
    throw "Нестандартный -DataRoot ($DataRoot) — только для проверки: автозапуск и PATH о нём не знают. Добавьте -SkipTask -SkipPath (или -StartupShortcut -StartupDir <временный каталог> -SkipPath) или -DryRun."
  }
  Write-Output "Claude Bridge: установка из $RepoRoot"

  # 1. Проверки
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'Node.js не найден в PATH (нужна версия 20 или новее): https://nodejs.org/' }
  $nodeVersion = ([string](& $node.Source -v)).Trim()
  if (-not (Test-CbNodeVersion -VersionText $nodeVersion)) { throw "Нужен Node.js 20 или новее, найден $nodeVersion" }
  Write-Output "  Node.js $nodeVersion — $($node.Source)"
  foreach ($agent in @(@{ Cmd = 'claude'; Name = 'Claude Code' }, @{ Cmd = 'opencode'; Name = 'opencode' })) {
    $c = Get-Command $agent.Cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Write-Output "  $($agent.Name): $($c.Source)" }
    else { Write-Warning "$($agent.Name) не найден в PATH — этот агент будет недоступен мосту" }
  }

  # 2. Зависимости моста
  if (-not $SkipNpm) {
    if (-not $CustomData) {
      $keepers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind keeper)
      if ($keepers.Count) {
        $msg = "Живые сессии моста ($($keepers.Count)) держат файлы bridge\node_modules — завершите их (выйдите из агентов) или запустите install.ps1 -SkipNpm"
        if ($DryRun) { Write-Warning $msg } else { throw $msg }
      }
      $servers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind server)
      if ($servers.Count) {
        Say "Останавливаю работающий мост (PID $(($servers | ForEach-Object { $_.ProcessId }) -join ', ')) — сессии не затрагиваются"
        if (-not $DryRun) { $servers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Milliseconds 500 }
      }
    }
    Say 'npm ci в bridge\ (зависимости моста)'
    if (-not $DryRun) {
      Push-Location $BridgeDir
      try {
        Invoke-CbNative { & npm ci --no-audit --no-fund }
        if ($LASTEXITCODE -ne 0) { throw "npm ci завершился с кодом $LASTEXITCODE" }
      } finally { Pop-Location }
    }
  }

  # 3. Каталог данных и конфиг (мост сделал бы то же при первом старте)
  foreach ($sub in @('', 'sessions', 'logs', 'certs', 'bin')) {
    $d = if ($sub) { Join-Path $DataRoot $sub } else { $DataRoot }
    if (-not (Test-Path -LiteralPath $d)) {
      Say "Каталог $d"
      if (-not $DryRun) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
  }
  if (Test-Path -LiteralPath $Config) { Write-Output "  Конфиг уже есть: $Config (не изменяется)" }
  else {
    Say "Конфиг $Config (из bridge\config.example.json)"
    if (-not $DryRun) { Copy-Item -LiteralPath (Join-Path $BridgeDir 'config.example.json') -Destination $Config }
  }

  # 4. Шим claude-mobile (P-4); .cmd читается cmd.exe в OEM-кодировке
  Say "Шим claude-mobile: $Shim"
  if (-not $DryRun) {
    $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    [IO.File]::WriteAllText($Shim, (New-CbShimContent -AttachJs (Join-Path $BridgeDir 'attach.js')), $oem)
  }

  # 5. PATH пользователя (P-4)
  if (-not $SkipPath) {
    $cur = Get-CbUserPath
    $new = Add-CbPathEntry -PathValue $cur -Entry $BinDir
    if ($new -ceq $cur) { Write-Output "  $BinDir уже в PATH пользователя" }
    else {
      Say "Добавляю $BinDir в PATH пользователя (действует в новых окнах консоли)"
      if (-not $DryRun) { Set-CbUserPath -Value $new }
    }
  }

  # 6. Хук Claude Code (P-6)
  if (-not $SkipHook) {
    $hookArgs = @((Join-Path $BridgeDir 'tools\install-hooks.js'), 'install', '--settings', $SettingsPath)
    if ($DryRun) { $hookArgs += '--dry-run' }
    Invoke-CbNative { & $node.Source @hookArgs }
    if ($LASTEXITCODE -ne 0) { throw "Хук Claude Code не установлен (код $LASTEXITCODE)" }
  }

  # 7. Автозапуск (P-4): задача Планировщика при входе пользователя, в его сеансе, не служба;
  #    если её не зарегистрировать (например, нужны права администратора) — ярлык автозагрузки (D-25 п. 4)
  $Autostart = 'none'
  if (-not $SkipTask) {
    $spec = Get-CbTaskSpec -NodeExe $node.Source -BridgeDir $BridgeDir
    $lnk = Get-CbStartupShortcutSpec -NodeExe $node.Source -BridgeDir $BridgeDir -StartupDir $StartupDir -Name $TaskName
    $useShortcut = [bool]$StartupShortcut
    if (-not $useShortcut) {
      $user = "$env:USERDOMAIN\$env:USERNAME"
      Say "Задача Планировщика «$TaskName»: при входе $user -> $($spec.Execute) $($spec.Argument)"
      if ($DryRun) {
        $Autostart = 'task'
        Write-Output "  (если задачу не удастся зарегистрировать — ярлык автозагрузки $($lnk.Path), D-25 п. 4)"
      } else {
        $action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Argument -WorkingDirectory $spec.WorkingDirectory
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
          -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        try {
          Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
            -Settings $settings -Description 'Claude Bridge: мост телефон <-> агенты (P-4)' -Force | Out-Null
          $Autostart = 'task'
        } catch {
          Write-Warning "Задачу Планировщика не удалось зарегистрировать: $($_.Exception.Message). Запасной вариант — ярлык в папке автозагрузки (D-25 п. 4)"
          $useShortcut = $true
        }
        if ($Autostart -eq 'task' -and (Test-Path -LiteralPath $lnk.Path)) {
          Say "Удаляю прежний ярлык автозагрузки $($lnk.Path) (автозапуск теперь — задача Планировщика)"
          Remove-Item -LiteralPath $lnk.Path -Force
        }
      }
    }
    if ($useShortcut) {
      Say "Ярлык автозагрузки $($lnk.Path) -> $($lnk.TargetPath) $($lnk.Arguments)"
      if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $StartupDir)) { New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null }
        New-CbStartupShortcut -Spec $lnk
      }
      $Autostart = 'shortcut'
    }
  }

  # 8. Брандмауэр (P-4, по желанию): повышение прав — только для этого шага
  if ($Firewall) {
    $port = Get-CbBridgePort -ConfigPath $Config
    $fwScript = Join-Path $BridgeDir 'tools\firewall.ps1'
    if ($DryRun) { & $fwScript -Action add -Port $port -DryRun }
    elseif (Test-CbElevated) { & $fwScript -Action add -Port $port }
    else {
      Write-Output '  Правила брандмауэра требуют прав администратора — Windows запросит подтверждение (UAC)'
      try {
        $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru `
          -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$fwScript`" -Action add -Port $port"
        if ($p.ExitCode -eq 0) { Write-Output "  Правила брандмауэра добавлены: TCP $port, UDP $($port + 1), профиль «Частная сеть»" }
        else { Write-Warning "Правила брандмауэра не добавлены (код $($p.ExitCode))" }
      } catch { Write-Warning "Правила брандмауэра не добавлены: $($_.Exception.Message)" }
    }
  }

  # 9. Запуск моста
  if ($NoStart -or $CustomData) { Write-Output '  Мост не запускается (-NoStart или нестандартный -DataRoot)' }
  else {
    Say 'Запускаю мост'
    if (-not $DryRun) {
      if ($Autostart -eq 'task') { Start-ScheduledTask -TaskName $TaskName }
      else { & $node.Source (Join-Path $BridgeDir 'start-bridge.js') }
      $port = Get-CbBridgePort -ConfigPath $Config
      $deadline = (Get-Date).AddSeconds(30)
      $up = $false
      while (-not $up -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $up = [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) -and
          (@(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind server).Count -gt 0)
      }
      $log = Join-Path $DataRoot 'logs\bridge.log'
      if ($up) { Write-Output "  Мост слушает порт $port; лог: $log" }
      else { Write-Warning "Мост не начал слушать порт $port за 30 с — смотрите $log" }
    }
  }

  Write-Output ''
  Write-Output 'Готово. Дальше:'
  Write-Output '  1. Откройте НОВОЕ окно консоли (PATH обновлён) и выполните: claude-mobile --qr'
  Write-Output '  2. Отсканируйте QR в приложении Claude Bridge на телефоне.'
  Write-Output '  Сессия с зеркалом на телефон: claude-mobile (агент по умолчанию) или claude-mobile --agent opencode'
  Write-Output "  Конфиг: $Config"
} catch {
  # своё сообщение, пока вывод в UTF-8: необработанную ошибку PowerShell напечатал бы уже
  # после восстановления кодировки консоли (кириллица в перенаправленном выводе ломается)
  Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
  $failed = $true
} finally {
  try { [Console]::OutputEncoding = $prevEncoding } catch { }
}
if ($failed) { exit 1 }
