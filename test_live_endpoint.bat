@echo off
REM switch console to UTF-8 so Unicode filenames work
chcp 65001 > nul

REM your live Heroku URL
set URL=https://waybill-create-178a4ca51463.herokuapp.com/api/waybill

REM your API key (if you set one in Heroku config)
set API_KEY=supersecret123

REM explicitly write the response to test_waybill.pdf
curl -X POST "%URL%" ^
     -H "Content-Type: application/json" ^
     -H "x-api-key: %API_KEY%" ^
     -d @data.json ^
     -o test_waybill.pdf

REM check for the file you just created
if exist test_waybill.pdf (
  echo.
  echo PDF generated: test_waybill.pdf
) else (
  echo.
  echo ERROR: PDF not created!
)

pause
