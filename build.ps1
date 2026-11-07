# Builds paint.exe from paint.cs with the .NET Framework compiler that ships with Windows.
#
#   pwsh -File build.ps1          Build paint.exe and swap it in.
#   pwsh -File build.ps1 -Check   Build to a temporary file and fail unless the
#                                 committed paint.exe was built from this paint.cs.
#
# paint.exe embeds the SHA-256 of the paint.cs it was built from (line endings
# normalized to LF), printed by `paint.exe --source-hash`. That compiler can't
# build byte-identical output, so the hash is how CI ties the committed binary
# to the committed source.
#
# Running title watchers keep paint.exe locked, so the build compiles to a new
# file, then swaps it in: Windows lets you rename a running exe, but not
# overwrite it. Watchers already running keep the old build until they're
# restarted (Get-Process paint | Stop-Process; the next hook starts fresh ones).
param([switch]$Check)
$ErrorActionPreference = 'Stop'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$src = Join-Path $PSScriptRoot 'paint.cs'
$exe = Join-Path $PSScriptRoot 'paint.exe'

$text = [IO.File]::ReadAllText($src).Replace("`r`n", "`n")
$sha = [Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($text)) | ForEach-Object { $_.ToString('x2') })

$work = Join-Path ([IO.Path]::GetTempPath()) "glance-build-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
try {
    $info = Join-Path $work 'BuildInfo.cs'
    Set-Content -NoNewline -Path $info -Value "static class BuildInfo { public const string SourceSha256 = `"$hash`"; }"
    $new = Join-Path $work 'paint.exe'
    & $csc /nologo /optimize+ /target:exe /platform:x64 "/out:$new" $src $info
    if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

    $built = & $new --source-hash
    if ($built -ne $hash) { throw "the new build reports source hash '$built', expected $hash" }

    if ($Check) {
        $committed = & $exe --source-hash
        if ($committed -ne $hash) {
            throw "paint.exe was built from a different paint.cs (it reports '$committed', paint.cs is $hash). Run build.ps1 and commit paint.exe."
        }
        Write-Host "paint.cs compiles, and paint.exe matches it ($hash)"
        return
    }

    $old = Join-Path $PSScriptRoot 'paint.old.exe'
    Remove-Item $old -ErrorAction SilentlyContinue   # fails harmlessly while an old watcher still runs it
    if (Test-Path $exe) { Move-Item $exe $old -Force }
    Move-Item $new $exe
    Write-Host "Built $exe ($hash)"
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
