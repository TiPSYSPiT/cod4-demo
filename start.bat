@echo off
rem CoD4 Demo Viewer - optional local web server.
rem The viewer also works without it: just double-click index.html.
rem With a server it runs at http://127.0.0.1:8080/ (needs Python 3).
cd /d "%~dp0"
set PORT=8080
where py >nul 2>nul
if %errorlevel%==0 (
  start "" "http://127.0.0.1:%PORT%/index.html"
  py -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  start "" "http://127.0.0.1:%PORT%/index.html"
  python -m http.server %PORT% --bind 127.0.0.1
  goto :eof
)
echo Python was not found. Open index.html directly in the browser instead.
start "" "%~dp0index.html"
pause
