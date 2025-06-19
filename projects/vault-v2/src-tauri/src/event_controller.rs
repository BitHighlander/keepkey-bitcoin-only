use keepkey_rust::friendly_usb::FriendlyUsbDevice;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::interval;
use tokio_util::sync::CancellationToken;

pub struct EventController {
    cancellation_token: CancellationToken,
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    is_running: bool,
}

impl EventController {
    pub fn new() -> Self {
        Self {
            cancellation_token: CancellationToken::new(),
            task_handle: None,
            is_running: false,
        }
    }
    
    pub fn start(&mut self, app: &AppHandle) {
        if self.is_running {
            println!("⚠️ Event controller already running");
            return;
        }
        
        let app_handle = app.clone();
        let cancellation_token = self.cancellation_token.clone();
        
        let task_handle = tauri::async_runtime::spawn(async move {
            let mut interval = interval(Duration::from_millis(1000)); // Check every second
            let mut last_devices: Vec<FriendlyUsbDevice> = Vec::new();
            
            println!("✅ Event controller started - monitoring device connections");
            
            // Wait a moment for frontend to set up listeners, then emit initial scanning status
            tokio::time::sleep(Duration::from_millis(500)).await;
            println!("📡 Emitting status: Scanning for devices...");
            let scanning_payload = serde_json::json!({
                "status": "Scanning for devices..."
            });
            println!("📡 Scanning payload: {}", scanning_payload);
            if let Err(e) = app_handle.emit("status:update", scanning_payload) {
                println!("❌ Failed to emit scanning status: {}", e);
            } else {
                println!("✅ Successfully emitted scanning status");
            }
            
            // Test emission after longer delay to check if frontend is listening
            let app_for_test = app_handle.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(3000)).await;
                println!("📡 Test: Emitting delayed test status...");
                let test_payload = serde_json::json!({
                    "status": "Test message after 3 seconds"
                });
                println!("📡 Test payload: {}", test_payload);
                if let Err(e) = app_for_test.emit("status:update", test_payload) {
                    println!("❌ Failed to emit delayed test status: {}", e);
                } else {
                    println!("✅ Successfully emitted delayed test status");
                }
            });
            
            loop {
                tokio::select! {
                    _ = cancellation_token.cancelled() => {
                        println!("🛑 Event controller shutting down on cancellation signal");
                        break;
                    }
                    _ = interval.tick() => {
                        // Get current devices using high-level API
                        let current_devices = keepkey_rust::features::list_connected_devices();
                        
                        // Check for newly connected devices
                        for device in &current_devices {
                            if !last_devices.iter().any(|d| d.unique_id == device.unique_id) {
                                println!("🔌 Device connected: {} (VID: 0x{:04x}, PID: 0x{:04x})", 
                                         device.unique_id, device.vid, device.pid);
                                println!("   Device info: {} - {}", 
                                         device.manufacturer.as_deref().unwrap_or("Unknown"), 
                                         device.product.as_deref().unwrap_or("Unknown"));
                                
                                // Emit device found status
                                let device_short = &device.unique_id[device.unique_id.len().saturating_sub(8)..];
                                println!("📡 Emitting status: Device found {}", device_short);
                                let device_found_payload = serde_json::json!({
                                    "status": format!("Device found {}", device_short)
                                });
                                println!("📡 Device found payload: {}", device_found_payload);
                                if let Err(e) = app_handle.emit("status:update", device_found_payload) {
                                    println!("❌ Failed to emit device found status: {}", e);
                                } else {
                                    println!("✅ Successfully emitted device found status");
                                }
                                
                                // Emit basic device connected event first
                                let _ = app_handle.emit("device:connected", device);
                                
                                // Proactively fetch features and emit device:ready when successful
                                let app_for_task = app_handle.clone();
                                let device_for_task = device.clone();
                                tokio::spawn(async move {
                                    println!("📡 Fetching device features for: {}", device_for_task.unique_id);
                                    
                                    // Emit getting features status
                                    println!("📡 Emitting status: Getting features...");
                                    if let Err(e) = app_for_task.emit("status:update", serde_json::json!({
                                        "status": "Getting features..."
                                    })) {
                                        println!("❌ Failed to emit getting features status: {}", e);
                                    }
                                    
                                    match try_get_device_features(&device_for_task, &app_for_task).await {
                                        Ok(features) => {
                                            let device_label = features.label.as_deref().unwrap_or("Unlabeled");
                                            let device_version = &features.version;
                                            
                                            println!("✅ Device ready: {} v{} ({})", 
                                                   device_label,
                                                   device_version,
                                                   device_for_task.unique_id);
                                            
                                            // Emit device info status
                                            println!("📡 Emitting status: {} v{}", device_label, device_version);
                                            if let Err(e) = app_for_task.emit("status:update", serde_json::json!({
                                                "status": format!("{} v{}", device_label, device_version)
                                            })) {
                                                println!("❌ Failed to emit device info status: {}", e);
                                            }
                                            
                                            // Evaluate device status to determine if updates are needed
                                            let status = crate::commands::evaluate_device_status(
                                                device_for_task.unique_id.clone(), 
                                                Some(&features)
                                            );
                                            
                                            // Emit status updates based on what the device needs
                                            let is_actually_ready = !status.needs_bootloader_update && 
                                                                   !status.needs_firmware_update && 
                                                                   !status.needs_initialization;
                                            
                                            if is_actually_ready {
                                                println!("✅ Device is fully ready, emitting device:ready event");
                                                println!("📡 Emitting status: Device ready");
                                                if let Err(e) = app_for_task.emit("status:update", serde_json::json!({
                                                    "status": "Device ready"
                                                })) {
                                                    println!("❌ Failed to emit device ready status: {}", e);
                                                }
                                                let ready_payload = serde_json::json!({
                                                    "device": device_for_task,
                                                    "features": features,
                                                    "status": "ready"
                                                });
                                                let _ = app_for_task.emit("device:ready", &ready_payload);
                                            } else {
                                                println!("⚠️ Device connected but needs updates (bootloader: {}, firmware: {}, init: {})", 
                                                        status.needs_bootloader_update, 
                                                        status.needs_firmware_update, 
                                                        status.needs_initialization);
                                                
                                                // Emit appropriate status message based on what updates are needed
                                                let status_message = if status.needs_bootloader_update && status.needs_firmware_update && status.needs_initialization {
                                                    "Device needs updates"
                                                } else if status.needs_bootloader_update {
                                                    "Bootloader update needed"
                                                } else if status.needs_firmware_update {
                                                    "Firmware update needed"
                                                } else if status.needs_initialization {
                                                    "Device setup needed"
                                                } else {
                                                    "Device ready"
                                                };
                                                
                                                println!("📡 Emitting status: {}", status_message);
                                                if let Err(e) = app_for_task.emit("status:update", serde_json::json!({
                                                    "status": status_message
                                                })) {
                                                    println!("❌ Failed to emit update status: {}", e);
                                                }
                                            }
                                            
                                            // Emit device:features-updated event with evaluated status (for DeviceUpdateManager)
                                            let features_payload = serde_json::json!({
                                                "deviceId": device_for_task.unique_id,
                                                "features": features,
                                                "status": status  // Use evaluated status instead of hardcoded "ready"
                                            });
                                            let _ = app_for_task.emit("device:features-updated", &features_payload);
                                        }
                                        Err(e) => {
                                            println!("❌ Failed to get features for {}: {}", device_for_task.unique_id, e);
                                            
                                            // Check if this is a device access error
                                            if e.contains("Device Already In Use") || 
                                               e.contains("already claimed") ||
                                               e.contains("🔒") {
                                                
                                                let user_friendly_error = if e.contains("🔒") {
                                                    e.clone()
                                                } else {
                                                    format!(
                                                        "🔒 KeepKey Device Already In Use\n\n\
                                                        Your KeepKey device is currently being used by another application.\n\n\
                                                        Common causes:\n\
                                                        • KeepKey Desktop app is running\n\
                                                        • KeepKey Bridge is running\n\
                                                        • Another wallet application is connected\n\
                                                        • Previous connection wasn't properly closed\n\n\
                                                        Solutions:\n\
                                                        1. Close KeepKey Desktop app completely\n\
                                                        2. Close any other wallet applications\n\
                                                        3. Unplug and reconnect your KeepKey device\n\
                                                        4. Try again\n\n\
                                                        Technical details: {}", e
                                                    )
                                                };
                                                
                                                // Emit device access error event
                                                let error_payload = serde_json::json!({
                                                    "deviceId": device_for_task.unique_id,
                                                    "error": user_friendly_error,
                                                    "errorType": "DEVICE_CLAIMED",
                                                    "status": "error"
                                                });
                                                let _ = app_for_task.emit("device:access-error", &error_payload);
                                            }
                                        }
                                    }
                                });
                            }
                        }
                        
                        // Check for disconnected devices
                        for device in &last_devices {
                            if !current_devices.iter().any(|d| d.unique_id == device.unique_id) {
                                println!("🔌❌ Device disconnected: {}", device.unique_id);
                                
                                // Emit device disconnected status
                                println!("📡 Emitting status: Device disconnected");
                                if let Err(e) = app_handle.emit("status:update", serde_json::json!({
                                    "status": "Device disconnected"
                                })) {
                                    println!("❌ Failed to emit disconnect status: {}", e);
                                }
                                
                                // Clean up device queue for disconnected device
                                if let Some(state) = app_handle.try_state::<crate::commands::DeviceQueueManager>() {
                                    let device_id = device.unique_id.clone();
                                    // Clone the underlying Arc so it outlives this scope
                                    let queue_manager_arc = state.inner().clone();
                                    tokio::spawn(async move {
                                        println!("♻️ Cleaning up device queue for disconnected device: {}", device_id);
                                        let mut manager = queue_manager_arc.lock().await;
                                        if let Some(handle) = manager.remove(&device_id) {
                                            let _ = handle.shutdown().await;
                                            println!("✅ Device queue cleaned up for: {}", device_id);
                                        }
                                    });
                                }
                                
                                let _ = app_handle.emit("device:disconnected", &device.unique_id);
                            }
                        }
                        
                        // If no devices connected after checking disconnections, emit scanning status
                        if current_devices.is_empty() && !last_devices.is_empty() {
                            // After a short delay, go back to scanning
                            let app_for_scanning = app_handle.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(1000)).await;
                                println!("📡 Emitting status: Scanning for devices... (after disconnect)");
                                if let Err(e) = app_for_scanning.emit("status:update", serde_json::json!({
                                    "status": "Scanning for devices..."
                                })) {
                                    println!("❌ Failed to emit scanning status after disconnect: {}", e);
                                }
                            });
                        }
                        
                        last_devices = current_devices;
                    }
                }
            }
            
            println!("✅ Event controller stopped cleanly");
        });
        
        self.task_handle = Some(task_handle);
        self.is_running = true;
    }
    
    pub fn stop(&mut self) {
        if !self.is_running {
            return;
        }
        
        println!("🛑 Stopping event controller...");
        
        // Cancel the background task
        self.cancellation_token.cancel();
        self.is_running = false;
        
        // Wait for the task to complete if it exists
        if let Some(handle) = self.task_handle.take() {
            // Try to wait for completion with a timeout
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tokio::time::timeout(Duration::from_secs(5), handle).await {
                    println!("⚠️ Event controller task did not stop within timeout: {}", e);
                } else {
                    println!("✅ Event controller task stopped successfully");
                }
            });
        }
    }
}

impl Drop for EventController {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Try to get device features without blocking the event loop
/// Returns features if successful, error message if failed
/// This function handles OOB bootloader detection by trying Initialize message when GetFeatures fails
async fn try_get_device_features(device: &FriendlyUsbDevice, app_handle: &AppHandle) -> Result<keepkey_rust::features::DeviceFeatures, String> {
    // Use the shared device queue manager to prevent race conditions
    if let Some(queue_manager_state) = app_handle.try_state::<crate::commands::DeviceQueueManager>() {
        let queue_manager = queue_manager_state.inner().clone();
        
        // Get or create a single device queue handle for this device
        let queue_handle = {
            let mut manager = queue_manager.lock().await;
            
            if let Some(handle) = manager.get(&device.unique_id) {
                // Use existing handle to prevent multiple workers
                handle.clone()
            } else {
                // Create a new worker only if one doesn't exist
                let handle = keepkey_rust::device_queue::DeviceQueueFactory::spawn_worker(
                    device.unique_id.clone(),
                    device.clone()
                );
                manager.insert(device.unique_id.clone(), handle.clone());
                handle
            }
        };
        
        // Try to get features with a timeout using the shared worker
        match tokio::time::timeout(Duration::from_secs(5), queue_handle.get_features()).await {
            Ok(Ok(raw_features)) => {
                // Convert features to our DeviceFeatures format
                let device_features = crate::commands::convert_features_to_device_features(raw_features);
                Ok(device_features)
            }
            Ok(Err(e)) => {
                let error_str = e.to_string();
                
                // Check if this looks like an OOB bootloader that doesn't understand GetFeatures
                if error_str.contains("Unknown message") || 
                   error_str.contains("Failure: Unknown message") ||
                   error_str.contains("Unexpected response") {
                    
                    println!("🔧 Device may be in OOB bootloader mode, trying Initialize message...");
                    
                    // Try the direct approach using keepkey-rust's proven method
                    match try_oob_bootloader_detection(device).await {
                        Ok(features) => {
                            println!("✅ Successfully detected OOB bootloader mode for device {}", device.unique_id);
                            Ok(features)
                        }
                        Err(oob_err) => {
                            println!("❌ OOB bootloader detection also failed for {}: {}", device.unique_id, oob_err);
                            Err(format!("Failed to get device features: {} (OOB attempt: {})", error_str, oob_err))
                        }
                    }
                } else {
                    Err(format!("Failed to get device features: {}", error_str))
                }
            }
            Err(_) => {
                Err("Timeout while fetching device features".to_string())
            }
        }
    } else {
        // Fallback to the old method if queue manager is not available
        println!("⚠️ DeviceQueueManager not available, using fallback method");
        
        // Create a temporary device queue to fetch features
        // This is a non-blocking operation that will fail fast if device is busy
        let queue_handle = keepkey_rust::device_queue::DeviceQueueFactory::spawn_worker(
            device.unique_id.clone(),
            device.clone()
        );
        
        // Try to get features with a timeout
        match tokio::time::timeout(Duration::from_secs(5), queue_handle.get_features()).await {
            Ok(Ok(raw_features)) => {
                // Convert features to our DeviceFeatures format
                let device_features = crate::commands::convert_features_to_device_features(raw_features);
                Ok(device_features)
            }
            Ok(Err(e)) => {
                let error_str = e.to_string();
                
                // Check if this looks like an OOB bootloader that doesn't understand GetFeatures
                if error_str.contains("Unknown message") || 
                   error_str.contains("Failure: Unknown message") ||
                   error_str.contains("Unexpected response") {
                    
                    println!("🔧 Device may be in OOB bootloader mode, trying Initialize message...");
                    
                    // Try the direct approach using keepkey-rust's proven method
                    match try_oob_bootloader_detection(device).await {
                        Ok(features) => {
                            println!("✅ Successfully detected OOB bootloader mode for device {}", device.unique_id);
                            Ok(features)
                        }
                        Err(oob_err) => {
                            println!("❌ OOB bootloader detection also failed for {}: {}", device.unique_id, oob_err);
                            Err(format!("Failed to get device features: {} (OOB attempt: {})", error_str, oob_err))
                        }
                    }
                } else {
                    Err(format!("Failed to get device features: {}", error_str))
                }
            }
            Err(_) => {
                Err("Timeout while fetching device features".to_string())
            }
        }
    }
}

/// Try to detect OOB bootloader mode using the proven keepkey-rust methods
/// This handles the case where older bootloaders don't understand GetFeatures messages
/// Uses the documented OOB detection heuristics from docs/usb/oob_mode_detection.md
async fn try_oob_bootloader_detection(device: &FriendlyUsbDevice) -> Result<keepkey_rust::features::DeviceFeatures, String> {
    println!("🔧 Attempting OOB bootloader detection via HID for device {}", device.unique_id);
    
    // Use keepkey-rust's proven fallback method that handles OOB bootloaders correctly
    let result = tokio::task::spawn_blocking({
        let device = device.clone();
        move || -> Result<keepkey_rust::features::DeviceFeatures, String> {
            // Use the robust USB/HID fallback helper which includes retries and OOB heuristics
            keepkey_rust::features::get_device_features_with_fallback(&device)
                .map_err(|e| e.to_string())
        }
    }).await;
    
    match result {
        Ok(Ok(features)) => {
            // Apply OOB detection heuristics from docs/usb/oob_mode_detection.md
            let likely_oob_bootloader = 
                features.bootloader_mode ||
                features.version == "Legacy Bootloader" ||
                features.version.contains("0.0.0") ||
                (!features.initialized && features.version.starts_with("1."));
            
            if likely_oob_bootloader {
                println!("🔧 Device {} appears to be in OOB bootloader mode (version: {}, bootloader_mode: {}, initialized: {})", 
                        device.unique_id, features.version, features.bootloader_mode, features.initialized);
            } else {
                println!("🔧 Device {} appears to be in OOB wallet mode (version: {}, initialized: {})", 
                        device.unique_id, features.version, features.initialized);
            }
            
            Ok(features)
        }
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Task execution error: {}", e)),
    }
}

// Create and manage event controller with proper Arc<Mutex<>> wrapper
pub fn spawn_event_controller(app: &AppHandle) -> Arc<Mutex<EventController>> {
    let mut controller = EventController::new();
    controller.start(app);
    
    let controller_arc = Arc::new(Mutex::new(controller));
    
    // Store the controller in app state so it can be properly cleaned up
    app.manage(controller_arc.clone());
    
    controller_arc
}
