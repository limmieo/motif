@echo off
setlocal

cd /d "%~dp0"
title Wario Synth Launcher

echo Starting Wario Synth...

if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install
    if errorlevel 1 goto :error
)

if not exist "server\node_modules" (
    echo Installing backend dependencies...
    pushd server
    call npm install
    if errorlevel 1 (
        popd
        goto :error
    )
    popd
)

if not exist "server\.venv\Scripts\python.exe" (
    echo Installing audio transcription...
    python -m venv "server\.venv"
    if errorlevel 1 goto :error
    "server\.venv\Scripts\python.exe" -m pip install -r "server\requirements-audio.txt"
    if errorlevel 1 goto :error
)

"server\.venv\Scripts\python.exe" -c "import torch, piano_transcription_inference" >nul 2>&1
if errorlevel 1 (
    echo Installing Piano Mode...
    "server\.venv\Scripts\python.exe" -m pip install -r "server\requirements-audio.txt"
    if errorlevel 1 goto :error
)

if not exist "server\models\piano-note-pedal.pth" (
    echo Downloading Piano Mode model. This is a one-time 165 MB download...
    if not exist "server\models" mkdir "server\models"
    powershell -NoProfile -Command ^
      "Invoke-WebRequest -UseBasicParsing -Uri 'https://zenodo.org/records/4034264/files/CRNN_note_F1%%3D0.9677_pedal_F1%%3D0.9186.pth?download=1' -OutFile 'server\models\piano-note-pedal.pth'"
    if errorlevel 1 goto :error
)

powershell -NoProfile -WindowStyle Hidden -Command ^
  "Start-Process -WindowStyle Hidden -FilePath 'npm.cmd' -ArgumentList 'run','dev:backend' -WorkingDirectory '%~dp0'"

powershell -NoProfile -WindowStyle Hidden -Command ^
  "Start-Process -WindowStyle Hidden -FilePath 'npm.cmd' -ArgumentList 'run','dev','--','--host','127.0.0.1' -WorkingDirectory '%~dp0'"

echo Waiting for Wario Synth...
powershell -NoProfile -Command ^
  "$url='http://127.0.0.1:3000'; for ($i=0; $i -lt 60; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url; if ($r.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1"

if errorlevel 1 (
    echo Wario Synth did not start. Check that Node.js and Python are installed.
    pause
    exit /b 1
)

exit /b 0

:error
echo.
echo Setup failed. Check that Node.js and Python 3.10 or 3.11 are installed.
pause
exit /b 1
