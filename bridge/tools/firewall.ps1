# Правила брандмауэра моста (P-4): вход TCP <port> и UDP <port+1> только в профиле «Частная сеть».
# Нужны права администратора: install.ps1 / uninstall.ps1 запускают этот файл с повышением (UAC).
param(
  [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action,
  [int]$Port = 8790,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
. (Join-Path $PSScriptRoot 'install-lib.ps1')

foreach ($c in (Get-CbFirewallCommands -Port $Port -Action $Action)) {
  if ($DryRun) { Write-Output ('[dry-run] netsh ' + ($c -join ' ')); continue }
  Invoke-CbNative { & netsh @c } | Out-Null
  # delete без совпадений возвращает 1 — это нормально (правила ещё не было)
  if ($c[2] -ne 'delete' -and $LASTEXITCODE -ne 0) { throw "netsh $($c -join ' ') завершился с кодом $LASTEXITCODE" }
}
if (-not $DryRun) {
  if ($Action -eq 'add') { Write-Output "Правила брандмауэра добавлены: TCP $Port, UDP $($Port + 1), профиль «Частная сеть»" }
  else { Write-Output 'Правила брандмауэра ClaudeBridge-TCP / ClaudeBridge-UDP удалены' }
}
