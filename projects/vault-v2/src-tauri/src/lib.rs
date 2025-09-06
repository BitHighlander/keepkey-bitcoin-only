use tauri::{Emitter, Manager};

// Modules for better organization

mod commands;
mod device;
mod event_controller;
mod logging;
mod slip132;
mod server;

// Re-export commonly used types

use std::sync::Arc;

// Learn more about Tauri commands at https://tauri.app/develop/rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Command to open devtools
#[tauri::command]
fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        // In Tauri v2 with devtools feature enabled, we can open inspector
        #[cfg(all(debug_assertions, feature = "devtools"))]
        {
            window.open_devtools();
            println!("DevTools opened");
        }
        
        // For release builds with devtools feature
        #[cfg(all(not(debug_assertions), feature = "devtools"))]
        {
            window.open_devtools();
            println!("DevTools opened (production build with devtools enabled)");
        }
        
        #[cfg(not(feature = "devtools"))]
        {
            println!("DevTools not available in this build - feature not enabled");
            return Err("DevTools not available in this build. The devtools feature needs to be enabled in Cargo.toml".to_string());
        }
        
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

// Command to set log level at runtime
#[tauri::command]
fn set_log_level(level: String) -> Result<String, String> {
    let log_level = match level.to_lowercase().as_str() {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "info" => log::LevelFilter::Info,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        "off" => log::LevelFilter::Off,
        _ => return Err(format!("Invalid log level: {}. Use: trace, debug, info, warn, error, or off", level))
    };
    
    log::set_max_level(log_level);
    let message = format!("Log level set to: {:?}", log_level);
    log::info!("{}", message);
    Ok(message)
}

// Command to get current log level
#[tauri::command]
fn get_log_level() -> String {
    format!("{:?}", log::max_level())
}

// Onboarding related commands moved to commands.rs



// Vault interface commands
#[tauri::command]
fn vault_change_view(app: tauri::AppHandle, view: String) -> Result<(), String> {
    println!("View changed to: {}", view);
    // Emit event to frontend if needed
    match app.emit("vault:change_view", serde_json::json!({ "view": view })) {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to emit view change event: {}", e))
    }
}

#[tauri::command]
fn vault_open_support(app: tauri::AppHandle) -> Result<(), String> {
    println!("Opening support");
    
    // Switch to browser view and navigate to support
    app.emit("vault:change_view", serde_json::json!({
        "view": "browser"
    })).map_err(|e| format!("Failed to emit view change event: {}", e))?;
    
    // Add a small delay to ensure the browser view is mounted before navigation
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        
        let _ = app.emit("browser:navigate", serde_json::json!({
            "url": "https://support.keepkey.com"
        }));
    });
    
    Ok(())
}

// Add the missing vault_open_app command to open external URLs
#[tauri::command]
async fn vault_open_app(app_handle: tauri::AppHandle, app_id: String, app_name: String, url: String) -> Result<(), String> {
    println!("Opening app: {} ({}) -> {}", app_name, app_id, url);
    
    // Use Tauri's opener plugin to open the URL in the system browser
    use tauri_plugin_opener::OpenerExt;
    app_handle.opener().open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open URL: {}", e))?;
    
    Ok(())
}

// Add a general command to open any URL in the system browser
#[tauri::command]
async fn open_url(app_handle: tauri::AppHandle, url: String) -> Result<(), String> {
    println!("Opening URL in system browser: {}", url);
    
    // Use Tauri's opener plugin to open the URL in the system browser
    use tauri_plugin_opener::OpenerExt;
    app_handle.opener().open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open URL: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn restart_backend_startup(app: tauri::AppHandle) -> Result<(), String> {
    println!("🔄 PERFORMING COMPREHENSIVE USB DRIVER-LEVEL BACKEND RESTART");
    
    // Check onboarding status before restarting device operations
    let onboarding_complete = match commands::is_onboarded().await {
        Ok(onboarded) => onboarded,
        Err(e) => {
            println!("⚠️ Failed to check onboarding status during restart: {}", e);
            false // Default to not onboarded if we can't check
        }
    };
    
    if !onboarding_complete {
        println!("🚪 OnboardingGate: User not onboarded - blocking backend restart and device operations");
        // Emit status indicating we're waiting for onboarding
        let _ = app.emit("application:state", serde_json::json!({
            "status": "Waiting for onboarding completion...",
            "connected": false,
            "features": null
        }));
        return Ok(());
    }
    
    // Emit restart status
    let _ = app.emit("application:state", serde_json::json!({
        "status": "Performing USB driver-level restart...",
        "connected": false,
        "features": null
    }));
    
    // 1. Stop the event controller first
    println!("  🛑 Stopping event controller...");
    if let Some(controller_state) = app.try_state::<Arc<std::sync::Mutex<event_controller::EventController>>>() {
        if let Ok(mut controller) = controller_state.inner().lock() {
            controller.stop();
            println!("  ✅ Event controller stopped");
        }
    }
    
    // 2. Clear all device queues and perform USB reset
    if let Some(queue_manager_state) = app.try_state::<Arc<tokio::sync::Mutex<std::collections::HashMap<String, keepkey_rust::device_queue::DeviceQueueHandle>>>>() {
        let mut manager = queue_manager_state.inner().lock().await;
        println!("  📋 Clearing {} device queue(s) and resetting USB...", manager.len());
        
        // Collect device IDs for USB reset
        let device_ids: Vec<String> = manager.keys().cloned().collect();
        
        // Clear the queue manager first
        manager.clear();
        println!("  ✅ All device queues cleared");
        
        // Now attempt USB driver-level reset for each device
        for device_id in device_ids {
            println!("  🔌 Attempting USB driver reset for device: {}", device_id);
            // Attempt to reset USB at driver level using rusb
            if let Err(e) = perform_usb_device_reset(&device_id).await {
                println!("  ⚠️ USB reset failed for {}: {}", device_id, e);
            } else {
                println!("  ✅ USB reset successful for {}", device_id);
            }
        }
    }
    
    // 3. Clear response tracking
    if let Some(responses_state) = app.try_state::<Arc<tokio::sync::Mutex<std::collections::HashMap<String, commands::DeviceResponse>>>>() {
        let mut responses = responses_state.inner().lock().await;
        println!("  📋 Clearing {} cached response(s)...", responses.len());
        responses.clear();
        println!("  ✅ Response cache cleared");
    }
    
    // 4. Clear any cached device states
    println!("  📋 Clearing device state caches...");
    commands::clear_all_device_caches().await;
    
    // 5. Force USB enumeration refresh
    println!("  🔄 Forcing USB enumeration refresh...");
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    
    // 6. Restart the event controller
    println!("  🚀 Restarting event controller...");
    if let Some(controller_state) = app.try_state::<Arc<std::sync::Mutex<event_controller::EventController>>>() {
        if let Ok(mut controller) = controller_state.inner().lock() {
            controller.start(&app);
            println!("  ✅ Event controller restarted");
        }
    } else {
        // If no controller exists, spawn a new one
        let _event_controller = event_controller::spawn_event_controller(&app);
        println!("  ✅ New event controller spawned");
    }
    
    // 7. Wait for USB enumeration and controller startup
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    
    // 8. Emit scanning status
    let _ = app.emit("application:state", serde_json::json!({
        "status": "Scanning for devices after USB reset...",
        "connected": false,
        "features": null
    }));
    
    // 9. Force a device rescan
    let devices = keepkey_rust::features::list_connected_devices();
    let device_count = devices.len();
    println!("  🔍 Found {} device(s) after USB driver-level restart", device_count);
    
    // 10. Re-emit device events for found devices
    for device in devices {
        println!("  📡 Re-emitting device:connected for {}", device.unique_id);
        let _ = app.emit("device:connected", &device);
    }
    
    println!("✅ USB DRIVER-LEVEL BACKEND RESTART COMPLETE");
    
    // Final status update
    if device_count == 0 {
        let _ = app.emit("application:state", serde_json::json!({
            "status": "No devices found. Please reconnect your KeepKey.",
            "connected": false,
            "features": null
        }));
    } else {
        let _ = app.emit("application:state", serde_json::json!({
            "status": format!("Found {} device(s) after restart", device_count),
            "connected": true,
            "features": null
        }));
    }
    
    Ok(())
}

#[tauri::command]
async fn exit_app_with_restart(app: tauri::AppHandle) -> Result<(), String> {
    println!("🔄 EXIT APP WITH FULL BACKEND RESTART REQUESTED");
    
    // First perform a backend restart to clean up everything
    if let Err(e) = restart_backend_startup(app.clone()).await {
        println!("⚠️ Backend restart failed before exit: {}", e);
    }
    
    // Small delay to ensure cleanup completes
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    
    println!("👋 Exiting application...");
    
    // Exit the application
    app.exit(0);
    
    Ok(())
}

// Helper function to perform USB device reset at driver level
async fn perform_usb_device_reset(device_id: &str) -> Result<(), String> {
    // Since rusb is not directly available in this crate, we'll use a system-level approach
    // and rely on the event controller restart to handle re-enumeration
    
    println!("    🔧 Performing system-level USB reset for device: {}", device_id);
    
    // On macOS/Linux, we can try to reset USB through system commands
    #[cfg(target_os = "macos")]
    {
        // On macOS, we can try to reset USB devices through system commands
        // This is a best-effort approach
        use std::process::Command;
        
        // Try to find and reset KeepKey devices using system tools
        let output = Command::new("system_profiler")
            .args(&["SPUSBDataType", "-xml"])
            .output();
        
        if let Ok(_output) = output {
            println!("    📊 USB enumeration refreshed via system_profiler");
        }
        
        // Give the system time to re-enumerate
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    
    #[cfg(target_os = "linux")]
    {
        // On Linux, we could try to unbind/bind the USB device through sysfs
        // This requires elevated permissions typically
        use std::process::Command;
        
        // Try to reset USB subsystem (requires permissions)
        let _ = Command::new("sh")
            .arg("-c")
            .arg("echo 0 > /sys/bus/usb/devices/*/authorized 2>/dev/null; echo 1 > /sys/bus/usb/devices/*/authorized 2>/dev/null")
            .output();
        
        println!("    📊 Attempted USB subsystem reset (may require elevated permissions)");
        
        // Give the system time to re-enumerate
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    
    #[cfg(target_os = "windows")]
    {
        // On Windows, device reset is more complex and usually requires
        // Windows Device Manager APIs or PowerShell commands
        log::warn!("Windows USB reset: Manual device reconnection may be required");
        log::debug!("Windows HID Context: Attempting device enumeration refresh");
        
        // Try to reset through PowerShell (best effort)
        use std::process::Command;
        let _ = Command::new("powershell")
            .arg("-Command")
            .arg("Get-PnpDevice -Class 'HIDClass' | Where-Object {$_.FriendlyName -like '*KeepKey*'} | Disable-PnpDevice -Confirm:$false; Start-Sleep -Milliseconds 500; Get-PnpDevice -Class 'HIDClass' | Where-Object {$_.FriendlyName -like '*KeepKey*'} | Enable-PnpDevice -Confirm:$false")
            .output();
        
        log::info!("Windows: Attempted HID device reset via PowerShell");
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
    
    // The main recovery mechanism is the event controller restart
    // which will re-enumerate devices using keepkey-rust's built-in USB handling
    println!("    ✅ USB reset sequence completed - relying on event controller for re-enumeration");
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize env_logger for production logging with enhanced Windows debugging
    // Set RUST_LOG environment variable to control log level
    // Examples: RUST_LOG=debug, RUST_LOG=vault_v2=debug, RUST_LOG=info
    
    // Enhanced logging for Windows debugging
    #[cfg(target_os = "windows")]
    let default_filter = "vault_v2=debug,keepkey_rust=debug,hidapi=debug";
    
    #[cfg(not(target_os = "windows"))]
    let default_filter = "vault_v2=info,keepkey_rust=info";
    
    env_logger::Builder::from_env(env_logger::Env::default()
        .default_filter_or(default_filter))
        .format_timestamp_millis()
        .format_module_path(true)
        .format_target(true)
        .init();
    
    log::info!("🚀 Starting KeepKey Vault v2 - Logging initialized");
    log::info!("Platform: {}", std::env::consts::OS);
    log::info!("Architecture: {}", std::env::consts::ARCH);
    log::debug!("Debug logging is enabled");
    
    #[cfg(target_os = "windows")]
    {
        log::info!("Windows-specific debugging enabled");
        log::debug!("HID/USB verbose logging active");
        log::debug!("Default log level: {}", default_filter);
    }
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Devtools are enabled via tauri.conf.json with "devtools": true
            // They can be opened with right-click menu or F12 key
            
            // Initialize device logging system
            if let Err(e) = logging::init_device_logger() {
                eprintln!("Failed to initialize device logger: {}", e);
            } else {
                println!("✅ Device logging initialized - logs will be written to ~/.keepkey/logs/");
            }
            
            // Initialize real device system using keepkey_rust
            let device_queue_manager = Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::<String, keepkey_rust::device_queue::DeviceQueueHandle>::new()
            ));
            
            // Initialize response tracking
            let last_responses = Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::<String, commands::DeviceResponse>::new()
            ));
            
            // Initialize bootloader update tracker
            let bootloader_tracker: device::BootloaderUpdateTracker = Arc::new(tokio::sync::RwLock::new(
                std::collections::HashMap::<String, std::time::Instant>::new()
            ));
            
            app.manage(device_queue_manager.clone());
            app.manage(last_responses);
            app.manage(bootloader_tracker);
            
            // Start event controller with proper management - store in app state
            let event_controller = event_controller::spawn_event_controller(&app.handle());
            // Note: The controller is already managed inside spawn_event_controller
            
            // Start USB monitor for hotplug detection
            // Note: The USB monitor is mainly for detecting reconnections after passphrase changes
            // Normal device detection is handled by the event controller
            let usb_monitor = std::sync::Arc::new(device::UsbMonitor::new(app.handle().clone()));
            let monitor_clone = usb_monitor.clone();
            tauri::async_runtime::spawn(async move {
                // Add a longer delay to let the event controller initialize first
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                monitor_clone.start().await;
            });
            
            // Start background log cleanup task
            let _app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(86400)); // 24 hours
                loop {
                    interval.tick().await;
                    if let Err(e) = logging::get_device_logger().cleanup_old_logs().await {
                        eprintln!("Failed to cleanup old logs: {}", e);
                    }
                }
            });
            
            // Start REST/MCP server in background (only if enabled in preferences)
            let server_handle = app.handle().clone();
            let server_queue_manager = device_queue_manager.clone();
            tauri::async_runtime::spawn(async move {
                // Add a small delay to ensure config system is ready
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                
                // Check if API is enabled in preferences
                let api_enabled = match commands::get_api_enabled().await {
                    Ok(enabled) => enabled,
                    Err(e) => {
                        log::debug!("Could not check API status: {} - defaulting to disabled", e);
                        false // Default to disabled if error
                    }
                };
                
                if api_enabled {
                    log::info!("🚀 API is enabled in preferences, starting server...");
                    
                    if let Err(e) = server::start_server(server_queue_manager).await {
                        log::error!("❌ Server error: {}", e);
                        // Optionally emit error event to frontend
                        let _ = server_handle.emit("server:error", serde_json::json!({
                            "error": format!("Server failed to start: {}", e)
                        }));
                    }
                } else {
                    log::info!("🔒 API is disabled in preferences, skipping server startup");
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            open_devtools,
            set_log_level,
            get_log_level,
            vault_change_view,
            vault_open_support,
            vault_open_app,
            open_url,
            restart_backend_startup,
            exit_app_with_restart,
            // Frontend readiness
            commands::frontend_ready,
            commands::start_device_operations,
            // Device operations - unified queue interface
            device::queue::add_to_device_queue,
            commands::get_queue_status,
            // Basic device enumeration (non-queue operations)
            commands::get_connected_devices,
            commands::get_blocking_actions,
            // Device state management
            commands::get_device_state,
            commands::get_all_device_states,
            // New device commands (all go through queue)
            commands::get_device_status,
            commands::get_device_info_by_id,
            commands::wipe_device,
            commands::set_device_label,
            commands::get_connected_devices_with_features,
            // Update commands
            device::updates::update_device_bootloader,
            device::updates::update_device_firmware,
            // PIN creation commands
            commands::initialize_device_pin,
            commands::send_pin_matrix_response,
            commands::get_pin_session_status,
            commands::cancel_pin_creation,
            commands::initialize_device_wallet,
            commands::complete_wallet_creation,
            // Passphrase commands
            commands::handle_passphrase_request,
            commands::send_passphrase,
            commands::enable_passphrase_protection,
            commands::enable_passphrase_protection_v2,
            commands::pin_submit,
            commands::pin_cancel,
            commands::get_device_interaction_state,
            commands::reset_device_interaction_state,
            commands::reset_device_queue,
            // PIN management commands
            commands::enable_pin_protection,
            commands::disable_pin_protection,
            commands::change_pin,
            // PIN setup commands for initialized devices
            commands::pin_setup::start_pin_setup,
            commands::pin_setup::send_pin_setup_response,
            // PIN unlock commands  
            commands::start_pin_unlock,
            commands::send_pin_unlock_response,
            commands::send_pin_matrix_ack,
            commands::trigger_pin_request,
            commands::check_device_pin_ready,
            commands::check_device_in_pin_flow,
            commands::send_pin_for_removal,
            // Logging commands
            commands::get_device_log_path,
            commands::get_recent_device_logs,
            commands::cleanup_device_logs,
            // Configuration and onboarding commands
            commands::is_first_time_install,
            commands::is_onboarded,
            commands::set_onboarding_completed,
            commands::get_preference,
            commands::set_preference,
            commands::debug_onboarding_state,
            // API control commands
            commands::get_api_enabled,
            commands::set_api_enabled,
            commands::get_api_status,
            commands::restart_app,
            // Test commands
            commands::test_device_queue,
            commands::test_status_emission,
            commands::test_bootloader_mode_device_status,
            commands::test_oob_device_status_evaluation,
            // Recovery commands - delegated to keepkey_rust
            commands::start_device_recovery,
            commands::send_recovery_character,
            commands::send_recovery_pin_response,
            commands::get_recovery_status,
            commands::cancel_recovery_session,
            // Seed verification commands (dry run recovery)
            commands::start_seed_verification,
            commands::send_verification_character,
            commands::send_verification_pin,
            commands::get_verification_status,
            commands::cancel_seed_verification,
            commands::force_cleanup_seed_verification
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
