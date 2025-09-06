use tauri::State;
use std::fs;
use std::path::PathBuf;
use semver::Version;
use uuid;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashMap;
use crate::logging::{log_device_request, log_device_response};
use crate::commands::DeviceQueueManager;

// Track devices that just completed bootloader updates
pub type BootloaderUpdateTracker = Arc<RwLock<HashMap<String, std::time::Instant>>>;

/// Update device bootloader using the device queue
#[tauri::command]
pub async fn update_device_bootloader(
    device_id: String,
    target_version: String,
    queue_manager: State<'_, DeviceQueueManager>,
    bootloader_tracker: State<'_, BootloaderUpdateTracker>,
) -> Result<bool, String> {
    println!("🔄 Starting bootloader update for device {}: target version {}", device_id, target_version);
    
    let request_id = uuid::Uuid::new_v4().to_string();
    
    // Log the request
    let request_data = serde_json::json!({
        "device_id": device_id,
        "target_version": target_version,
        "operation": "update_device_bootloader"
    });
    
    if let Err(e) = log_device_request(&device_id, &request_id, "UpdateBootloader", &request_data).await {
        eprintln!("Failed to log bootloader update request: {}", e);
    }
    
    // Validate target version
    let _target_semver = Version::parse(&target_version)
        .map_err(|e| format!("Invalid target bootloader version: {}", e))?;
    
    // Load the bootloader binary from the firmware directory (bundled with app)
    let bootloader_filename = format!("bl_v{}", target_version);
    
    // Debug: Log current working directory and environment
    let cwd = std::env::current_dir().unwrap_or_default();
    println!("🔍 Current working directory: {:?}", cwd);
    
    // Get executable location for bundled app paths
    let exe_path = std::env::current_exe().ok();
    let exe_dir = exe_path.as_ref().and_then(|p| p.parent());
    
    if let Some(exe_dir) = &exe_dir {
        println!("🔍 Executable directory: {:?}", exe_dir);
    }
    
    // Try multiple possible paths for the firmware directory
    let mut possible_firmware_paths = vec![
        // Development paths
        PathBuf::from("firmware").join(&bootloader_filename).join("blupdater.bin"), // Bundled with app (dev)
        PathBuf::from("./firmware").join(&bootloader_filename).join("blupdater.bin"), // Explicit current dir
        cwd.join("firmware").join(&bootloader_filename).join("blupdater.bin"), // Absolute from cwd
    ];
    
    // Add executable-relative paths for bundled apps
    if let Some(exe_dir) = exe_dir {
        // Common Tauri bundled app locations
        possible_firmware_paths.push(exe_dir.join("firmware").join(&bootloader_filename).join("blupdater.bin"));
        possible_firmware_paths.push(exe_dir.join("../Resources/firmware").join(&bootloader_filename).join("blupdater.bin")); // macOS
        possible_firmware_paths.push(exe_dir.join("../firmware").join(&bootloader_filename).join("blupdater.bin"));
        
        // Windows specific paths
        #[cfg(target_os = "windows")]
        {
            possible_firmware_paths.push(exe_dir.join("resources/firmware").join(&bootloader_filename).join("blupdater.bin"));
        }
        
        // Linux specific paths  
        #[cfg(target_os = "linux")]
        {
            possible_firmware_paths.push(exe_dir.join("resources/firmware").join(&bootloader_filename).join("blupdater.bin"));
            possible_firmware_paths.push(exe_dir.join("../share/vault-v2/firmware").join(&bootloader_filename).join("blupdater.bin"));
        }
    }
    
    // Debug: Log all paths being tried
    println!("🔍 Trying to find bootloader file. Checking paths:");
    for (i, path) in possible_firmware_paths.iter().enumerate() {
        println!("  Path {}: {:?} - exists: {}", i + 1, path, path.exists());
    }
    
    let firmware_path = possible_firmware_paths.iter().find(|path| path.exists()).cloned();
    
    let bootloader_bytes = if let Some(path) = firmware_path {
        println!("📂 Loading bootloader from: {}", path.display());
        fs::read(&path)
            .map_err(|e| format!("Failed to read bootloader file {}: {}", path.display(), e))?
    } else {
        // Check available bootloader versions from all possible firmware directories
        let mut possible_firmware_dirs = vec![
            PathBuf::from("firmware"),
            PathBuf::from("./firmware"),
            cwd.join("firmware"),
        ];
        
        // Add executable-relative directories for bundled apps
        if let Some(exe_dir) = exe_dir {
            possible_firmware_dirs.push(exe_dir.join("firmware"));
            possible_firmware_dirs.push(exe_dir.join("../Resources/firmware")); // macOS
            possible_firmware_dirs.push(exe_dir.join("../firmware"));
            
            #[cfg(target_os = "windows")]
            {
                possible_firmware_dirs.push(exe_dir.join("resources/firmware"));
            }
            
            #[cfg(target_os = "linux")]
            {
                possible_firmware_dirs.push(exe_dir.join("resources/firmware"));
                possible_firmware_dirs.push(exe_dir.join("../share/vault-v2/firmware"));
            }
        }
        
        let mut available_versions = String::from("No firmware directory found");
        for firmware_dir in &possible_firmware_dirs {
            println!("🔍 Checking firmware directory: {:?} - exists: {}", firmware_dir, firmware_dir.exists());
            if firmware_dir.exists() {
                match fs::read_dir(firmware_dir) {
                    Ok(entries) => {
                        let versions: Vec<String> = entries
                            .filter_map(|e| e.ok())
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .filter(|name| name.starts_with("bl_v"))
                            .collect();
                        available_versions = format!("Available bootloader versions in {}: {}", 
                            firmware_dir.display(), versions.join(", "));
                        break;
                    }
                    Err(_) => continue,
                }
            }
        }
        
        let error_msg = format!(
            "Bootloader file not found: bl_v{}/blupdater.bin in any firmware directory. {}. Target version was: {}",
            target_version,
            available_versions,
            target_version
        );
        
        // Log the error response
        let response_data = serde_json::json!({
            "error": error_msg,
            "operation": "update_device_bootloader"
        });
        
        if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceBootloader", false, &response_data, Some(&error_msg)).await {
            eprintln!("Failed to log bootloader update error response: {}", e);
        }
        
        return Err(error_msg);
    };
    
    println!("📦 Loaded bootloader binary: {} bytes", bootloader_bytes.len());
    
    // Get or create device queue handle
    let queue_handle = {
        let mut manager = queue_manager.lock().await;
        
        if let Some(handle) = manager.get(&device_id) {
            handle.clone()
        } else {
            // Find the device by ID
            let devices = keepkey_rust::features::list_connected_devices();
            let device_info = devices
                .iter()
                .find(|d| d.unique_id == device_id);
                
            match device_info {
                Some(device_info) => {
                    // Spawn a new device worker
                    let handle = keepkey_rust::device_queue::DeviceQueueFactory::spawn_worker(device_id.clone(), device_info.clone());
                    manager.insert(device_id.clone(), handle.clone());
                    handle
                }
                None => {
                    let error = format!("Device {} not found", device_id);
                    
                    // Log the error response
                    let response_data = serde_json::json!({
                        "error": error,
                        "operation": "update_device_bootloader"
                    });
                    
                    if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceBootloader", false, &response_data, Some(&error)).await {
                        eprintln!("Failed to log bootloader update error response: {}", e);
                    }
                    
                    return Err(error);
                }
            }
        }
    };
    
    // Check device features to ensure it's in bootloader mode
    match queue_handle.get_features().await {
        Ok(features) => {
            if !features.bootloader_mode.unwrap_or(false) {
                let error = "Device is not in bootloader mode. Please hold the button while reconnecting to enter bootloader mode.".to_string();
                
                // Log the error response
                let response_data = serde_json::json!({
                    "error": error,
                    "operation": "update_device_bootloader"
                });
                
                if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceBootloader", false, &response_data, Some(&error)).await {
                    eprintln!("Failed to log bootloader update error response: {}", e);
                }
                
                return Err(error);
            }
            println!("✅ Device confirmed in bootloader mode, firmware version: {}", format!(
                "{}.{}.{}",
                features.major_version.unwrap_or(0),
                features.minor_version.unwrap_or(0),
                features.patch_version.unwrap_or(0)
            ));
        }
        Err(e) => {
            let error_str = e.to_string();
            
            // Check if this looks like an OOB bootloader that doesn't understand GetFeatures
            if error_str.contains("Unknown message") || 
               error_str.contains("Failure: Unknown message") ||
               error_str.contains("Unexpected response") {
                
                println!("🔧 Device may be in OOB bootloader mode (can't get features), proceeding with update...");
                println!("    This is normal for devices with very old bootloaders that don't support GetFeatures");
                println!("    The update process will verify bootloader mode during the actual update");
            } else {
                let error = format!("Failed to get device features: {}", error_str);
                
                // Log the error response
                let response_data = serde_json::json!({
                    "error": error,
                    "operation": "update_device_bootloader"
                });
                
                if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceBootloader", false, &response_data, Some(&error)).await {
                    eprintln!("Failed to log bootloader update error response: {}", e);
                }
                
                return Err(error);
            }
        }
    }
    
    println!("⚠️  IMPORTANT: Check your KeepKey device screen!");
    println!("    You may need to press the button to confirm the update.");
    println!("    The v1.0.3 bootloader requires manual confirmation.");
    println!("    If you see 'Upload' on the device screen, press and hold the button.");
    
    // Perform the bootloader update through the queue
    match queue_handle.update_bootloader(target_version.clone(), bootloader_bytes).await {
        Ok(success) => {
            println!("✅ Bootloader update successful for device {}", device_id);
            println!("⚠️  Note: The device will now reboot. It will disconnect and reconnect automatically.");
            println!("    The frontend should wait for the device:connected event before proceeding.");
            
            // Log the successful response
            let response_data = serde_json::json!({
                "success": success,
                "target_version": target_version,
                "operation": "update_device_bootloader"
            });
            
            if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceBootloader", true, &response_data, None).await {
                eprintln!("Failed to log bootloader update success response: {}", e);
            }
            
            // Track that this device just completed a bootloader update
            {
                let mut tracker = bootloader_tracker.write().await;
                tracker.insert(device_id.clone(), std::time::Instant::now());
                println!("📝 Marked device {} as having just completed bootloader update", device_id);
            }
            
            // Clean up the device queue handle as the device will disconnect
            {
                let mut manager = queue_manager.lock().await;
                if manager.remove(&device_id).is_some() {
                    println!("♻️ Cleaned up device queue for {} after bootloader update", device_id);
                }
            }
            
            Ok(success)
        }
        Err(e) => {
            let error_msg = e.to_string();
            println!("❌ Bootloader update failed for device {}: {}", device_id, error_msg);
            
            // Log the error response
            let response_data = serde_json::json!({
                "error": error_msg,
                "operation": "update_device_bootloader"
            });
            
            if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceBootloader", false, &response_data, Some(&error_msg)).await {
                eprintln!("Failed to log bootloader update error response: {}", e);
            }
            
            Err(format!("Bootloader update failed: {}", error_msg))
        }
    }
}

/// Update device firmware using the device queue
#[tauri::command]
pub async fn update_device_firmware(
    device_id: String,
    target_version: String,
    queue_manager: State<'_, DeviceQueueManager>,
) -> Result<bool, String> {
    println!("🔄 Starting firmware update for device {}: target version {}", device_id, target_version);
    
    let request_id = uuid::Uuid::new_v4().to_string();
    
    // Log the request
    let request_data = serde_json::json!({
        "device_id": device_id,
        "target_version": target_version,
        "operation": "update_device_firmware"
    });
    
    if let Err(e) = log_device_request(&device_id, &request_id, "UpdateFirmware", &request_data).await {
        eprintln!("Failed to log firmware update request: {}", e);
    }
    
    // Validate target version
    let _target_semver = Version::parse(&target_version)
        .map_err(|e| format!("Invalid target firmware version: {}", e))?;
    
    // Load the firmware binary from the firmware directory (bundled with app)
    let firmware_filename = format!("v{}", target_version);
    
    // Debug: Log current working directory and environment
    let cwd = std::env::current_dir().unwrap_or_default();
    println!("🔍 Current working directory: {:?}", cwd);
    
    // Get executable location for bundled app paths
    let exe_path = std::env::current_exe().ok();
    let exe_dir = exe_path.as_ref().and_then(|p| p.parent());
    
    if let Some(exe_dir) = &exe_dir {
        println!("🔍 Executable directory: {:?}", exe_dir);
    }
    
    // Try multiple possible paths for the firmware directory
    let mut possible_firmware_paths = vec![
        // Development paths
        PathBuf::from("firmware").join(&firmware_filename).join("firmware.keepkey.bin"), // Bundled with app (dev)
        PathBuf::from("./firmware").join(&firmware_filename).join("firmware.keepkey.bin"), // Explicit current dir
        cwd.join("firmware").join(&firmware_filename).join("firmware.keepkey.bin"), // Absolute from cwd
    ];
    
    // Add executable-relative paths for bundled apps
    if let Some(exe_dir) = exe_dir {
        // Common Tauri bundled app locations
        possible_firmware_paths.push(exe_dir.join("firmware").join(&firmware_filename).join("firmware.keepkey.bin"));
        possible_firmware_paths.push(exe_dir.join("../Resources/firmware").join(&firmware_filename).join("firmware.keepkey.bin")); // macOS
        possible_firmware_paths.push(exe_dir.join("../firmware").join(&firmware_filename).join("firmware.keepkey.bin"));
        
        // Windows specific paths
        #[cfg(target_os = "windows")]
        {
            possible_firmware_paths.push(exe_dir.join("resources/firmware").join(&firmware_filename).join("firmware.keepkey.bin"));
        }
        
        // Linux specific paths  
        #[cfg(target_os = "linux")]
        {
            possible_firmware_paths.push(exe_dir.join("resources/firmware").join(&firmware_filename).join("firmware.keepkey.bin"));
            possible_firmware_paths.push(exe_dir.join("../share/vault-v2/firmware").join(&firmware_filename).join("firmware.keepkey.bin"));
        }
    }
    
    // Debug: Log all paths being tried
    println!("🔍 Trying to find firmware file. Checking paths:");
    for (i, path) in possible_firmware_paths.iter().enumerate() {
        println!("  Path {}: {:?} - exists: {}", i + 1, path, path.exists());
    }
    
    let firmware_path = possible_firmware_paths.iter().find(|path| path.exists()).cloned();
    
    let firmware_bytes = if let Some(path) = firmware_path {
        println!("📂 Loading firmware from: {}", path.display());
        fs::read(&path)
            .map_err(|e| format!("Failed to read firmware file {}: {}", path.display(), e))?
    } else {
        // Check available firmware versions from all possible firmware directories
        let mut possible_firmware_dirs = vec![
            PathBuf::from("firmware"),
            PathBuf::from("./firmware"),
            cwd.join("firmware"),
        ];
        
        // Add executable-relative directories for bundled apps
        if let Some(exe_dir) = exe_dir {
            possible_firmware_dirs.push(exe_dir.join("firmware"));
            possible_firmware_dirs.push(exe_dir.join("../Resources/firmware")); // macOS
            possible_firmware_dirs.push(exe_dir.join("../firmware"));
            
            #[cfg(target_os = "windows")]
            {
                possible_firmware_dirs.push(exe_dir.join("resources/firmware"));
            }
            
            #[cfg(target_os = "linux")]
            {
                possible_firmware_dirs.push(exe_dir.join("resources/firmware"));
                possible_firmware_dirs.push(exe_dir.join("../share/vault-v2/firmware"));
            }
        }
        
        let mut available_versions = String::from("No firmware directory found");
        for firmware_dir in &possible_firmware_dirs {
            println!("🔍 Checking firmware directory: {:?} - exists: {}", firmware_dir, firmware_dir.exists());
            if firmware_dir.exists() {
                match fs::read_dir(firmware_dir) {
                    Ok(entries) => {
                        let versions: Vec<String> = entries
                            .filter_map(|e| e.ok())
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .filter(|name| name.starts_with("v"))
                            .collect();
                        available_versions = format!("Available firmware versions in {}: {}", 
                            firmware_dir.display(), versions.join(", "));
                        break;
                    }
                    Err(_) => continue,
                }
            }
        }
        
        let error_msg = format!(
            "Firmware file not found: v{}/firmware.keepkey.bin in any firmware directory. {}. Target version was: {}",
            target_version,
            available_versions,
            target_version
        );
        
        // Log the error response
        let response_data = serde_json::json!({
            "error": error_msg,
            "operation": "update_device_firmware"
        });
        
        if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", false, &response_data, Some(&error_msg)).await {
            eprintln!("Failed to log firmware update error response: {}", e);
        }
        
        return Err(error_msg);
    };
    
    println!("📦 Loaded firmware binary: {} bytes", firmware_bytes.len());
    
    // Get or create device queue handle with retry logic for reconnecting devices
    let queue_handle = {
        let mut manager = queue_manager.lock().await;
        
        if let Some(handle) = manager.get(&device_id) {
            handle.clone()
        } else {
            // Device might be reconnecting after bootloader update, try with retries
            let mut device_info = None;
            let max_retries = 5;
            
            for retry in 0..max_retries {
                if retry > 0 {
                    // Wait before retry to allow device to reconnect
                    println!("⏳ Waiting for device {} to reconnect (attempt {}/{})", device_id, retry + 1, max_retries);
                    drop(manager); // Release lock during sleep
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000 * retry as u64)).await;
                    manager = queue_manager.lock().await;
                    
                    // Check again if handle was created by event controller
                    if let Some(_handle) = manager.get(&device_id) {
                        println!("✅ Device queue handle found after waiting");
                        break;
                    }
                }
                
                let devices = keepkey_rust::features::list_connected_devices();
                device_info = devices
                    .iter()
                    .find(|d| d.unique_id == device_id)
                    .cloned();
                    
                if device_info.is_some() {
                    println!("✅ Device {} found on attempt {}", device_id, retry + 1);
                    break;
                }
            }
            
            match device_info {
                Some(device_info) => {
                    // Spawn a new device worker
                    let handle = keepkey_rust::device_queue::DeviceQueueFactory::spawn_worker(device_id.clone(), device_info.clone());
                    manager.insert(device_id.clone(), handle.clone());
                    handle
                }
                None => {
                    // Check if handle was created while we were waiting
                    if let Some(handle) = manager.get(&device_id) {
                        handle.clone()
                    } else {
                        let error = format!("Device {} not found after {} retries", device_id, max_retries);
                        
                        // Log the error response
                        let response_data = serde_json::json!({
                            "error": error,
                            "operation": "update_device_firmware"
                        });
                        
                        if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", false, &response_data, Some(&error)).await {
                            eprintln!("Failed to log firmware update error response: {}", e);
                        }
                        
                        return Err(error);
                    }
                }
            }
        }
    };
    
    // Check device features to ensure it's in bootloader mode (required for firmware updates)
    // Add a firm timeout so the frontend doesn't spin forever if device isn't ready
    match tokio::time::timeout(std::time::Duration::from_secs(8), queue_handle.get_features()).await {
        Ok(Ok(features)) => {
            if !features.bootloader_mode.unwrap_or(false) {
                let error = "Device must be in bootloader mode for firmware update. Please hold the button while reconnecting to enter bootloader mode.".to_string();
                
                // Log the error response
                let response_data = serde_json::json!({
                    "error": error,
                    "operation": "update_device_firmware"
                });
                
                if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", false, &response_data, Some(&error)).await {
                    eprintln!("Failed to log firmware update error response: {}", e);
                }
                
                return Err(error);
            }
            println!("✅ Device confirmed in bootloader mode, ready for firmware update. Current version: {}", format!(
                "{}.{}.{}",
                features.major_version.unwrap_or(0),
                features.minor_version.unwrap_or(0),
                features.patch_version.unwrap_or(0)
            ));
        }
        Ok(Err(e)) => {
            let error_str = e.to_string();
            
            // Check if this looks like an OOB bootloader that doesn't understand GetFeatures
            if error_str.contains("Unknown message") || 
               error_str.contains("Failure: Unknown message") ||
               error_str.contains("Unexpected response") {
                
                println!("🔧 Device may be in OOB bootloader mode (can't get features), proceeding with firmware update...");
                println!("    This is normal for devices with very old bootloaders that don't support GetFeatures");
                println!("    The update process will verify bootloader mode during the actual update");
            } else {
                let error = format!("Failed to get device features: {}", error_str);
                
                // Log the error response
                let response_data = serde_json::json!({
                    "error": error,
                    "operation": "update_device_firmware"
                });
                
                if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", false, &response_data, Some(&error)).await {
                    eprintln!("Failed to log firmware update error response: {}", e);
                }
                
                return Err(error);
            }
        }
        Err(_elapsed) => {
            let error = "Timed out checking device features before firmware update. Ensure the device is in bootloader mode (hold button while plugging in).".to_string();
            let response_data = serde_json::json!({
                "error": error,
                "operation": "update_device_firmware"
            });
            if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", false, &response_data, Some(&error)).await {
                eprintln!("Failed to log firmware update timeout response: {}", e);
            }
            return Err(error);
        }
    }
    
    println!("⚠️  IMPORTANT: Check your KeepKey device screen!");
    println!("    You may need to press the button to confirm the firmware update.");
    println!("    If you see 'Upload' on the device screen, press and hold the button.");
    
    // Perform the firmware update through the queue  
    match queue_handle.update_firmware(target_version.clone(), firmware_bytes).await {
        Ok(success) => {
            println!("✅ Firmware update successful for device {}", device_id);
            println!("⚠️  Note: The device will now reboot. It will disconnect and reconnect automatically.");
            println!("    The frontend should wait for the device:connected event before proceeding.");
            
            // Log the successful response
            let response_data = serde_json::json!({
                "success": success,
                "target_version": target_version,
                "operation": "update_device_firmware"
            });
            
            if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", true, &response_data, None).await {
                eprintln!("Failed to log firmware update success response: {}", e);
            }
            
            // Clean up the device queue handle as the device will disconnect
            {
                let mut manager = queue_manager.lock().await;
                if manager.remove(&device_id).is_some() {
                    println!("♻️ Cleaned up device queue for {} after firmware update", device_id);
                }
            }
            
            Ok(success)
        }
        Err(e) => {
            let error_msg = e.to_string();
            println!("❌ Firmware update failed for device {}: {}", device_id, error_msg);
            
            // Log the error response
            let response_data = serde_json::json!({
                "error": error_msg,
                "operation": "update_device_firmware"
            });
            
            if let Err(e) = log_device_response(&device_id, &request_id, "UpdateDeviceFirmware", false, &response_data, Some(&error_msg)).await {
                eprintln!("Failed to log firmware update error response: {}", e);
            }
            
            Err(format!("Firmware update failed: {}", error_msg))
        }
    }
} 