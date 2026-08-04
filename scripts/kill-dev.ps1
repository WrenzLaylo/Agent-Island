Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match 'electron' -or
    ($_.Name -match 'node' -and $_.CommandLine -match 'agent-island|electron-vite')
  } |
  ForEach-Object {
    Write-Output ("KILL {0} {1}" -f $_.ProcessId, $_.Name)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 1
Write-Output 'Remaining electron:'
Get-Process electron -ErrorAction SilentlyContinue | Format-Table Id, ProcessName -AutoSize
