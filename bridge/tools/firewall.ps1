# Правила брандмауэра моста (P-4, D-26 п. 2): вход TCP <port> и UDP <port+1> только в профиле
# «Частная сеть» и только из локальной подсети. Удаление — по имени правил (порт не нужен).
# Нужны права администратора: install.ps1 / uninstall.ps1 запускают этот файл с повышением (UAC)
# и -PauseOnError — окно с ошибкой не закрывается сразу (ревью M-11).
param(
  [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action,
  [int]$Port = 8790,
  [switch]$DryRun,
  [switch]$PauseOnError
)
$ErrorActionPreference = 'Stop'
$prevEncoding = [Console]::OutputEncoding
$failed = $false
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  . (Join-Path $PSScriptRoot 'install-lib.ps1')
  foreach ($c in (Get-CbFirewallCommands -Port $Port -Action $Action)) {
    if ($DryRun) { Write-Output ('[dry-run] netsh ' + ($c -join ' ')); continue }
    Invoke-CbNative { & netsh @c } | Out-Null
    # delete без совпадений возвращает 1 — это нормально (правила ещё не было)
    if ($c[2] -ne 'delete' -and $LASTEXITCODE -ne 0) { throw "netsh $($c -join ' ') завершился с кодом $LASTEXITCODE" }
  }
  if (-not $DryRun) {
    if ($Action -eq 'add') { Write-Output "Правила брандмауэра добавлены: TCP $Port, UDP $($Port + 1), профиль «Частная сеть», локальная подсеть" }
    else { Write-Output 'Правила брандмауэра ClaudeBridge-TCP / ClaudeBridge-UDP удалены' }
  }
} catch {
  Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
  $failed = $true
  if ($PauseOnError) { try { Read-Host 'Нажмите Enter, чтобы закрыть окно' | Out-Null } catch { } }
} finally {
  try { [Console]::OutputEncoding = $prevEncoding } catch { }
}
if ($failed) { exit 1 }
