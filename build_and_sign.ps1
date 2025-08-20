# Build KeepKey Vault with NSIS installer and sign it
param(
    [switch]$SkipBuild = $false,
    [switch]$SkipSign = $false,
    [string]$BuildMode = "release"  # release or debug
)

$ErrorActionPreference = "Stop"

Write-Host "=== KeepKey Vault Build & Sign Pipeline ===" -ForegroundColor Cyan
Write-Host "Build Mode: $BuildMode" -ForegroundColor Gray
Write-Host "Skip Build: $SkipBuild" -ForegroundColor Gray
Write-Host "Skip Sign: $SkipSign" -ForegroundColor Gray
Write-Host ""

# Verify we're in the right directory
$requiredPath = "projects\vault-v2"
if (-not (Test-Path $requiredPath)) {
    Write-Host "❌ Must run from repository root (missing $requiredPath)" -ForegroundColor Red
    exit 1
}

# Check configuration
Write-Host "[INFO] Checking Tauri configuration..." -ForegroundColor Yellow
$tauriConfig = Get-Content "projects\vault-v2\src-tauri\tauri.conf.json" | ConvertFrom-Json
$isNsisConfigured = $tauriConfig.bundle.targets -contains "nsis"

if ($isNsisConfigured) {
    Write-Host "[OK] NSIS target configured" -ForegroundColor Green
} else {
    Write-Host "[ERROR] NSIS target not found in bundle.targets" -ForegroundColor Red
    Write-Host "Current targets: $($tauriConfig.bundle.targets -join ', ')" -ForegroundColor Gray
    exit 1
}

if ($tauriConfig.bundle.windows.nsis) {
    Write-Host "[OK] NSIS settings configured" -ForegroundColor Green
    Write-Host "   Desktop shortcut: $($tauriConfig.bundle.windows.nsis.createDesktopShortcut)" -ForegroundColor Gray
    Write-Host "   Start menu: $($tauriConfig.bundle.windows.nsis.createStartMenuShortcut)" -ForegroundColor Gray
} else {
    Write-Host "[WARN] NSIS settings not configured (will use defaults)" -ForegroundColor Yellow
}

# Build if not skipped
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[BUILD] Building Vault v2..." -ForegroundColor Yellow
    
    # Navigate to project directory
    Push-Location "projects\vault-v2"
    
    try {
        # Install dependencies
        Write-Host "[BUILD] Installing dependencies..." -ForegroundColor Yellow
        bun install
        if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }
        
        # Build the application
        Write-Host "[BUILD] Building application..." -ForegroundColor Yellow
        if ($BuildMode -eq "debug") {
            bun run tauri build --debug
        } else {
            bun run tauri build
        }
        
        if ($LASTEXITCODE -ne 0) { throw "Build failed" }
        
        Write-Host "[OK] Build completed successfully" -ForegroundColor Green
        
    } catch {
        Write-Host "[ERROR] Build failed: $_" -ForegroundColor Red
        Pop-Location
        exit 1
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[SKIP] Skipping build" -ForegroundColor Blue
}

# Check for built files
Write-Host ""
Write-Host "[INFO] Checking build artifacts..." -ForegroundColor Yellow

$bundlePath = "projects\vault-v2\target\release\bundle"
if (-not (Test-Path $bundlePath)) {
    Write-Host "[ERROR] Bundle directory not found: $bundlePath" -ForegroundColor Red
    exit 1
}

# List available bundle types
$bundleTypes = Get-ChildItem $bundlePath -Directory | Select-Object -ExpandProperty Name
Write-Host "Available bundle types: $($bundleTypes -join ', ')" -ForegroundColor Gray

# Check for NSIS installer
$nsisPath = Join-Path $bundlePath "nsis"
if (Test-Path $nsisPath) {
    $nsisFiles = Get-ChildItem $nsisPath -Filter "*.exe"
    if ($nsisFiles.Count -gt 0) {
        Write-Host "[OK] NSIS installer found:" -ForegroundColor Green
        foreach ($file in $nsisFiles) {
            Write-Host "   - $($file.Name) ($([math]::Round($file.Length / 1MB, 2)) MB)" -ForegroundColor Gray
        }
    } else {
        Write-Host "[ERROR] No .exe files found in NSIS bundle" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[ERROR] NSIS bundle not found at $nsisPath" -ForegroundColor Red
    exit 1
}

# Sign the installer
if (-not $SkipSign) {
    Write-Host ""
    Write-Host "[SIGN] Signing NSIS installer..." -ForegroundColor Yellow
    
    try {
        .\sign_nsis_setup.ps1 -BuildPath $nsisPath
        if ($LASTEXITCODE -ne 0) { throw "Signing failed" }
        
        Write-Host "[OK] Signing completed successfully" -ForegroundColor Green
        
    } catch {
        Write-Host "[ERROR] Signing failed: $_" -ForegroundColor Red
        Write-Host "[HINT] Make sure your Sectigo certificate is installed" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host "[SKIP] Skipping signing" -ForegroundColor Blue
}

Write-Host ""
Write-Host "Build and sign pipeline completed!" -ForegroundColor Green
Write-Host "Artifacts location: $bundlePath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "   1. Test the installer on a clean Windows system" -ForegroundColor Gray
Write-Host "   2. Verify desktop shortcut creation" -ForegroundColor Gray
Write-Host "   3. Check Start Menu entry" -ForegroundColor Gray
Write-Host "   4. Test install/uninstall process" -ForegroundColor Gray
Write-Host "   5. Upload to GitHub release if everything works" -ForegroundColor Gray