@echo off
REM Use UTF-8 in this console so we can create Unicode filenames
chcp 65001 > nul

set URL=http://localhost:3000/api/waybill

curl -X POST "%URL%" ^
     -H "Content-Type: application/json" ^
     -d @data.json ^
     -OJ

if %errorlevel% neq 0 (
  echo Error encountered!
) else (
  echo Done. Created PDF(s):
  dir /b *.pdf
)

pause