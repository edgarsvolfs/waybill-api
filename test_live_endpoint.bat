@echo off
REM Ensure the console uses UTF-8 for any Unicode filenames
chcp 65001 > nul

REM Your Railway API endpoint
set URL=https://web-production-77c35.up.railway.app/api/waybill

REM Your API key (if you have one configured in Railway)
set API_KEY=supersecret123

REM Send data.json and save the PDF as test_waybill.pdf
curl -X POST "%URL%" ^
     -H "Content-Type: application/json" ^
     -H "x-api-key: %API_KEY%" ^
     -d @data.json ^
     -o test_waybill.pdf

REM Check if the PDF was created
if exist test_waybill.pdf (
  echo.
  echo PDF successfully generated: test_waybill.pdf
) else (
  echo.
  echo ERROR: test_waybill.pdf not found!
)

pause