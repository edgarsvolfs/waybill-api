@echo off
chcp 65001 > nul

set URL=https://web-production-77c35.up.railway.app/api/waybill
set API_KEY=supersecret123
set ZIP_NAME=waybill_bundle.zip

REM Download as ZIP (your server sets Content-Type: application/zip)
curl -sSf -X POST "%URL%" ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: %API_KEY%" ^
  -d @data.json ^
  -o "%ZIP_NAME%"

IF ERRORLEVEL 1 (
  echo ❌ Request failed. See response above.
  pause
  exit /b 1
)

REM Unzip using PowerShell (built-in on Windows 10+)
powershell -NoLogo -NoProfile -Command ^
  "Expand-Archive -Force '%ZIP_NAME%' '.'"

echo.
IF EXIST *.pdf echo ✅ PDF saved.
IF EXIST *.xlsx echo ✅ XLSX saved.

REM Optional: show what we got
dir /b *.pdf *.xlsx

pause