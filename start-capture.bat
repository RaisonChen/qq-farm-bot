@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "CAP_TITLE=QQ_FARM_CAPTURE"
set "CAP_PORT=8450"
set "PNPM_CMD="

where pnpm >nul 2>nul
if errorlevel 1 (
    where corepack >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Neither pnpm nor corepack was found.
        pause
        exit /b 1
    )
    set "PNPM_CMD=corepack pnpm"
) else (
    set "PNPM_CMD=pnpm"
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%CAP_PORT%" ^| findstr "LISTENING"') do (
    echo [INFO] Capture service is already running. PID=%%P, PORT=%CAP_PORT%
    pause
    exit /b 0
)

where mitmdump >nul 2>nul
if errorlevel 1 (
    echo [WARN] mitmdump ^(mitmproxy^) not found. Capture needs it.
    echo        Install: pip install mitmproxy   ^(requires Python 3.9+^)
    echo.
)

if not exist "%~dp0capture\node_modules" (
    echo [INFO] Installing workspace dependencies...
    call %PNPM_CMD% install -r
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
)

echo [INFO] Opening QQ Farm capture service...
start "%CAP_TITLE%" cmd /k "cd /d "%~dp0" && call %PNPM_CMD% -C capture start"

echo [OK] Capture service launch command sent.
echo [INFO] apiBase: http://127.0.0.1:%CAP_PORT%  ^(check window for apiToken^)
exit /b 0
