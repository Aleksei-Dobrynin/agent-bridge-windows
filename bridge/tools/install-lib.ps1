# Функции установщика Claude Bridge (P-4, P-6, P-8). Подключается dot-source'ом из install.ps1,
# uninstall.ps1, firewall.ps1. Чистые функции (без побочных эффектов) проверяет test-install-lib.ps1;
# побочные эффекты — только у Get-/Set-CbUserPath, Send-CbEnvironmentChanged, Find-Cb*,
# New-CbStartupShortcut, Invoke-CbFirewall.

# Правила брандмауэра (P-4, D-26 п. 2): вход TCP <port> и UDP <port+1> (маяк), только профиль
# «Частная сеть» и только из локальной подсети.
$script:CbFirewallRules = @(
  @{ Name = 'ClaudeBridge-TCP'; Protocol = 'TCP'; Offset = 0 },
  @{ Name = 'ClaudeBridge-UDP'; Protocol = 'UDP'; Offset = 1 }
)

function Test-CbNodeVersion {
  param([Parameter(Mandatory)][string]$VersionText, [int]$MinMajor = 20)
  if ($VersionText.Trim() -notmatch '^v?(\d+)\.') { return $false }
  return ([int]$Matches[1] -ge $MinMajor)
}

# Сравнение путей без учёта регистра и конечного «\»; %VAR% раскрываются (ревью M-12: каталог в PATH
# мог быть записан как %LOCALAPPDATA%\ClaudeBridge\bin).
function Test-CbSamePath {
  param([AllowEmptyString()][string]$A, [AllowEmptyString()][string]$B)
  $na = [Environment]::ExpandEnvironmentVariables($A.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant()
  $nb = [Environment]::ExpandEnvironmentVariables($B.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant()
  return ($na -ceq $nb)
}

# PATH пользователя как строка (%VAR% не раскрываются при записи): добавить каталог, если его нет.
function Add-CbPathEntry {
  param([AllowEmptyString()][string]$PathValue, [Parameter(Mandatory)][string]$Entry)
  foreach ($p in ($PathValue -split ';')) {
    if ($p.Trim() -and (Test-CbSamePath -A $p -B $Entry)) { return $PathValue }
  }
  $base = $PathValue.TrimEnd(';')
  if ($base) { return "$base;$Entry" }
  return $Entry
}

function Remove-CbPathEntry {
  param([AllowEmptyString()][string]$PathValue, [Parameter(Mandatory)][string]$Entry)
  $kept = @($PathValue -split ';' | Where-Object { -not ($_.Trim() -and (Test-CbSamePath -A $_ -B $Entry)) })
  return ($kept -join ';')
}

# Шим claude-mobile.cmd (P-4): node из PATH, как у bridge\claude-mobile.cmd.
function New-CbShimContent {
  param([Parameter(Mandatory)][string]$AttachJs)
  return "@echo off`r`nnode `"$AttachJs`" %*`r`n"
}

# Действие задачи Планировщика (P-4): node start-bridge.js из каталога моста.
function Get-CbTaskSpec {
  param([Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$BridgeDir)
  return @{
    Execute          = $NodeExe
    Argument         = ('"{0}"' -f (Join-Path $BridgeDir 'start-bridge.js'))
    WorkingDirectory = $BridgeDir
  }
}

# Параметры задачи (объект в памяти, без регистрации). Приоритет 4 — обычный (D-26 п. 3): по умолчанию
# у задач 7 (BELOW_NORMAL), и его унаследовали бы мост и все агенты.
function New-CbTaskSettings {
  return (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 4)
}

# Ярлык в shell:startup пользователя (D-25 п. 4, D-26 п. 1) — запасной или явный (-StartupShortcut)
# автозапуск. То же действие, что у задачи; окно консоли node — свёрнутым (7).
function Get-CbStartupShortcutSpec {
  param([Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$BridgeDir,
    [Parameter(Mandatory)][string]$StartupDir, [string]$Name = 'ClaudeBridge')
  $task = Get-CbTaskSpec -NodeExe $NodeExe -BridgeDir $BridgeDir
  return @{
    Path             = (Join-Path $StartupDir ($Name + '.lnk'))
    TargetPath       = $task.Execute
    Arguments        = $task.Argument
    WorkingDirectory = $task.WorkingDirectory
    WindowStyle      = 7
    Description      = 'Claude Bridge: мост телефон <-> агенты (P-4, D-25)'
  }
}

function New-CbStartupShortcut {
  param([Parameter(Mandatory)][hashtable]$Spec)
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Spec.Path)
  $lnk.TargetPath = $Spec.TargetPath
  $lnk.Arguments = $Spec.Arguments
  $lnk.WorkingDirectory = $Spec.WorkingDirectory
  $lnk.WindowStyle = $Spec.WindowStyle
  $lnk.Description = $Spec.Description
  $lnk.Save()
}

# Аргументы netsh: сначала удалить одноимённое правило (повторная установка), затем добавить.
# Удаление — по имени правила, порт не нужен (ревью I-2).
function Get-CbFirewallCommands {
  param([int]$Port = 8790, [ValidateSet('add', 'remove')][string]$Action = 'add')
  $cmds = @()
  foreach ($r in $script:CbFirewallRules) {
    $cmds += , @('advfirewall', 'firewall', 'delete', 'rule', "name=$($r.Name)")
    if ($Action -eq 'add') {
      $cmds += , @('advfirewall', 'firewall', 'add', 'rule', "name=$($r.Name)", 'dir=in', 'action=allow',
        "protocol=$($r.Protocol)", "localport=$($Port + $r.Offset)", 'remoteip=localsubnet', 'profile=private')
    }
  }
  return , $cmds
}

# Порт моста из config.json каталога данных (как server.js: целое 1..65533, нет ключа — 8790).
function Get-CbBridgePort {
  param([Parameter(Mandatory)][string]$ConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return 8790 }
  $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not ($cfg.PSObject.Properties.Name -contains 'port')) { return 8790 }
  $p = 0
  if ([int]::TryParse([string]$cfg.port, [ref]$p) -and $p -ge 1 -and $p -le 65533) { return $p }
  throw "Неверный port в $ConfigPath (нужно целое 1..65533)"
}

# Порт только для поиска своего моста: испорченный конфиг не должен ломать установку/удаление.
function Get-CbBridgePortOrDefault {
  param([Parameter(Mandatory)][string]$ConfigPath)
  try { return (Get-CbBridgePort -ConfigPath $ConfigPath) } catch { return 8790 }
}

# Скрипт в командной строке процесса: после пути — пробел, кавычка или конец (ревью M-7).
function Test-CbCommandLineMatch {
  param([AllowNull()][AllowEmptyString()][string]$CommandLine, [Parameter(Mandatory)][string]$Script)
  if (-not $CommandLine) { return $false }
  $cl = $CommandLine.ToLowerInvariant()
  $s = $Script.ToLowerInvariant()
  $i = $cl.IndexOf($s)
  while ($i -ge 0) {
    $end = $i + $s.Length
    if ($end -eq $cl.Length -or $cl[$end] -eq [char]' ' -or $cl[$end] -eq [char]'"') { return $true }
    $i = $cl.IndexOf($s, $i + 1)
  }
  return $false
}

# «Наш» мост (ревью I-6): server.js этого репозитория, владеющий слушающим портом моста. Мосты
# тестов из того же репозитория слушают другие порты и не затрагиваются.
function Select-CbBridgeServer {
  param([AllowEmptyCollection()][object[]]$Processes = @(), [AllowEmptyCollection()][int[]]$ListenPids = @(),
    [Parameter(Mandatory)][string]$Script)
  return @($Processes | Where-Object {
      $null -ne $_ -and ($ListenPids -contains [int]$_.ProcessId) -and (Test-CbCommandLineMatch -CommandLine $_.CommandLine -Script $Script)
    })
}

# Keeper'ы каталога данных: meta-файл сессии — <DataRoot>\sessions\<id>.json в командной строке.
function Select-CbKeeperForData {
  param([AllowEmptyCollection()][object[]]$Processes = @(), [Parameter(Mandatory)][string]$DataRoot)
  $needle = ($DataRoot.Trim().Trim('"').TrimEnd('\') + '\sessions\').ToLowerInvariant()
  return @($Processes | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) })
}

# Процессы node.exe этого репозитория: server — мост, keeper — хранители сессий. Ошибка WMI/CIM —
# исключение, а не пустой список (ревью I-6: иначе npm ci пошёл бы при живых сессиях).
function Get-CbNodeProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
}

function Find-CbBridgeProcess {
  param([Parameter(Mandatory)][string]$BridgeDir, [Parameter(Mandatory)][ValidateSet('server', 'keeper')][string]$Kind)
  $script = Join-Path $BridgeDir ($Kind + '.js')
  return @(Get-CbNodeProcesses | Where-Object { Test-CbCommandLineMatch -CommandLine $_.CommandLine -Script $script })
}

function Find-CbOurBridge {
  param([Parameter(Mandatory)][string]$BridgeDir, [Parameter(Mandatory)][int]$Port)
  $listen = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
  if (-not $listen.Count) { return @() }
  return @(Select-CbBridgeServer -Processes (Get-CbNodeProcesses) -ListenPids $listen -Script (Join-Path $BridgeDir 'server.js'))
}

function Find-CbKeeperForData {
  param([Parameter(Mandatory)][string]$BridgeDir, [Parameter(Mandatory)][string]$DataRoot)
  $keepers = @(Get-CbNodeProcesses | Where-Object { Test-CbCommandLineMatch -CommandLine $_.CommandLine -Script (Join-Path $BridgeDir 'keeper.js') })
  return @(Select-CbKeeperForData -Processes $keepers -DataRoot $DataRoot)
}

# Защита тестовых запусков (D-26 п. 4): нестандартный -DataRoot без -DryRun — только с -SkipPath,
# безопасным автозапуском, нестандартным -SettingsPath, -SkipNpm и без -Firewall. Возвращает
# недостающие/запрещённые ключи (пусто — можно).
function Get-CbGuardViolations {
  param([bool]$CustomData, [bool]$DryRun, [bool]$SkipPath, [bool]$SafeAutostart, [bool]$CustomSettings,
    [bool]$SkipNpm, [bool]$Firewall, [bool]$NoNpmStep = $false)
  $v = @()
  if (-not $CustomData -or $DryRun) { return $v }
  if (-not $SkipPath) { $v += '-SkipPath' }
  if (-not $SafeAutostart) { $v += '-SkipTask' }
  if (-not $CustomSettings) { $v += '-SettingsPath' }
  if (-not $NoNpmStep -and -not $SkipNpm) { $v += '-SkipNpm' }
  if ($Firewall) { $v += '-Firewall' }
  return $v
}

# -RemoveData (ревью I-4): удалять можно только каталог данных моста. Возвращает причину отказа или $null.
function Get-CbDataDirRefusal {
  param([Parameter(Mandatory)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path)).TrimEnd('\')
  if (-not $full -or $full -ieq $root) { return "$Path — корень диска" }
  $parent = [IO.Path]::GetDirectoryName($full)
  if ($null -eq $parent -or $parent.TrimEnd('\') -ieq $root) { return "$Path — каталог в корне диска" }
  foreach ($sys in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA)) {
    if ($sys -and (Test-CbSamePath -A $full -B $sys)) { return "$Path — системный каталог профиля" }
  }
  if ((Split-Path -Leaf $full) -ieq 'ClaudeBridge') { return $null }
  $hasConfig = Test-Path -LiteralPath (Join-Path $full 'config.json') -PathType Leaf
  $hasSub = (Test-Path -LiteralPath (Join-Path $full 'certs') -PathType Container) -or
    (Test-Path -LiteralPath (Join-Path $full 'sessions') -PathType Container)
  if ($hasConfig -and $hasSub) { return $null }
  return "$Path не похож на каталог данных моста (нужны config.json и certs\ или sessions\)"
}

# node.exe из временного каталога (fnm use, %TEMP%) пропадёт после перезагрузки — автозапуск сломается (ревью M-14).
function Test-CbEphemeralNodePath {
  param([Parameter(Mandatory)][string]$NodePath, [string]$TempDir = [IO.Path]::GetTempPath())
  $p = $NodePath.ToLowerInvariant()
  if ($p.Contains('\fnm_multishells\')) { return $true }
  $t = $TempDir.TrimEnd('\').ToLowerInvariant() + '\'
  return $p.StartsWith($t)
}

# Нативная команда (npm, node, netsh): её stderr — не ошибка PowerShell. При $ErrorActionPreference='Stop'
# Windows PowerShell 5.1 с перенаправленными потоками может превратить строку stderr в NativeCommandError.
# Код выхода — в $LASTEXITCODE, проверяет вызывающий.
function Invoke-CbNative {
  param([Parameter(Mandatory)][scriptblock]$Block)
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $eap }
}

function Test-CbElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Брандмауэр (ревью M-11): -DryRun — только печать; иначе firewall.ps1 напрямую (уже администратор)
# или в окне с повышением (UAC), которое при ошибке ждёт Enter. Ошибка — предупреждение, не отказ установки.
function Invoke-CbFirewall {
  param([Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action, [int]$Port = 8790,
    [Parameter(Mandatory)][string]$Script, [switch]$DryRun)
  if ($DryRun) { & $Script -Action $Action -Port $Port -DryRun; return }
  $what = if ($Action -eq 'add') { 'не добавлены' } else { 'не удалены' }
  try {
    if (Test-CbElevated) {
      $global:LASTEXITCODE = 0
      & $Script -Action $Action -Port $Port
      if ($LASTEXITCODE) { Write-Warning "Правила брандмауэра $what (код $LASTEXITCODE)" }
    } else {
      Write-Output '  Правила брандмауэра требуют прав администратора — Windows запросит подтверждение (UAC)'
      $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Action $Action -Port $Port -PauseOnError"
      if ($p.ExitCode -eq 0) {
        if ($Action -eq 'add') { Write-Output "  Правила брандмауэра добавлены: TCP $Port, UDP $($Port + 1), профиль «Частная сеть», локальная подсеть" }
        else { Write-Output '  Правила брандмауэра ClaudeBridge-TCP / ClaudeBridge-UDP удалены' }
      } else { Write-Warning "Правила брандмауэра $what (код $($p.ExitCode))" }
    }
  } catch { Write-Warning "Правила брандмауэра ${what}: $($_.Exception.Message)" }
}

# PATH пользователя — напрямую из реестра, без раскрытия %VAR% (иначе запись назад потеряла бы их).
# -SubKey — только для проверок (временный ключ вместо Environment).
function Get-CbUserPath {
  param([string]$SubKey = 'Environment')
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey)
  if ($null -eq $k) { return '' }
  try { return [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $k.Close() }
}

# Ревью M-12: тип значения (REG_SZ / REG_EXPAND_SZ) сохраняется, новое — REG_EXPAND_SZ; пустое значение удаляется.
function Set-CbUserPath {
  param([AllowEmptyString()][string]$Value, [string]$SubKey = 'Environment')
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
  try {
    $exists = $k.GetValueNames() -contains 'Path'
    if (-not $Value) {
      if ($exists) { $k.DeleteValue('Path') }
    } else {
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($exists -and $k.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::String) {
        $kind = [Microsoft.Win32.RegistryValueKind]::String
      }
      $k.SetValue('Path', $Value, $kind)
    }
  } finally { $k.Close() }
  if ($SubKey -eq 'Environment') { Send-CbEnvironmentChanged }
}

# WM_SETTINGCHANGE "Environment": Проводник и новые окна консоли увидят новый PATH без выхода из системы.
function Send-CbEnvironmentChanged {
  if (-not ('CbNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CbNative {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
  }
  $result = [UIntPtr]::Zero
  [void][CbNative]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
