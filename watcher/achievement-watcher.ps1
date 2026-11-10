# ============================================================
# My Game List - Automatic GSE + Goldberg Achievement Watcher
# ============================================================
#
# Watches:
#   %APPDATA%\GSE Saves
#   %APPDATA%\Goldberg SteamEmu Saves
#
# On start it catches up: every game in both folders is synced once,
# so achievements earned while the watcher wasn't running are uploaded.
# After that it keeps watching. When a game writes achievements.json:
#   1. Waits for the emulator to finish writing
#   2. Merges that game's files from BOTH folders (an achievement counts
#      as earned if either folder has it, with the earliest unlock time),
#      so an empty placeholder in one folder can't hide progress in the other
#   3. Writes AppID\<AppID>\achievements.json in the repo if it changed
#   4. Commits, pulls the latest "user" branch, and pushes
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File achievement-watcher.ps1
#   powershell -ExecutionPolicy Bypass -File achievement-watcher.ps1 -Once
#   powershell -ExecutionPolicy Bypass -File achievement-watcher.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File achievement-watcher.ps1 -RepoPath "D:\path\to\mygamelist"
#
#   -Once     Sync everything once, push, and exit (what sync-gse.bat runs)
#   -DryRun   Show what would change, without writing or pushing anything
#
# -RepoPath must be a local clone of the repo checked out on the "user" branch.
# ============================================================

param(
    [string]$RepoPath = (Join-Path $env:USERPROFILE "Desktop\Egna Projekt\achievement-viewer\achievement-viewer"),
    [switch]$Once,
    [switch]$DryRun
)


# ------------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------------

# Achievement save folders, in priority order (first wins on ties)
$Sources = @(
    [pscustomobject]@{ Name = "GSE";      Path = (Join-Path $env:APPDATA "GSE Saves") },
    [pscustomobject]@{ Name = "Goldberg"; Path = (Join-Path $env:APPDATA "Goldberg SteamEmu Saves") }
)

$AppIDPath = Join-Path $RepoPath "AppID"

# Wait this long after the last change before syncing, so the emulator has
# finished writing and several quick unlocks end up in one commit.
$QuietSeconds = 8

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false


# ------------------------------------------------------------
# LOGGING
# ------------------------------------------------------------

function Write-Log {
    param([string]$Message)
    $Time = Get-Date -Format "HH:mm:ss"
    Write-Host "[$Time] $Message"
}


# ------------------------------------------------------------
# READ ONE achievements.json
# ------------------------------------------------------------

function Read-AchievementFile {
    param([string]$File)

    if (-not (Test-Path -LiteralPath $File)) { return $null }

    # The emulator may still be writing; try a few times
    for ($Try = 1; $Try -le 3; $Try++) {
        try {
            $Raw = [System.IO.File]::ReadAllText($File)
            if (-not [string]::IsNullOrWhiteSpace($Raw)) {
                return ($Raw | ConvertFrom-Json -ErrorAction Stop)
            }
        }
        catch { }
        Start-Sleep -Seconds 2
    }

    Write-Log "WARNING: $File is not valid JSON. Skipping it."
    return $null
}


function Test-Earned {
    param($Entry)
    if ($null -eq $Entry) { return $false }
    foreach ($Name in 'earned', 'unlocked', 'achieved') {
        $Value = $Entry.$Name
        if ($Value -eq $true -or $Value -eq 1 -or $Value -eq '1') { return $true }
    }
    return $false
}


function Get-EarnedTime {
    param($Entry)
    foreach ($Name in 'earned_time', 'unlock_time', 'unlocktime') {
        if ($Entry.$Name) { return [int64]$Entry.$Name }
    }
    return [int64]0
}


# ------------------------------------------------------------
# MERGE ONE GAME FROM ALL SOURCES
# ------------------------------------------------------------
# Returns the merged JSON text, or $null if no source has the game.

function Get-MergedAchievementJson {
    param([string]$AppID)

    $Merged = [ordered]@{}
    $Found = $false

    foreach ($Source in $Sources) {
        $File = Join-Path (Join-Path $Source.Path $AppID) "achievements.json"
        $Data = Read-AchievementFile -File $File
        if ($null -eq $Data) { continue }
        $Found = $true

        foreach ($Property in $Data.PSObject.Properties) {
            $Key = $Property.Name
            $Entry = $Property.Value

            if (-not $Merged.Contains($Key)) {
                $Merged[$Key] = $Entry
                continue
            }

            $Current = $Merged[$Key]
            $CurrentEarned = Test-Earned $Current
            $NewEarned = Test-Earned $Entry

            if ($NewEarned -and -not $CurrentEarned) {
                $Merged[$Key] = $Entry
            }
            elseif ($NewEarned -and $CurrentEarned) {
                # Both earned: keep the earliest real unlock time
                $CurrentTime = Get-EarnedTime $Current
                $NewTime = Get-EarnedTime $Entry
                if ($NewTime -gt 0 -and ($CurrentTime -eq 0 -or $NewTime -lt $CurrentTime)) {
                    $Merged[$Key] = $Entry
                }
            }
        }
    }

    if (-not $Found) { return $null }
    return (ConvertTo-SortedJson -Map $Merged)
}


# Same data always gives the same text: keys sorted, same formatting
function ConvertTo-SortedJson {
    param($Map)
    $Sorted = [ordered]@{}
    foreach ($Key in ($Map.Keys | Sort-Object)) { $Sorted[$Key] = $Map[$Key] }
    return (ConvertTo-Json -InputObject $Sorted -Depth 10)
}


function ConvertTo-NormalizedJson {
    param([string]$File)
    try {
        $Data = [System.IO.File]::ReadAllText($File) | ConvertFrom-Json -ErrorAction Stop
        $Map = [ordered]@{}
        foreach ($Property in $Data.PSObject.Properties) { $Map[$Property.Name] = $Property.Value }
        return (ConvertTo-SortedJson -Map $Map)
    }
    catch { return $null }
}


# ------------------------------------------------------------
# SYNC ONE GAME INTO THE REPO
# ------------------------------------------------------------
# Returns "added", "updated" or $null (no change).

function Sync-Game {
    param([string]$AppID)

    if ($AppID -notmatch '^\d+$') { return $null }

    $Json = Get-MergedAchievementJson -AppID $AppID
    if ($null -eq $Json) { return $null }

    $DestinationFolder = Join-Path $AppIDPath $AppID
    $DestinationFile = Join-Path $DestinationFolder "achievements.json"

    $Change = "added"
    if (Test-Path -LiteralPath $DestinationFile) {
        if ((ConvertTo-NormalizedJson -File $DestinationFile) -eq $Json) { return $null }
        $Change = "updated"
    }

    if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $DestinationFolder)) {
            New-Item -ItemType Directory -Path $DestinationFolder -Force | Out-Null
        }
        [System.IO.File]::WriteAllText($DestinationFile, $Json, $Utf8NoBom)
    }

    return $Change
}


function Get-AllAppIDs {
    $IDs = New-Object System.Collections.Generic.SortedSet[string]
    foreach ($Source in $Sources) {
        if (-not (Test-Path -LiteralPath $Source.Path)) { continue }
        Get-ChildItem -LiteralPath $Source.Path -Directory |
            Where-Object { $_.Name -match '^\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName "achievements.json")) } |
            ForEach-Object { [void]$IDs.Add($_.Name) }
    }
    return $IDs
}


function Sync-Games {
    param([string[]]$AppIDs)

    $Changed = 0
    foreach ($AppID in $AppIDs) {
        $Result = Sync-Game -AppID $AppID
        if ($Result) {
            $Changed++
            $Verb = if ($DryRun) { "would be $Result" } else { $Result }
            Write-Log "  AppID $AppID $Verb"
        }
    }
    return $Changed
}


# ------------------------------------------------------------
# GIT
# ------------------------------------------------------------

function Invoke-Git {
    param([string[]]$Arguments, [string]$ErrorMessage)
    & git @Arguments
    if ($LASTEXITCODE -ne 0) { throw $ErrorMessage }
}


function Update-FromGitHub {
    # Make sure we're on "user" and have the latest data commits from GitHub
    $Branch = (git branch --show-current).Trim()
    if ($Branch -ne "user") {
        Write-Log "Switching to the user branch..."
        Invoke-Git @("checkout", "user") "Could not switch to the user branch."
    }

    Write-Log "Getting the latest user branch from GitHub..."
    & git pull --rebase --autostash origin user
    if ($LASTEXITCODE -ne 0) {
        & git rebase --abort *> $null
        throw "git pull failed. Check the repo folder for conflicts."
    }
}


function Publish-Changes {
    if ($DryRun) { return }

    & git add -A AppID
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }

    & git diff --cached --quiet
    $HasStagedChanges = ($LASTEXITCODE -ne 0)

    # Commits left over from an earlier failed push still need uploading
    $Unpushed = [int](git rev-list --count "origin/user..user" 2>$null)

    if (-not $HasStagedChanges -and $Unpushed -eq 0) {
        Write-Log "Nothing new to upload."
        return
    }

    if ($HasStagedChanges) {
        $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Invoke-Git @("commit", "-q", "-m", "Sync achievements - $Timestamp") "Git commit failed."
    }

    # GitHub Actions may have added an "Update game data" commit meanwhile.
    # It only touches game-info.json / game-data.json; this script only
    # touches achievements.json, so a rebase is safe.
    & git pull --rebase --autostash origin user
    if ($LASTEXITCODE -ne 0) {
        & git rebase --abort *> $null
        throw "git pull failed. Your commit is kept locally and will be pushed next time."
    }

    Write-Log "Pushing to GitHub..."
    Invoke-Git @("push", "-q", "origin", "user") "Git push failed. Your commit is kept locally and will be pushed next time."

    Write-Log "SUCCESS: achievements uploaded. The website updates in about a minute."
}


function Invoke-Sync {
    param([string[]]$AppIDs, [string]$Label)

    try {
        Set-Location -LiteralPath $RepoPath
        if (-not $DryRun) { Update-FromGitHub }

        Write-Log "$Label"
        $Changed = Sync-Games -AppIDs $AppIDs

        if ($Changed -eq 0) { Write-Log "All games are already up to date." }
        elseif ($DryRun) { Write-Log "$Changed game(s) would be uploaded. (Dry run: nothing was written.)" }

        Publish-Changes
    }
    catch {
        Write-Host ""
        Write-Log "ERROR: $($_.Exception.Message)"
        Write-Host ""
    }
}


# ============================================================
# START
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host " My Game List - GSE + Goldberg Achievement Sync"
Write-Host "============================================================"
Write-Host ""

if (-not (Test-Path -LiteralPath (Join-Path $RepoPath ".git"))) {
    Write-Host "ERROR: the repo folder isn't a Git clone:"
    Write-Host "  $RepoPath"
    if (-not $Once) { Read-Host "Press Enter to exit" }
    exit 1
}

if (-not (Test-Path -LiteralPath $AppIDPath)) {
    New-Item -ItemType Directory -Path $AppIDPath -Force | Out-Null
}

Write-Log "Repository: $RepoPath"
foreach ($Source in $Sources) {
    $State = if (Test-Path -LiteralPath $Source.Path) { "" } else { "  (not found)" }
    Write-Log "$($Source.Name): $($Source.Path)$State"
}
Write-Host ""

# Catch up on everything that changed while the watcher wasn't running
$All = Get-AllAppIDs
Invoke-Sync -AppIDs $All -Label "Checking all $($All.Count) games..."

if ($Once -or $DryRun) { exit 0 }


# ------------------------------------------------------------
# WATCH
# ------------------------------------------------------------
# Events are queued and handled in this loop (not in -Action callbacks),
# so they run in the script's own scope and errors are visible.

$Watchers = @()
foreach ($Source in $Sources) {
    if (-not (Test-Path -LiteralPath $Source.Path)) { continue }

    $Watcher = New-Object System.IO.FileSystemWatcher
    $Watcher.Path = $Source.Path
    $Watcher.Filter = "achievements.json"
    $Watcher.IncludeSubdirectories = $true
    $Watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::Size

    foreach ($EventName in 'Changed', 'Created', 'Renamed') {
        Register-ObjectEvent -InputObject $Watcher -EventName $EventName -SourceIdentifier "AchWatch.$($Source.Name).$EventName" -MessageData $Source.Name | Out-Null
    }

    $Watcher.EnableRaisingEvents = $true
    $Watchers += $Watcher
}

if ($Watchers.Count -eq 0) {
    Write-Log "ERROR: neither achievement save folder exists."
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "============================================================"
Write-Host " Watching for new achievements. Press CTRL+C to stop."
Write-Host "============================================================"
Write-Host ""

$Pending = @{}
$LastEvent = Get-Date

try {
    while ($true) {
        $Evt = Wait-Event -Timeout 2

        while ($Evt) {
            if ($Evt.SourceIdentifier -like "AchWatch.*") {
                $Path = $Evt.SourceEventArgs.FullPath
                $AppID = Split-Path -Leaf (Split-Path -Parent $Path)
                if ($AppID -match '^\d+$' -and -not $Pending.ContainsKey($AppID)) {
                    Write-Log "$($Evt.MessageData): AppID $AppID changed"
                    $Pending[$AppID] = $true
                }
                $LastEvent = Get-Date
            }
            Remove-Event -EventIdentifier $Evt.EventIdentifier
            $Evt = Get-Event | Select-Object -First 1
        }

        if ($Pending.Count -gt 0 -and ((Get-Date) - $LastEvent).TotalSeconds -ge $QuietSeconds) {
            $IDs = @($Pending.Keys)
            $Pending.Clear()
            Invoke-Sync -AppIDs $IDs -Label "Syncing $($IDs.Count) game(s)..."
            Write-Host ""
        }
    }
}
finally {
    Write-Host ""
    Write-Log "Stopping achievement watcher..."
    Get-EventSubscriber | Where-Object { $_.SourceIdentifier -like "AchWatch.*" } | Unregister-Event -Force
    foreach ($Watcher in $Watchers) {
        $Watcher.EnableRaisingEvents = $false
        $Watcher.Dispose()
    }
}
