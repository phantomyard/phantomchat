param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$ExpectedArchitecture,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Installer = (Resolve-Path $Installer).Path
$runtimeArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if($runtimeArchitecture -ne $ExpectedArchitecture) {
  throw "Native runner is $runtimeArchitecture, expected $ExpectedArchitecture"
}

$signature = Get-AuthenticodeSignature -FilePath $Installer
if($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
  throw "Interim installer must be unsigned; Authenticode status is $($signature.Status)"
}

$install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if($install.ExitCode -ne 0) {
  throw "Installer exited with code $($install.ExitCode)"
}

$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
  Get-ItemProperty |
  # electron-builder's default uninstallDisplayName is
  # "${productName} ${version}", not the bare productName.
  Where-Object { $_.DisplayName -like 'PhantomChat *' } |
  Select-Object -First 1
if(!$uninstallKey) {
  throw 'PhantomChat uninstall registration was not created'
}
if($uninstallKey.DisplayVersion -ne $ExpectedVersion) {
  throw "Installed version is $($uninstallKey.DisplayVersion), expected $ExpectedVersion"
}

$uninstallCommand = $uninstallKey.UninstallString
if($uninstallCommand -notmatch '^"(?<path>[^"]+)"') {
  throw "Unexpected uninstall command: $uninstallCommand"
}
$uninstaller = $Matches.path
$installDirectory = Split-Path $uninstaller -Parent
$executable = Join-Path $installDirectory 'PhantomChat.exe'
if(!(Test-Path $executable -PathType Leaf)) {
  throw "Installed executable not found: $executable"
}
if(!(Test-Path (Join-Path $installDirectory 'resources\app.asar') -PathType Leaf)) {
  throw 'Installed app.asar is missing'
}

$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\PhantomChat.lnk'
if(!(Test-Path $shortcut -PathType Leaf)) {
  throw "Start Menu shortcut not found: $shortcut"
}
$shortcutTarget = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut).TargetPath
if([System.IO.Path]::GetFullPath($shortcutTarget) -ne [System.IO.Path]::GetFullPath($executable)) {
  throw "Start Menu shortcut targets '$shortcutTarget', expected '$executable'"
}

$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$previousProbePath = $env:PHANTOMCHAT_RUNTIME_PROBE
$probePath = [System.IO.Path]::GetTempFileName()
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:PHANTOMCHAT_RUNTIME_PROBE = $probePath
  # A Windows GUI-subsystem executable is not awaited by PowerShell's `&`
  # operator, which can close its stdout pipe before Electron writes to it.
  # Start-Process -Wait proves the actual installed runtime exits cleanly.
  $runtime = Start-Process -FilePath $executable -ArgumentList @(
    '-e',
    'require(Buffer.from([102,115]).toString()).writeFileSync(process.env.PHANTOMCHAT_RUNTIME_PROBE,process.arch)'
  ) -Wait -PassThru
  if($runtime.ExitCode -ne 0) {
    throw "Packaged Electron runtime exited with code $($runtime.ExitCode)"
  }
  $actualArchitecture = Get-Content $probePath -Raw
  if($actualArchitecture -ne $ExpectedArchitecture) {
    throw "Packaged runtime reports $actualArchitecture, expected $ExpectedArchitecture"
  }
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
  $env:PHANTOMCHAT_RUNTIME_PROBE = $previousProbePath
  Remove-Item $probePath -Force -ErrorAction SilentlyContinue
}

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if($uninstall.ExitCode -ne 0) {
  throw "Uninstaller exited with code $($uninstall.ExitCode)"
}
for($attempt = 0; $attempt -lt 30 -and ((Test-Path $executable) -or (Test-Path $shortcut)); $attempt++) {
  Start-Sleep -Seconds 1
}
if(Test-Path $executable) {
  throw "Uninstall left the application behind: $executable"
}
if(Test-Path $shortcut) {
  throw "Uninstall left the Start Menu shortcut behind: $shortcut"
}

Write-Host "Verified PhantomChat $ExpectedVersion Windows installer ($ExpectedArchitecture): install, native launch, Start Menu integration and uninstall."
