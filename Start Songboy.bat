@echo off
setlocal

cd /d "%~dp0"
title Songboy Launcher

echo Starting Songboy...

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

"server\.venv\Scripts\python.exe" -c "import torch, piano_transcription_inference, demucs" >nul 2>&1
if errorlevel 1 (
    echo Installing audio models...
    "server\.venv\Scripts\python.exe" -m pip install -r "server\requirements-audio.txt"
    if errorlevel 1 goto :error
)

where nvidia-smi >nul 2>&1
if not errorlevel 1 (
    "server\.venv\Scripts\python.exe" -c "import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)" >nul 2>&1
    if errorlevel 1 (
        echo NVIDIA GPU found. Installing GPU acceleration. One-time large download...
        "server\.venv\Scripts\python.exe" -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 --upgrade
    )
)

if not exist "server\models\piano-note-pedal.pth" (
    echo Downloading Piano Mode model. This is a one-time 165 MB download...
    if not exist "server\models" mkdir "server\models"
    powershell -NoProfile -Command ^
      "Invoke-WebRequest -UseBasicParsing -Uri 'https://zenodo.org/records/4034264/files/CRNN_note_F1%%3D0.9677_pedal_F1%%3D0.9186.pth?download=1' -OutFile 'server\models\piano-note-pedal.pth'"
    if errorlevel 1 goto :error
)

set "BACKEND_READY=0"
set "FRONTEND_READY=0"

powershell -NoProfile -Command ^
  "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:3001/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 set "BACKEND_READY=1"

powershell -NoProfile -Command ^
  "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:3000'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 set "FRONTEND_READY=1"

if "%BACKEND_READY%"=="0" (
    powershell -NoProfile -WindowStyle Hidden -Command ^
      "Start-Process -WindowStyle Hidden -FilePath 'npm.cmd' -ArgumentList 'run','dev:backend' -WorkingDirectory '%~dp0'"
)

if "%FRONTEND_READY%"=="0" (
    powershell -NoProfile -WindowStyle Hidden -Command ^
      "Start-Process -WindowStyle Hidden -FilePath 'npm.cmd' -ArgumentList 'run','dev','--','--host','127.0.0.1','--port','3000' -WorkingDirectory '%~dp0'"
)

echo Waiting for Songboy...
powershell -NoProfile -Command ^
  "$url='http://127.0.0.1:3000'; for ($i=0; $i -lt 60; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url; if ($r.StatusCode -eq 200) { Start-Process $url; exit 0 } } catch {}; Start-Sleep -Seconds 1 }; exit 1"

if errorlevel 1 (
    echo Songboy did not start. Check that Node.js and Python are installed.
    pause
    exit /b 1
)

exit /b 0

:error
echo.
echo Setup failed. Check that Node.js and Python 3.10 or 3.11 are installed.
pause
exit /b 1

