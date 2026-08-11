# Create a self-signed code-signing certificate for local builds.
#
# This removes the "unknown publisher" warning ONLY on machines that trust the
# certificate. It does nothing for anyone else, and it is not a substitute for
# a real certificate if you ever distribute this.
#
# Run it yourself rather than through a tool: step 2 changes your machine's
# trust store, and that is a decision you should make deliberately.
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-dev-cert.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$pfxPath = Join-Path $buildDir 'dev-cert.pfx'
$cerPath = Join-Path $buildDir 'dev-cert.cer'

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if (Test-Path $pfxPath) {
  Write-Host "A certificate already exists at $pfxPath" -ForegroundColor Yellow
  Write-Host "Delete it first if you want to create a new one."
  exit 1
}

$password = Read-Host -Prompt 'Password to protect the .pfx' -AsSecureString
if ($password.Length -eq 0) { throw 'A password is required.' }

Write-Host ''
Write-Host '1/2  Creating the certificate...' -ForegroundColor Cyan

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject 'CN=Agent Island' `
  -FriendlyName 'Agent Island (self-signed)' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -KeyLength 3072 `
  -NotAfter (Get-Date).AddYears(5)

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host "     $pfxPath" -ForegroundColor Green
Write-Host "     thumbprint $($cert.Thumbprint)"
Write-Host ''
Write-Host '2/2  Trusting it (optional, needs an elevated prompt)' -ForegroundColor Cyan
Write-Host ''
Write-Host '     Until you do this, signed builds still warn -- including on this machine.'
Write-Host '     This makes the machine trust ANY binary signed with this key, so treat'
Write-Host '     the .pfx as a credential. It is git-ignored; keep it that way.'
Write-Host ''
Write-Host '     Run in an ADMIN PowerShell:' -ForegroundColor Yellow
Write-Host "       Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\Root"
Write-Host ''
Write-Host 'Then build a signed package:' -ForegroundColor Cyan
Write-Host "   `$env:CSC_LINK = '$pfxPath'"
Write-Host "   `$env:CSC_KEY_PASSWORD = '<the password you just chose>'"
Write-Host '   npm run package'
Write-Host ''
Write-Host 'Without those two variables the build is simply unsigned, as before.'
