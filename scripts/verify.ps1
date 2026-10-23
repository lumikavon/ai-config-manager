$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Run-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
Run-Checked 'npm.cmd' @('ci')
Run-Checked 'npm.cmd' @('test', '--', '--run')
Run-Checked 'npm.cmd' @('run', 'build')
Run-Checked 'cargo' @('test', '--locked')
Run-Checked 'cargo' @('fmt', '--all', '--', '--check')
Write-Output 'Core and frontend checks passed. Native OS acceptance is separate; see docs/acceptance.md.'
