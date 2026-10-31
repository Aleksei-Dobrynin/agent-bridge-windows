# Функции установщика Claude Bridge (P-4, P-6, P-8). Подключается dot-source'ом из install.ps1,
# uninstall.ps1, firewall.ps1. Чистые функции (без побочных эффектов) проверяет test-install-lib.ps1;
# побочные эффекты — только у Get-/Set-CbUserPath, Send-CbEnvironmentChanged, Find-CbBridgeProcess,
# New-CbStartupShortcut.

# Правила брандмауэра (P-4): вход TCP <port> и UDP <port+1> (маяк), только профиль «Частная сеть».
$script:CbFirewallRules = @(
  @{ Name = 'ClaudeBridge-TCP'; Protocol = 'TCP'; Offset = 0 },
  @{ Name = 'ClaudeBridge-UDP'; Protocol = 'UDP'; Offset = 1 }
)

function Test-CbNodeVersion {
  param([Parameter(Mandatory)][string]$VersionText, [int]$MinMajor = 20)
  if ($VersionText.Trim() -notmatch '^v?(\d+)\.') { return $false }
  return ([int]$Matches[1] -ge $MinMajor)
}

function Test-CbSamePath {
  param([AllowEmptyString()][string]$A, [AllowEmptyString()][string]$B)
  $na = $A.Trim().Trim('"').TrimEnd('\').ToLowerInvariant()
  $nb = $B.Trim().Trim('"').TrimEnd('\').ToLowerInvariant()
  return ($na -ceq $nb)
}

# PATH пользователя как строка (REG_EXPAND_SZ, %VAR% не раскрываются): добавить каталог, если его нет.
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

# Ярлык в shell:startup пользователя (D-25 п. 4) — запасной автозапуск, если задачу Планировщика
# не удалось зарегистрировать. То же действие, что у задачи; окно консоли node — свёрнутым (7).
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
function Get-CbFirewallCommands {
  param([Parameter(Mandatory)][int]$Port, [ValidateSet('add', 'remove')][string]$Action = 'add')
  $cmds = @()
  foreach ($r in $script:CbFirewallRules) {
    $cmds += , @('advfirewall', 'firewall', 'delete', 'rule', "name=$($r.Name)")
    if ($Action -eq 'add') {
      $cmds += , @('advfirewall', 'firewall', 'add', 'rule', "name=$($r.Name)", 'dir=in', 'action=allow',
        "protocol=$($r.Protocol)", "localport=$($Port + $r.Offset)", 'profile=private')
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

function Test-CbCommandLineMatch {
  param([AllowNull()][AllowEmptyString()][string]$CommandLine, [Parameter(Mandatory)][string]$Script)
  if (-not $CommandLine) { return $false }
  return $CommandLine.ToLowerInvariant().Contains($Script.ToLowerInvariant())
}

# Процессы node.exe этого репозитория: server — мост, keeper — хранители сессий.
function Find-CbBridgeProcess {
  param([Parameter(Mandatory)][string]$BridgeDir, [Parameter(Mandatory)][ValidateSet('server', 'keeper')][string]$Kind)
  $script = Join-Path $BridgeDir ($Kind + '.js')
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-CbCommandLineMatch -CommandLine $_.CommandLine -Script $script })
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

# PATH пользователя — напрямую из реестра, без раскрытия %VAR% (иначе запись назад потеряла бы их).
function Get-CbUserPath {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if ($null -eq $k) { return '' }
  try { return [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $k.Close() }
}

function Set-CbUserPath {
  param([AllowEmptyString()][string]$Value)
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try { $k.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
  finally { $k.Close() }
  Send-CbEnvironmentChanged
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
