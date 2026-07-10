@echo off
title iHear Local Replica
cd /d "%~dp0"

echo Starting iHear local replica...
echo.
echo URL:
echo   http://localhost:4173
echo.
echo Local admin password:
echo   ihear-admin-local
echo.
echo Press Ctrl+C to stop the server.
echo.

npm start

pause
