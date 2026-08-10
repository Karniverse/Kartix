@echo off
echo ===================================
echo   Kartix Automated Release Script
echo ===================================
echo.

set /p SUFFIX="Enter an optional suffix for this release (e.g. Beta) or press Enter to skip: "
echo.

echo [1/4] Generating Version String...
if "%SUFFIX%"=="" (
    node update-version.js
) else (
    node update-version.js "%SUFFIX%"
)
set SKIP_VERSION_UPDATE=1
for /f "tokens=*" %%a in ('node -p "require('./src/version.json').version"') do set VERSION=%%a
set TAG_NAME=%VERSION: =-%
echo New Version: %VERSION%
echo.

echo [2/4] Building Tauri Application...
call npm run tauri build
if %errorlevel% neq 0 (
    echo Build failed! Aborting release.
    pause
    exit /b %errorlevel%
)
echo.

echo [3/4] Pushing changes to GitHub...
git add .
git commit -m "Release %VERSION%"
git push origin main
echo.

set IS_PRERELEASE=
if not "%SUFFIX%"=="" (
    set IS_PRERELEASE=--prerelease
)

echo [4/4] Creating GitHub Release using GitHub CLI (gh)...
REM Assuming you have 'gh' installed and authenticated (gh auth login)
gh release create "%TAG_NAME%" "src-tauri\target\release\bundle\msi\*.msi" -t "%VERSION%" -F CHANGELOG.md %IS_PRERELEASE%
echo.

echo Release Complete! Check your GitHub Repository.
pause
