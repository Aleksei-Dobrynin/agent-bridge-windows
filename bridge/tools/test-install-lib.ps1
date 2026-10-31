# Проверки чистых функций install-lib.ps1 (запускается из bridge/test/install-lib.test.js).
# Код выхода 0 — все проверки прошли, 1 — есть провалы (строки FAIL в выводе).
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
. (Join-Path $PSScriptRoot 'install-lib.ps1')

$script:pass = 0
$script:fail = 0
function Check([string]$What, $Actual, $Expected) {
  if ($Actual -ceq $Expected) { $script:pass++ }
  else { $script:fail++; Write-Output "FAIL $What`n  expected: [$Expected]`n  actual:   [$Actual]" }
}

Check 'node v24' (Test-CbNodeVersion -VersionText 'v24.8.0') $true
Check 'node v20' (Test-CbNodeVersion -VersionText 'v20.0.0') $true
Check 'node v18' (Test-CbNodeVersion -VersionText 'v18.19.1') $false
Check 'node garbage' (Test-CbNodeVersion -VersionText 'garbage') $false

Check 'same path: case, slash' (Test-CbSamePath -A 'C:\CB\bin\' -B 'c:\cb\BIN') $true
Check 'same path: different' (Test-CbSamePath -A 'C:\CB\bin' -B 'C:\CB\bin2') $false

Check 'path add to empty' (Add-CbPathEntry -PathValue '' -Entry 'C:\CB\bin') 'C:\CB\bin'
Check 'path add keeps %VAR%' (Add-CbPathEntry -PathValue 'C:\a;%USERPROFILE%\b;' -Entry 'C:\CB\bin') 'C:\a;%USERPROFILE%\b;C:\CB\bin'
Check 'path add idempotent' (Add-CbPathEntry -PathValue 'C:\a;c:\cb\BIN\' -Entry 'C:\CB\bin') 'C:\a;c:\cb\BIN\'
Check 'path remove' (Remove-CbPathEntry -PathValue 'C:\a;C:\CB\bin;%X%\c' -Entry 'c:\cb\bin\') 'C:\a;%X%\c'
Check 'path remove absent keeps text' (Remove-CbPathEntry -PathValue 'C:\a;;C:\b' -Entry 'C:\CB\bin') 'C:\a;;C:\b'
Check 'path remove the only entry' (Remove-CbPathEntry -PathValue 'C:\CB\bin' -Entry 'C:\CB\bin') ''

Check 'shim' (New-CbShimContent -AttachJs 'D:\r\bridge\attach.js') "@echo off`r`nnode `"D:\r\bridge\attach.js`" %*`r`n"

$t = Get-CbTaskSpec -NodeExe 'C:\Program Files\nodejs\node.exe' -BridgeDir 'D:\r\bridge'
Check 'task execute' $t.Execute 'C:\Program Files\nodejs\node.exe'
Check 'task argument' $t.Argument '"D:\r\bridge\start-bridge.js"'
Check 'task workdir' $t.WorkingDirectory 'D:\r\bridge'

$fw = Get-CbFirewallCommands -Port 8790 -Action add
Check 'fw add count' $fw.Count 4
Check 'fw delete tcp' ($fw[0] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-TCP'
Check 'fw add tcp' ($fw[1] -join ' ') 'advfirewall firewall add rule name=ClaudeBridge-TCP dir=in action=allow protocol=TCP localport=8790 profile=private'
Check 'fw delete udp' ($fw[2] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-UDP'
Check 'fw add udp' ($fw[3] -join ' ') 'advfirewall firewall add rule name=ClaudeBridge-UDP dir=in action=allow protocol=UDP localport=8791 profile=private'
$fr = Get-CbFirewallCommands -Port 9000 -Action remove
Check 'fw remove count' $fr.Count 2
Check 'fw remove udp' ($fr[1] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-UDP'

Check 'cmdline match' (Test-CbCommandLineMatch -CommandLine '"C:\Program Files\nodejs\node.exe" D:\R\Bridge\keeper.js C:\x\s1.json' -Script 'd:\r\bridge\keeper.js') $true
Check 'cmdline other repo' (Test-CbCommandLineMatch -CommandLine 'node D:\other\bridge\keeper.js' -Script 'D:\r\bridge\keeper.js') $false
Check 'cmdline null' (Test-CbCommandLineMatch -CommandLine $null -Script 'D:\r\bridge\keeper.js') $false

# D-25 п. 4: ярлык автозагрузки — запасной механизм, если задачу Планировщика не зарегистрировать
$sc = Get-CbStartupShortcutSpec -NodeExe 'C:\Program Files\nodejs\node.exe' -BridgeDir 'D:\r\bridge' -StartupDir 'C:\S\Startup'
Check 'shortcut path' $sc.Path 'C:\S\Startup\ClaudeBridge.lnk'
Check 'shortcut target' $sc.TargetPath 'C:\Program Files\nodejs\node.exe'
Check 'shortcut arguments' $sc.Arguments '"D:\r\bridge\start-bridge.js"'
Check 'shortcut workdir' $sc.WorkingDirectory 'D:\r\bridge'
Check 'shortcut minimized' $sc.WindowStyle 7
Check 'shortcut custom name' (Get-CbStartupShortcutSpec -NodeExe 'n.exe' -BridgeDir 'D:\r\bridge' -StartupDir 'C:\S' -Name 'CB2').Path 'C:\S\CB2.lnk'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('cb-lib-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Check 'port: no config' (Get-CbBridgePort -ConfigPath (Join-Path $tmp 'none.json')) 8790
  Set-Content -LiteralPath (Join-Path $tmp 'c.json') -Value '{"port": 9100}' -Encoding ASCII
  Check 'port: from config' (Get-CbBridgePort -ConfigPath (Join-Path $tmp 'c.json')) 9100
  Set-Content -LiteralPath (Join-Path $tmp 'n.json') -Value '{"host": "auto"}' -Encoding ASCII
  Check 'port: default' (Get-CbBridgePort -ConfigPath (Join-Path $tmp 'n.json')) 8790
  Set-Content -LiteralPath (Join-Path $tmp 'bad.json') -Value '{"port": 70000}' -Encoding ASCII
  $threw = $false
  try { Get-CbBridgePort -ConfigPath (Join-Path $tmp 'bad.json') | Out-Null } catch { $threw = $true }
  Check 'port: invalid throws' $threw $true

  # ярлык создаётся во временном каталоге (не в shell:startup) и читается обратно через WScript.Shell
  $fakeNode = Join-Path $tmp 'node.exe'
  New-Item -ItemType File -Path $fakeNode | Out-Null
  $spec = Get-CbStartupShortcutSpec -NodeExe $fakeNode -BridgeDir $tmp -StartupDir (Join-Path $tmp 'Startup')
  New-Item -ItemType Directory -Path (Join-Path $tmp 'Startup') | Out-Null
  New-CbStartupShortcut -Spec $spec
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($spec.Path)
  Check 'shortcut file: target' $lnk.TargetPath $fakeNode
  Check 'shortcut file: arguments' $lnk.Arguments ('"{0}"' -f (Join-Path $tmp 'start-bridge.js'))
  Check 'shortcut file: workdir' $lnk.WorkingDirectory $tmp
  Check 'shortcut file: minimized' $lnk.WindowStyle 7
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force
}

Write-Output "passes: $($script:pass), fails: $($script:fail)"
if ($script:fail) { exit 1 }
