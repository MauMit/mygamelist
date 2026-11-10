@echo off
setlocal

REM ============================================
REM My Game List - one-off GSE + Goldberg sync
REM ============================================
REM
REM Syncs every game from %APPDATA%\GSE Saves and
REM %APPDATA%\Goldberg SteamEmu Saves once, uploads the changes,
REM and exits. It runs achievement-watcher.ps1 -Once, so it uses
REM the same merge rules as the watcher. Keep both files in the
REM same folder.
REM
REM Repo folder: pass it as the first argument, or edit the default below.
REM It must be a local clone of the repo on the "user" branch.

set "REPO=%USERPROFILE%\Desktop\Egna Projekt\achievement-viewer\achievement-viewer"
if not "%~1"=="" set "REPO=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0achievement-watcher.ps1" -RepoPath "%REPO%" -Once

echo.
pause
