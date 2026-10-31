param([Parameter(Mandatory=$true)][string]$Prepared, [string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$keyEntry = $null
$keyPointer = [IntPtr]::Zero
try {
    Set-Location -LiteralPath $project
    Write-Host 'Locked Meta evaluation: 3 planned attempts, no automatic retry.'
    Write-Host '20 responses / 40 local tool calls / 16384 completion tokens per response.'
    Write-Host 'The source stays unchanged. All attempts and failures will be saved.'
    $keyEntry = Read-Host 'Paste your Meta API key (hidden), then press Enter' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($keyEntry)
    $env:MODEL_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    & $Python -m recovery_room story-run --prepared $Prepared
    $batchExit = $LASTEXITCODE
    Write-Host "Batch exited with code $batchExit. Return to Codex for verification."
} catch {
    Write-Host 'The local batch could not start or finish. Return to Codex; no retry was started.' -ForegroundColor Red
} finally {
    Remove-Item Env:\MODEL_API_KEY -ErrorAction SilentlyContinue
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    if ($null -ne $keyEntry) { $keyEntry.Dispose() }
}
Read-Host 'Press Enter to close this window'
