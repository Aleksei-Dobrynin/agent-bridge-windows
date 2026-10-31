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
Check 'fw add tcp' ($fw[1] -join ' ') 'advfirewall firewall add rule name=ClaudeBridge-TCP dir=in action=allow protocol=TCP localport=8790 remoteip=localsubnet profile=private'
Check 'fw delete udp' ($fw[2] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-UDP'
Check 'fw add udp' ($fw[3] -join ' ') 'advfirewall firewall add rule name=ClaudeBridge-UDP dir=in action=allow protocol=UDP localport=8791 remoteip=localsubnet profile=private'
$fr = Get-CbFirewallCommands -Action remove
Check 'fw remove count' $fr.Count 2
Check 'fw remove udp' ($fr[1] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-UDP'

Check 'cmdline match' (Test-CbCommandLineMatch -CommandLine '"C:\Program Files\nodejs\node.exe" D:\R\Bridge\keeper.js C:\x\s1.json' -Script 'd:\r\bridge\keeper.js') $true
Check 'cmdline other repo' (Test-CbCommandLineMatch -CommandLine 'node D:\other\bridge\keeper.js' -Script 'D:\r\bridge\keeper.js') $false
Check 'cmdline null' (Test-CbCommandLineMatch -CommandLine $null -Script 'D:\r\bridge\keeper.js') $false
# ревью M-7: после пути — пробел, кавычка или конец строки
Check 'cmdline quoted' (Test-CbCommandLineMatch -CommandLine 'node "D:\r\bridge\server.js"' -Script 'D:\r\bridge\server.js') $true
Check 'cmdline at end' (Test-CbCommandLineMatch -CommandLine 'node D:\r\bridge\server.js' -Script 'D:\r\bridge\server.js') $true
Check 'cmdline longer name' (Test-CbCommandLineMatch -CommandLine 'node D:\r\bridge\server.js.bak' -Script 'D:\r\bridge\server.js') $false
Check 'cmdline prefix dir' (Test-CbCommandLineMatch -CommandLine 'node D:\r\bridge\server.jsx x' -Script 'D:\r\bridge\server.js') $false
Check 'cmdline second hit' (Test-CbCommandLineMatch -CommandLine 'x D:\r\bridge\server.js2 D:\r\bridge\server.js' -Script 'D:\r\bridge\server.js') $true

# ревью I-6: «наш» мост — процесс server.js этого репозитория, владеющий слушающим портом моста
$procs = @(
  [pscustomobject]@{ ProcessId = 10; CommandLine = 'node D:\r\bridge\server.js' },   # тестовый мост на другом порту
  [pscustomobject]@{ ProcessId = 11; CommandLine = 'node "D:\r\bridge\server.js"' },  # наш
  [pscustomobject]@{ ProcessId = 12; CommandLine = 'node D:\other\bridge\server.js' }, # чужой репозиторий на нашем порту
  [pscustomobject]@{ ProcessId = 13; CommandLine = $null }
)
Check 'our bridge: port owner + cmdline' ((@(Select-CbBridgeServer -Processes $procs -ListenPids @(11, 12) -Script 'D:\r\bridge\server.js') | ForEach-Object { $_.ProcessId }) -join ',') '11'
Check 'our bridge: nobody listens' @(Select-CbBridgeServer -Processes $procs -ListenPids @() -Script 'D:\r\bridge\server.js').Count 0
$keep = @(
  [pscustomobject]@{ ProcessId = 20; CommandLine = 'node D:\r\bridge\keeper.js C:\Data\CB\sessions\a1.json' },
  [pscustomobject]@{ ProcessId = 21; CommandLine = 'node D:\r\bridge\keeper.js "C:\Temp\cb-x\sessions\b2.json"' },
  [pscustomobject]@{ ProcessId = 22; CommandLine = 'node D:\r\bridge\keeper.js C:\Data\CB2\sessions\c3.json' }
)
Check 'keepers of data dir' ((@(Select-CbKeeperForData -Processes $keep -DataRoot 'c:\data\cb\') | ForEach-Object { $_.ProcessId }) -join ',') '20'
Check 'keepers of temp data dir' ((@(Select-CbKeeperForData -Processes $keep -DataRoot 'C:\Temp\cb-x') | ForEach-Object { $_.ProcessId }) -join ',') '21'

# ревью M-12: каталог в PATH, записанный через переменную, — тот же каталог
$env:CB_TEST_ROOT = 'C:\CBroot'
Check 'same path: %VAR%' (Test-CbSamePath -A '%CB_TEST_ROOT%\bin' -B 'c:\cbroot\BIN\') $true
Check 'path add: %VAR% entry already present' (Add-CbPathEntry -PathValue 'C:\a;%CB_TEST_ROOT%\bin' -Entry 'C:\CBroot\bin') 'C:\a;%CB_TEST_ROOT%\bin'
Check 'path remove: %VAR% entry' (Remove-CbPathEntry -PathValue 'C:\a;%CB_TEST_ROOT%\bin;C:\b' -Entry 'C:\CBroot\bin') 'C:\a;C:\b'
Remove-Item Env:\CB_TEST_ROOT

# ревью I-5 (D-26 п. 3): задача с обычным приоритетом (4), объект настроек — в памяти
$ts = New-CbTaskSettings
Check 'task priority' $ts.Priority 4
Check 'task no time limit' $ts.ExecutionTimeLimit 'PT0S'
Check 'task single instance' ([string]$ts.MultipleInstances) 'IgnoreNew'
Check 'task on batteries' $ts.DisallowStartIfOnBatteries $false

# ревью I-3 (D-26 п. 4): тестовый запуск с нестандартным -DataRoot
$ok = @{ CustomData = $true; DryRun = $false; SkipPath = $true; SafeAutostart = $true; CustomSettings = $true; SkipNpm = $true; Firewall = $false }
Check 'guard: safe test run' ((Get-CbGuardViolations @ok) -join ',') ''
Check 'guard: standard data dir' ((Get-CbGuardViolations -CustomData $false -DryRun $false -SkipPath $false -SafeAutostart $false -CustomSettings $false -SkipNpm $false -Firewall $true) -join ',') ''
Check 'guard: dry run' ((Get-CbGuardViolations -CustomData $true -DryRun $true -SkipPath $false -SafeAutostart $false -CustomSettings $false -SkipNpm $false -Firewall $true) -join ',') ''
Check 'guard: everything missing' ((Get-CbGuardViolations -CustomData $true -DryRun $false -SkipPath $false -SafeAutostart $false -CustomSettings $false -SkipNpm $false -Firewall $true) -join ',') '-SkipPath,-SkipTask,-SettingsPath,-SkipNpm,-Firewall'
$noNpm = $ok.Clone(); $noNpm.SkipNpm = $false
Check 'guard: npm' ((Get-CbGuardViolations @noNpm) -join ',') '-SkipNpm'
$fwOn = $ok.Clone(); $fwOn.Firewall = $true
Check 'guard: firewall' ((Get-CbGuardViolations @fwOn) -join ',') '-Firewall'
$noNpmCheck = $ok.Clone(); $noNpmCheck.SkipNpm = $false; $noNpmCheck.NoNpmStep = $true
Check 'guard: uninstall has no npm step' ((Get-CbGuardViolations @noNpmCheck) -join ',') ''

# ревью M-14: node.exe из временного каталога (fnm, %TEMP%) — автозапуск сломается
Check 'node: fnm multishell' (Test-CbEphemeralNodePath -NodePath 'C:\Users\u\AppData\Local\fnm_multishells\123_456\node.exe' -TempDir 'C:\T') $true
Check 'node: temp' (Test-CbEphemeralNodePath -NodePath 'c:\t\x\node.exe' -TempDir 'C:\T\') $true
Check 'node: program files' (Test-CbEphemeralNodePath -NodePath 'C:\Program Files\nodejs\node.exe' -TempDir 'C:\T') $false
Check 'node: temp-like prefix' (Test-CbEphemeralNodePath -NodePath 'C:\Tools\node.exe' -TempDir 'C:\T') $false

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
  Check 'port or default: invalid' (Get-CbBridgePortOrDefault -ConfigPath (Join-Path $tmp 'bad.json')) 8790
  Check 'port or default: valid' (Get-CbBridgePortOrDefault -ConfigPath (Join-Path $tmp 'c.json')) 9100

  # ревью I-4: -RemoveData удаляет только каталог, распознанный как каталог данных моста
  $dd = Join-Path $tmp 'data'
  New-Item -ItemType Directory -Path (Join-Path $dd 'certs') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $dd 'config.json') -Value '{}' -Encoding ASCII
  Check 'data dir: config + certs' (Get-CbDataDirRefusal -Path $dd) $null
  $ds = Join-Path $tmp 'data2'
  New-Item -ItemType Directory -Path (Join-Path $ds 'sessions') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $ds 'config.json') -Value '{}' -Encoding ASCII
  Check 'data dir: config + sessions' (Get-CbDataDirRefusal -Path $ds) $null
  New-Item -ItemType Directory -Path (Join-Path $tmp 'ClaudeBridge') | Out-Null
  Check 'data dir: leaf ClaudeBridge' (Get-CbDataDirRefusal -Path (Join-Path $tmp 'ClaudeBridge')) $null
  $r1 = Join-Path $tmp 'random1'
  New-Item -ItemType Directory -Path $r1 | Out-Null
  Set-Content -LiteralPath (Join-Path $r1 'config.json') -Value '{}' -Encoding ASCII
  Check 'data dir: config only refused' ([bool](Get-CbDataDirRefusal -Path $r1)) $true
  $r2 = Join-Path $tmp 'random2'
  New-Item -ItemType Directory -Path (Join-Path $r2 'certs'), (Join-Path $r2 'sessions') -Force | Out-Null
  Check 'data dir: no config refused' ([bool](Get-CbDataDirRefusal -Path $r2)) $true
  $root = [IO.Path]::GetPathRoot($tmp)
  Check 'data dir: drive root refused' ([bool](Get-CbDataDirRefusal -Path $root)) $true
  Check 'data dir: child of drive root refused' ([bool](Get-CbDataDirRefusal -Path (Join-Path $root 'ClaudeBridge'))) $true
  Check 'data dir: USERPROFILE refused' ([bool](Get-CbDataDirRefusal -Path ($env:USERPROFILE + '\'))) $true
  Check 'data dir: LOCALAPPDATA refused' ([bool](Get-CbDataDirRefusal -Path $env:LOCALAPPDATA.ToUpperInvariant())) $true
  Check 'data dir: APPDATA refused' ([bool](Get-CbDataDirRefusal -Path $env:APPDATA)) $true

  # ревью M-12: PATH в реестре — на отдельном временном ключе HKCU (не Environment): тип значения
  # сохраняется, пустое значение удаляется; сообщение WM_SETTINGCHANGE для чужого ключа не шлётся
  $key = 'Software\ClaudeBridgeTest-' + [guid]::NewGuid().ToString('N')
  try {
    Check 'reg: absent' (Get-CbUserPath -SubKey $key) ''
    Set-CbUserPath -Value 'C:\a;%CB_X%' -SubKey $key
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
    Check 'reg: new value is REG_EXPAND_SZ' ([string]$k.GetValueKind('Path')) 'ExpandString'
    $k.Close()
    Check 'reg: %VAR% not expanded' (Get-CbUserPath -SubKey $key) 'C:\a;%CB_X%'
    $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($key)
    $k.SetValue('Path', 'C:\s', [Microsoft.Win32.RegistryValueKind]::String)
    $k.Close()
    Set-CbUserPath -Value 'C:\s;C:\t' -SubKey $key
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
    Check 'reg: REG_SZ type kept' ([string]$k.GetValueKind('Path')) 'String'
    Check 'reg: REG_SZ value' $k.GetValue('Path') 'C:\s;C:\t'
    $k.Close()
    Set-CbUserPath -Value '' -SubKey $key
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
    Check 'reg: empty value deleted' ($k.GetValueNames() -contains 'Path') $false
    $k.Close()
  } finally {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($key, $false)
  }

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
