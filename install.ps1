<#
.SYNOPSIS
  Установка Claude Bridge на личный Windows-ПК (P-4, P-6, P-8).
.DESCRIPTION
  Проверка Node.js / Claude Code / opencode, npm ci в bridge\, каталог данных и config.json,
  шим claude-mobile в PATH пользователя, хук Claude Code в settings.json пользователя (с резервной
  копией), задача Планировщика «при входе» (если её не зарегистрировать — ярлык в папке
  автозагрузки, D-25 п. 4), запуск (перезапуск) моста. -Firewall — правила брандмауэра (UAC).
  -StartupShortcut — ярлык автозагрузки вместо задачи Планировщика (D-26 п. 1).
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
  $SettingsPath = [IO.Path]::GetFullPath($SettingsPath)
  $CustomSettings = -not (Test-CbSamePath -A $SettingsPath -B (Join-Path $env:USERPROFILE '.claude\settings.json'))
  $StartupDir = [IO.Path]::GetFullPath($StartupDir)
  $CustomStartup = -not (Test-CbSamePath -A $StartupDir -B ([Environment]::GetFolderPath('Startup')))
  $BinDir = Join-Path $DataRoot 'bin'
  $Shim = Join-Path $BinDir 'claude-mobile.cmd'
  $Config = Join-Path $DataRoot 'config.json'
  $Pre = if ($DryRun) { '[dry-run] ' } else { '' }
  function Say([string]$Text) { Write-Output ($Pre + $Text) }

  # Защита тестовых запусков (D-26 п. 4): нестандартный -DataRoot не должен задеть реальную систему
  $SafeAutostart = $SkipTask -or ($StartupShortcut -and $CustomStartup)
  $violations = @(Get-CbGuardViolations -CustomData $CustomData -DryRun $DryRun.IsPresent -SkipPath $SkipPath.IsPresent `
      -SafeAutostart $SafeAutostart -CustomSettings $CustomSettings -SkipNpm $SkipNpm.IsPresent -Firewall $Firewall.IsPresent)
  if ($violations.Count) {
    throw ("Нестандартный -DataRoot ($DataRoot) — только для проверки: нужны -SkipPath, -SkipTask (или -StartupShortcut " +
      "-StartupDir <временный каталог>), нестандартный -SettingsPath, -SkipNpm и без -Firewall; или -DryRun. " +
      "Не выполнено: $($violations -join ', ')")
  }
  Write-Output "Claude Bridge: установка из $RepoRoot"

  # 1. Проверки
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'Node.js не найден в PATH (нужна версия 20 или новее): https://nodejs.org/' }
  $nodeVersion = ([string](& $node.Source -v)).Trim()
  if (-not (Test-CbNodeVersion -VersionText $nodeVersion)) { throw "Нужен Node.js 20 или новее, найден $nodeVersion" }
  Write-Output "  Node.js $nodeVersion — $($node.Source)"
  if ((Test-CbEphemeralNodePath -NodePath $node.Source) -or ($env:TEMP -and (Test-CbEphemeralNodePath -NodePath $node.Source -TempDir $env:TEMP))) {
    Write-Warning ("node.exe во временном каталоге ($($node.Source)) — например, после «fnm use» в этой консоли. " +
      'Автозапуск ссылается на этот путь и после перезагрузки не сработает: установите Node.js постоянно ' +
      '(или версию fnm по умолчанию) и запустите install.ps1 заново.')
  }
  foreach ($agent in @(@{ Cmd = 'claude'; Name = 'Claude Code' }, @{ Cmd = 'opencode'; Name = 'opencode' })) {
    $c = Get-Command $agent.Cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Write-Output "  $($agent.Name): $($c.Source)" }
    else { Write-Warning "$($agent.Name) не найден в PATH — этот агент будет недоступен мосту" }
  }

  # «Наш» мост — процесс server.js этого репозитория, слушающий порт из конфига (ревью I-6)
  $BridgePort = Get-CbBridgePortOrDefault -ConfigPath $Config
  $stopped = $false
  # вывод функции идёт в консоль, результат — в $script:stopped
  function Stop-OurBridge([string]$Why) {
    $ours = @(Find-CbOurBridge -BridgeDir $BridgeDir -Port $BridgePort)
    if (-not $ours.Count) { return }
    Say "$Why (PID $(($ours | ForEach-Object { $_.ProcessId }) -join ', ')) — сессии не затрагиваются"
    if (-not $DryRun) {
      $ours | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
      $deadline = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $deadline -and @(Find-CbOurBridge -BridgeDir $BridgeDir -Port $BridgePort).Count) { Start-Sleep -Milliseconds 200 }
    }
    $script:stopped = $true
  }

  # 2. Зависимости моста
  if (-not $SkipNpm) {
    if (-not $CustomData) {
      # живые keeper'ы держат файлы node-pty в bridge\node_modules; не удалось проверить — не рискуем
      try { $keepers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind keeper) }
      catch { throw "Не удалось получить список процессов (WMI/CIM: $($_.Exception.Message)) — npm ci небезопасен при живых сессиях. Запустите install.ps1 -SkipNpm" }
      if ($keepers.Count) {
        $msg = "Живые сессии моста ($($keepers.Count)) держат файлы bridge\node_modules — завершите их (выйдите из агентов) или запустите install.ps1 -SkipNpm"
        if ($DryRun) { Write-Warning $msg } else { throw $msg }
      }
      Stop-OurBridge 'Останавливаю работающий мост на время npm ci'
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
        try {
          Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
            -Settings (New-CbTaskSettings) -Description 'Claude Bridge: мост телефон <-> агенты (P-4)' -Force | Out-Null
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
      # ревью M-8: прежняя задача запускала бы мост второй раз; при проверках Планировщик не трогаем
      if (-not $CustomData -and (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        Say "Удаляю задачу Планировщика «$TaskName» (автозапуск теперь — ярлык)"
        if (-not $DryRun) {
          try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
          catch { Write-Warning "Задачу «$TaskName» удалить не удалось: $($_.Exception.Message)" }
        }
      }
    }
  }

  # 8. Брандмауэр (P-4, по желанию): повышение прав — только для этого шага; ошибка — предупреждение
  if ($Firewall) {
    try { $fwPort = Get-CbBridgePort -ConfigPath $Config }
    catch { $fwPort = $null; Write-Warning "Правила брандмауэра не добавлены: $($_.Exception.Message)" }
    if ($fwPort) { Invoke-CbFirewall -Action add -Port $fwPort -Script (Join-Path $BridgeDir 'tools\firewall.ps1') -DryRun:$DryRun }
  }

  # 9. Запуск моста; работающий мост перезапускается — иначе остался бы со старым кодом (ревью M-13)
  if ($CustomData) { Write-Output '  Мост не запускается (нестандартный -DataRoot)' }
  elseif ($NoStart) {
    $running = @()
    if (-not $stopped) { try { $running = @(Find-CbOurBridge -BridgeDir $BridgeDir -Port $BridgePort) } catch { } }
    if ($running.Count) { Write-Output "  Мост работает (PID $(($running | ForEach-Object { $_.ProcessId }) -join ', ')) со старым кодом — перезапустите: install.ps1 без -NoStart" }
    Write-Output '  Мост не запускается (-NoStart)'
  } else {
    $wasStopped = $stopped
    if (-not $wasStopped) {
      try { Stop-OurBridge 'Перезапускаю работающий мост' }
      catch { Write-Warning "Не удалось проверить, работает ли мост: $($_.Exception.Message)" }
    }
    if ($wasStopped -or -not $stopped) { Say 'Запускаю мост' }
    if (-not $DryRun) {
      if ($Autostart -eq 'task') { Start-ScheduledTask -TaskName $TaskName }
      else { & $node.Source (Join-Path $BridgeDir 'start-bridge.js') }
      $BridgePort = Get-CbBridgePort -ConfigPath $Config
      $deadline = (Get-Date).AddSeconds(30)
      $up = $false
      while (-not $up -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $up = @(Find-CbOurBridge -BridgeDir $BridgeDir -Port $BridgePort).Count -gt 0
      }
      $log = Join-Path $DataRoot 'logs\bridge.log'
      if ($up) { Write-Output "  Мост слушает порт $BridgePort; лог: $log" }
      else { Write-Warning "Мост не начал слушать порт $BridgePort за 30 с — смотрите $log" }
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
