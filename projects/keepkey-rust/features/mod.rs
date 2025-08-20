use anyhow::{anyhow, Result};
use hex;
use rusb::{Device, GlobalContext};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;

use crate::messages::{Initialize, Message};
use crate::transport::{ProtocolAdapter, UsbTransport, HidTransport};
use crate::friendly_usb::FriendlyUsbDevice;


const TAG: &str = " | features | ";
const DEVICE_IDS: &[(u16, u16)] = &[(0x2b24, 0x0001), (0x2b24, 0x0002)];

/// Device cache to maintain stable device identities across inconsistent USB enumeration
#[derive(Debug, Clone)]
struct CachedDeviceInfo {
    stable_id: String,
    vid: u16,
    pid: u16,
    manufacturer: Option<String>,
    product: Option<String>,
    serial_number: Option<String>,
    bus: u8,
    address: u8,
    last_seen: std::time::Instant,
}

/// Global device cache to remember stable device information
static DEVICE_CACHE: Lazy<Arc<Mutex<HashMap<String, CachedDeviceInfo>>>> = 
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Clean expired entries from the device cache (older than 60-90 seconds on Windows)
fn clean_device_cache() {
    if let Ok(mut cache) = DEVICE_CACHE.lock() {
        let now = std::time::Instant::now();
        // Use longer TTL on Windows due to more frequent enumeration changes
        #[cfg(target_os = "windows")]
        let ttl_secs = 90;
        #[cfg(not(target_os = "windows"))]
        let ttl_secs = 60;
        
        cache.retain(|_, info| now.duration_since(info.last_seen).as_secs() < ttl_secs);
    }
}

// List usb devices
// This is kept internal to this module for now.
//
// Device state/fallback heuristics are based on:
//   - /docs/usb/oob_mode_detection.md
//   - /docs/usb/hid_fallback_implementation.md
//   - Vault backend (src-tauri/src/features/mod.rs)
pub fn list_devices() -> Vec<Device<GlobalContext>> {
    rusb::devices()
        .unwrap()
        .iter()
        .filter(|device| {
            let device_desc = device.device_descriptor().unwrap();
            DEVICE_IDS.contains(&(device_desc.vendor_id(), device_desc.product_id()))
        })
        .collect::<Vec<_>>()
}

/// Structure representing device features returned by the KeepKey
/// This is a simplified version that includes the most commonly used fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFeatures {
    /// Device label or name
    pub label: Option<String>,
    /// Device vendor
    pub vendor: Option<String>,
    /// Device model
    pub model: Option<String>,
    /// Firmware variant (if any)
    pub firmware_variant: Option<String>,
    /// Unique device identifier
    pub device_id: Option<String>,
    /// Device language setting
    pub language: Option<String>,
    /// Whether the device is in bootloader mode
    pub bootloader_mode: bool,
    /// Firmware version components
    pub version: String,
    /// Firmware hash (hex encoded)
    pub firmware_hash: Option<String>,
    /// Bootloader hash (hex encoded)
    pub bootloader_hash: Option<String>,
    /// Bootloader version derived from hash
    pub bootloader_version: Option<String>,
    /// Whether the device has been initialized
    pub initialized: bool,
    /// Whether keys were imported from a computer
    pub imported: Option<bool>,
    /// Whether keys were not backed up during setup
    pub no_backup: bool,
    /// Whether PIN protection is enabled
    pub pin_protection: bool,
    /// Whether the device is currently unlocked
    pub pin_cached: bool,
    /// Whether passphrase protection is enabled
    pub passphrase_protection: bool,
    /// Whether the passphrase is currently cached
    pub passphrase_cached: bool,
    /// Whether wipe code protection is enabled
    pub wipe_code_protection: bool,
    /// Auto-lock delay in milliseconds
    pub auto_lock_delay_ms: Option<u64>,
    /// Enabled policies
    pub policies: Vec<String>,
}

/// Get device features from a specific KeepKey device
///
/// This function connects to a specific KeepKey device by matching the unique ID,
/// sends a GetFeatures request, and returns a structured representation
/// of the device's features and settings.
///
/// # Arguments
/// * `target_device` - The specific device to get features for
///
/// # Returns
/// - `Ok(DeviceFeatures)` if successful with all device information
/// - `Err` if device connection fails or the device doesn't respond properly
/// Detect the device state using Vault-style heuristics.
/// See: /docs/usb/oob_mode_detection.md
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectedDeviceState {
    WalletMode,
    BootloaderMode,
    OobWalletMode,
    OobBootloaderMode,
    Unknown,
}

/// Heuristic device state detection
pub fn detect_device_state(features: &DeviceFeatures, raw_len: Option<usize>) -> DetectedDeviceState {
    // 1. Bootloader flag
    if features.bootloader_mode {
        // If features response is very short, it's OOB bootloader
        if let Some(len) = raw_len {
            if len < 32 {
                return DetectedDeviceState::OobBootloaderMode;
            }
        }
        return DetectedDeviceState::BootloaderMode;
    }
    // 2. Firmware string
    if features.version == "Legacy Bootloader" {
        return DetectedDeviceState::BootloaderMode;
    }
    // 3. Uninitialized + short response = OOB wallet  
    if !features.initialized {
        if let Some(len) = raw_len {
            if len < 64 {
                return DetectedDeviceState::OobWalletMode;
            }
        }
        // Don't over-classify - uninitialized alone doesn't mean OOB
        return DetectedDeviceState::WalletMode;
    }
    // 4. Default
    DetectedDeviceState::WalletMode
}

pub fn get_device_features_for_device(target_device: &FriendlyUsbDevice) -> Result<DeviceFeatures> {
    log::info!("{TAG} Getting features for device: {} ({})", target_device.name, target_device.unique_id);
    
    // Add Windows FIDO blocklist warning
    #[cfg(target_os = "windows")]
    {
        log::info!("{TAG} 🪟 Windows detected - USB access may be blocked by FIDO/U2F filter driver");
        log::info!("{TAG}    If USB fails, will automatically use HID transport");
    }
    
    let devices = list_devices();
    
    let device = if let Some(serial) = &target_device.serial_number {
        devices.iter().find(|d| {
            if let Ok(handle) = d.open() {
                let timeout = std::time::Duration::from_millis(100);
                if let Ok(langs) = handle.read_languages(timeout) {
                    if let Some(lang) = langs.first() {
                        if let Ok(desc) = d.device_descriptor() {
                            if let Ok(device_serial) = handle.read_serial_number_string(*lang, &desc, timeout) {
                                return device_serial == *serial;
                            }
                        }
                    }
                }
            }
            false
        })
    } else {
        let parts: Vec<&str> = target_device.unique_id.split('_').collect();
        if parts.len() >= 2 {
            let bus_str = parts[0].strip_prefix("bus").unwrap_or("");
            let addr_str = parts[1].strip_prefix("addr").unwrap_or("");
            
            if let (Ok(bus), Ok(addr)) = (bus_str.parse::<u8>(), addr_str.parse::<u8>()) {
                devices.iter().find(|d| d.bus_number() == bus && d.address() == addr)
            } else {
                None
            }
        } else {
            None
        }
    };

    let device = device
        .ok_or_else(|| anyhow!("Specific KeepKey device not found: {}", target_device.unique_id))?
        .to_owned();

    // Use device queue's smart transport selection (WebUSB aware)
    let mut transport = crate::device_queue::DeviceQueueFactory::create_transport_for_device(target_device)
        .map_err(|e| anyhow!("Failed to initialize transport for device {}: {}", target_device.unique_id, e))?;

    // Add Windows settle delay before first communication
    #[cfg(target_os = "windows")]
    {
        log::info!("{TAG} Windows detected - adding settle delay before first Initialize");
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
    
    // Reset the device to clear any stuck state (reverting to original approach for stability)
    log::info!("{TAG} Resetting device {} before communication...", target_device.unique_id);
    transport.reset()
        .map_err(|e| anyhow!("Failed to reset device {}: {}", target_device.unique_id, e))?;
    
    // Add a small delay after reset
    std::thread::sleep(std::time::Duration::from_millis(100));

    let features_msg = transport
        .handle(Initialize::default().into())
        .map_err(|e| anyhow!("Failed to communicate with device {}: {}", target_device.unique_id, e))?;

    // Extract features from response
    let features = match features_msg {
        Message::Features(f) => f,
        _ => return Err(anyhow!("Unexpected response from device {}", target_device.unique_id)),
    };

    // Convert to our DeviceFeatures struct
    let device_features = DeviceFeatures {
        label: features.label,
        vendor: features.vendor,
        model: features.model,
        firmware_variant: features.firmware_variant,
        device_id: features.device_id,
        language: features.language,
        bootloader_mode: features.bootloader_mode.unwrap_or(false),
        version: format!(
            "{}.{}.{}",
            features.major_version.unwrap_or(0),
            features.minor_version.unwrap_or(0),
            features.patch_version.unwrap_or(0)
        ),
        firmware_hash: features.firmware_hash.map(hex::encode),
        bootloader_hash: features.bootloader_hash.clone().map(hex::encode),
        bootloader_version: features.bootloader_hash
            .map(hex::encode)
            // Bootloader version mapping removed (was device_update::bootloader_version_from_hash)
            // .and_then(|hash| bootloader_version_from_hash(&hash)),
            // Optionally just pass through the hash or leave as None
            .and_then(|hash| Some(hash)),

        initialized: features.initialized.unwrap_or(false),
        imported: features.imported,
        no_backup: features.no_backup.unwrap_or(false),
        pin_protection: features.pin_protection.unwrap_or(false),
        pin_cached: features.pin_cached.unwrap_or(false),
        passphrase_protection: features.passphrase_protection.unwrap_or(false),
        passphrase_cached: features.passphrase_cached.unwrap_or(false),
        wipe_code_protection: features.wipe_code_protection.unwrap_or(false),
        auto_lock_delay_ms: features.auto_lock_delay_ms.map(|ms| ms as u64),
        policies: features
            .policies
            .into_iter()
            .filter(|p| p.enabled())
            .map(|p| p.policy_name().to_string())
            .collect(),
    };
    log::info!("{TAG} Successfully got features for device {}: firmware v{}", target_device.unique_id, device_features.version);
    Ok(device_features)
}

/// Get device features from a connected KeepKey
///
/// This function connects to the first available KeepKey device,
/// sends a GetFeatures request, and returns a structured representation
/// of the device's features and settings.
///
/// # Returns
/// - `Ok(DeviceFeatures)` if successful with all device information
/// - `Err` if device connection fails or the device doesn't respond properly
pub fn get_device_features_impl() -> Result<DeviceFeatures> {
    // Find and connect to device
    let device = list_devices()
        .iter()
        .next()
        .ok_or_else(|| anyhow!("No KeepKey device found"))?
        .to_owned();

    let (mut transport, _, _) = UsbTransport::new(&device, 0)
        .map_err(|e| anyhow!("Failed to initialize USB transport: {}", e))?;

    // Send Initialize message and get response
    let features_msg = transport
        .handle(Initialize::default().into())
        .map_err(|e| anyhow!("Failed to communicate with device: {}", e))?;

    // Extract features from response
    let features = match features_msg {
        Message::Features(f) => f,
        _ => return Err(anyhow!("Unexpected response from device")),
    };

    // Convert to our DeviceFeatures struct
    let device_features = DeviceFeatures {
        label: features.label,
        vendor: features.vendor,
        model: features.model,
        firmware_variant: features.firmware_variant,
        device_id: features.device_id,
        language: features.language,
        bootloader_mode: features.bootloader_mode.unwrap_or(false),
        version: format!(
            "{}.{}.{}",
            features.major_version.unwrap_or(0),
            features.minor_version.unwrap_or(0),
            features.patch_version.unwrap_or(0)
        ),
        firmware_hash: features.firmware_hash.map(hex::encode),
        bootloader_hash: features.bootloader_hash.clone().map(hex::encode),
        bootloader_version: features.bootloader_hash
            .map(hex::encode)
            // Bootloader version mapping removed (was device_update::bootloader_version_from_hash)
            // .and_then(|hash| bootloader_version_from_hash(&hash)),
            // Optionally just pass through the hash or leave as None
            .and_then(|hash| Some(hash)),

        initialized: features.initialized.unwrap_or(false),
        imported: features.imported,
        no_backup: features.no_backup.unwrap_or(false),
        pin_protection: features.pin_protection.unwrap_or(false),
        pin_cached: features.pin_cached.unwrap_or(false),
        passphrase_protection: features.passphrase_protection.unwrap_or(false),
        passphrase_cached: features.passphrase_cached.unwrap_or(false),
        wipe_code_protection: features.wipe_code_protection.unwrap_or(false),
        auto_lock_delay_ms: features.auto_lock_delay_ms.map(|ms| ms as u64),
        policies: features
            .policies
            .into_iter()
            .filter(|p| p.enabled())
            .map(|p| p.policy_name().to_string())
            .collect(),
    };
    println!("{TAG} device_features: {:#?}", device_features);
    Ok(device_features)
}

/// Get device features from a specific KeepKey device with HID fallback
///
/// This function first tries USB transport, and if it fails with permission errors,
/// falls back to HID API which often has better permissions handling.
/// For older KeepKey devices (PID 0x0001), it will try HID directly as they often
/// work better with HID than with WebUSB.
///
/// # Arguments
/// * `target_device` - The specific device to get features for
///
/// # Returns
/// - `Ok(DeviceFeatures)` if successful with all device information
/// - `Err` if both USB and HID connections fail
pub fn get_device_features_with_fallback(target_device: &FriendlyUsbDevice) -> Result<DeviceFeatures> {
    log::info!("{TAG} Getting features for device with fallback: {} ({})", target_device.name, target_device.unique_id);
    
    // Add a small delay to let the device stabilize after enumeration
    std::thread::sleep(std::time::Duration::from_millis(100));
    
    let mut last_error = None;
    
    // Try up to 3 times with delays to handle temporary device unavailability
    for attempt in 1..=3 {
        log::info!("{TAG} Attempt {} of 3 for device {}", attempt, target_device.unique_id);
        
        // For older KeepKey devices (PID 0x0001), try HID directly
        if target_device.pid == 0x0001 {
            log::info!("{TAG} Detected older KeepKey device (PID 0x0001), trying HID directly");
            match get_device_features_via_hid(target_device) {
                Ok(features) => {
                    log::info!("{TAG} Successfully got features via HID for older device {} on attempt {}", target_device.unique_id, attempt);
                    return Ok(features);
                }
                Err(hid_err) => {
                    log::warn!("{TAG} HID direct attempt failed for older device {} on attempt {}: {}", 
                              target_device.unique_id, attempt, hid_err);
                    last_error = Some(hid_err);
                    // Don't try USB for older devices, just retry HID
                    if attempt < 3 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        continue;
                    }
                }
            }
        } else {
            // For newer devices, try USB first, then HID
            match get_device_features_for_device(target_device) {
                Ok(features) => {
                    log::info!("{TAG} Successfully got features via USB for device {} on attempt {}", target_device.unique_id, attempt);
                    return Ok(features);
                }
                Err(usb_err) => {
                    log::warn!("{TAG} USB failed for device {} on attempt {}: {}, trying HID fallback", 
                              target_device.unique_id, attempt, usb_err);
                    
                    // Try HID transport as fallback
                    match get_device_features_via_hid(target_device) {
                        Ok(features) => {
                            log::info!("{TAG} Successfully got features via HID for device {} on attempt {}", target_device.unique_id, attempt);
                            return Ok(features);
                        }
                        Err(hid_err) => {
                            log::warn!("{TAG} HID fallback also failed for device {} on attempt {}: {}", target_device.unique_id, attempt, hid_err);
                            last_error = Some(anyhow!("Failed with both USB ({}) and HID ({})", usb_err, hid_err));
                        }
                    }
                }
            }
        }
        
        // Wait before retrying (exponential backoff)
        if attempt < 3 {
            let delay_ms = 250 * attempt as u64; // 250ms, 500ms
            log::info!("{TAG} Waiting {}ms before retry for device {}", delay_ms, target_device.unique_id);
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
    }
    
    // All attempts failed
    match last_error {
        Some(err) => Err(err),
        None => Err(anyhow!("All communication attempts failed for device {}", target_device.unique_id))
    }
}

/// Get device features from a specific KeepKey device via HID
///
/// This function connects to the specific KeepKey device using HID API,
/// sends a GetFeatures request, and returns a structured representation
/// of the device's features and settings.
///
/// # Arguments
/// * `target_device` - The specific device to get features for
///
/// # Returns
/// - `Ok(DeviceFeatures)` if successful with all device information
/// - `Err` if device connection fails or the device doesn't respond properly
pub fn get_device_features_via_hid(target_device: &FriendlyUsbDevice) -> Result<DeviceFeatures> {
    use hidapi::HidApi;
    log::info!("{TAG} Getting features for device via HID: {} ({})", target_device.name, target_device.unique_id);

    // If serial is present, use it; otherwise, enumerate all HID KeepKey devices and try each
    let mut errors = vec![];
    if let Some(serial) = &target_device.serial_number {
        match HidTransport::new_for_device(Some(serial.as_str())) {
            Ok(mut transport) => {
                let adapter = &mut transport as &mut dyn ProtocolAdapter;
                
                // Reset device before communication
                log::info!("{TAG} Resetting HID device via serial {} before communication...", serial);
                let _ = adapter.reset(); // Ignore reset errors for HID
                std::thread::sleep(std::time::Duration::from_millis(100));
                
                // Add Windows settle delay
                #[cfg(target_os = "windows")]
                {
                    log::info!("{TAG} Windows detected - adding settle delay after reset");
                    std::thread::sleep(std::time::Duration::from_millis(700));
                }
                
                let init_msg: Message = Initialize::default().into();
                match adapter.handle(init_msg) {
                    Ok(features_msg) => {
                        let features = match features_msg {
                            Message::Features(f) => f,
                            _ => return Err(anyhow!("Unexpected response from device {} via HID", target_device.unique_id)),
                        };
                        let device_features = DeviceFeatures {
                            label: features.label,
                            vendor: features.vendor,
                            model: features.model,
                            firmware_variant: features.firmware_variant,
                            device_id: features.device_id,
                            language: features.language,
                            bootloader_mode: features.bootloader_mode.unwrap_or(false),
                            version: format!(
                                "{}.{}.{}",
                                features.major_version.unwrap_or(0),
                                features.minor_version.unwrap_or(0),
                                features.patch_version.unwrap_or(0)
                            ),
                            firmware_hash: features.firmware_hash.map(hex::encode),
                            bootloader_hash: features.bootloader_hash.clone().map(hex::encode),
                            bootloader_version: features.bootloader_hash
                                .map(hex::encode)
                                .and_then(|hash| Some(hash)),
                            initialized: features.initialized.unwrap_or(false),
                            imported: features.imported,
                            no_backup: features.no_backup.unwrap_or(false),
                            pin_protection: features.pin_protection.unwrap_or(false),
                            pin_cached: features.pin_cached.unwrap_or(false),
                            passphrase_protection: features.passphrase_protection.unwrap_or(false),
                            passphrase_cached: features.passphrase_cached.unwrap_or(false),
                            wipe_code_protection: features.wipe_code_protection.unwrap_or(false),
                            auto_lock_delay_ms: features.auto_lock_delay_ms.map(|ms| ms as u64),
                            policies: features
                                .policies
                                .into_iter()
                                .filter(|p| p.enabled())
                                .map(|p| p.policy_name().to_string())
                                .collect(),
                        };
                        log::info!("{TAG} Successfully got features via HID for device {}: firmware v{}", target_device.unique_id, device_features.version);
                        return Ok(device_features);
                    }
                    Err(e) => errors.push(format!("HID (serial match) error: {}", e)),
                }
            }
            Err(e) => errors.push(format!("HID (serial match) transport error: {}", e)),
        }
    } else {
        // No serial: enumerate all HID KeepKey devices and try each
        let api = HidApi::new().map_err(|e| anyhow!("Failed to initialize HID API: {}", e))?;
        let mut found_any = false;
        for device_info in api.device_list() {
            if device_info.vendor_id() == 0x2b24 && (device_info.product_id() == 0x0001 || device_info.product_id() == 0x0002) {
                found_any = true;
                match HidTransport::new_for_device(device_info.serial_number()) {
                    Ok(mut transport) => {
                        let adapter = &mut transport as &mut dyn ProtocolAdapter;
                        
                        // Add Windows settle delay
                        #[cfg(target_os = "windows")]
                        {
                            log::info!("{TAG} Windows detected - adding settle delay before HID Initialize (enumerate)");
                            std::thread::sleep(std::time::Duration::from_millis(800));
                        }
                        
                        let init_msg: Message = Initialize::default().into();
                        // Try without reset first
                        match adapter.handle(init_msg.clone()) {
                            Ok(features_msg) => {
                                let features = match features_msg {
                                    Message::Features(f) => f,
                                    _ => continue, // try next
                                };
                                let device_features = DeviceFeatures {
                                    label: features.label,
                                    vendor: features.vendor,
                                    model: features.model,
                                    firmware_variant: features.firmware_variant,
                                    device_id: features.device_id,
                                    language: features.language,
                                    bootloader_mode: features.bootloader_mode.unwrap_or(false),
                                    version: format!(
                                        "{}.{}.{}",
                                        features.major_version.unwrap_or(0),
                                        features.minor_version.unwrap_or(0),
                                        features.patch_version.unwrap_or(0)
                                    ),
                                    firmware_hash: features.firmware_hash.map(hex::encode),
                                    bootloader_hash: features.bootloader_hash.clone().map(hex::encode),
                                    bootloader_version: features.bootloader_hash
                                        .map(hex::encode)
                                        .and_then(|hash| Some(hash)),
                                    initialized: features.initialized.unwrap_or(false),
                                    imported: features.imported,
                                    no_backup: features.no_backup.unwrap_or(false),
                                    pin_protection: features.pin_protection.unwrap_or(false),
                                    pin_cached: features.pin_cached.unwrap_or(false),
                                    passphrase_protection: features.passphrase_protection.unwrap_or(false),
                                    passphrase_cached: features.passphrase_cached.unwrap_or(false),
                                    wipe_code_protection: features.wipe_code_protection.unwrap_or(false),
                                    auto_lock_delay_ms: features.auto_lock_delay_ms.map(|ms| ms as u64),
                                    policies: features
                                        .policies
                                        .into_iter()
                                        .filter(|p| p.enabled())
                                        .map(|p| p.policy_name().to_string())
                                        .collect(),
                                };
                                log::info!("{TAG} Successfully got features via HID (enumerate) for device: firmware v{}", device_features.version);
                                return Ok(device_features);
                            }
                            Err(e) => errors.push(format!("HID (enumerate) comm error for serial {:?}: {}", device_info.serial_number(), e)),
                        }
                    }
                    Err(e) => errors.push(format!("HID (enumerate) transport error for serial {:?}: {}", device_info.serial_number(), e)),
                }
            }
        }
        if !found_any {
            errors.push("No HID KeepKey devices found".to_string());
        }
    }
    Err(anyhow!("All HID attempts failed for device {}. Errors: {}", target_device.unique_id, errors.join(" | ")))
}

/// Convert a low-level USB device to a FriendlyUsbDevice
/// This function handles all the USB string descriptor reading internally
fn device_to_friendly(device: &rusb::Device<rusb::GlobalContext>) -> FriendlyUsbDevice {
    let desc = device.device_descriptor().unwrap();
    let vid = desc.vendor_id();
    let pid = desc.product_id();
    
    // Try to get string descriptors
    let (manufacturer, product, serial_number) = if let Ok(handle) = device.open() {
        let timeout = std::time::Duration::from_millis(100);
        let langs = handle.read_languages(timeout).unwrap_or_default();
        
        if let Some(&lang) = langs.first() {
            let manuf = if desc.manufacturer_string_index().is_some() {
                handle.read_manufacturer_string(lang, &desc, timeout).ok()
            } else {
                None
            };
            
            let prod = if desc.product_string_index().is_some() {
                handle.read_product_string(lang, &desc, timeout).ok()
            } else {
                None
            };
            
            let serial = if desc.serial_number_string_index().is_some() {
                handle.read_serial_number_string(lang, &desc, timeout).ok()
            } else {
                None
            };
            
            (manuf, prod, serial)
        } else {
            (None, None, None)
        }
    } else {
        // If it's a KeepKey device and we can't open it, still add it with default values
        if vid == 0x2B24 { // KEEPKEY_VID
            log::warn!("Could not open KeepKey device {:04x}:{:04x}. Using default values.", vid, pid);
            (Some("KeepKey".to_string()), Some("KeepKey".to_string()), None)
        } else {
            (None, None, None)
        }
    };
    
    // Create a stable unique system_id for the device (same logic as working vault)
    let mut use_serial_as_id = false;
    if let Some(sn) = &serial_number {
        if !sn.is_empty() {
            use_serial_as_id = true;
        }
    }

    let unique_id = if use_serial_as_id {
        serial_number.clone().unwrap() // Safe: checked is_some and !is_empty
    } else {
        // Serial is None or Some("")
        if vid == 0x2B24 { // KEEPKEY_VID
            if serial_number.is_some() { // Implies Some("") because use_serial_as_id is false
                log::info!("KeepKey device (VID:{:04x}, PID:{:04x}) with empty serial. Using fallback ID.", vid, pid);
            } else { // Implies None
                log::info!("KeepKey device (VID:{:04x}, PID:{:04x}) with no serial. Using fallback ID.", vid, pid);
            }
            format!("keepkey_{:04x}_{:04x}_bus{}_addr{}", 
                    vid, pid, 
                    device.bus_number(), 
                    device.address())
        } else {
            // Non-KeepKey device, and serial is None or Some("")
            format!("bus{}_addr{}", device.bus_number(), device.address())
        }
    };
    
    FriendlyUsbDevice::new(
        unique_id,
        vid,
        pid,
        manufacturer,
        product,
        serial_number,
    )
}

/// List all connected KeepKey devices as FriendlyUsbDevice structures
/// 
/// This is the high-level API that applications should use instead of 
/// directly calling list_devices() and doing USB string descriptor operations.
///
/// # Returns
/// - `Vec<FriendlyUsbDevice>` containing all connected KeepKey devices with friendly names
pub fn list_connected_devices() -> Vec<FriendlyUsbDevice> {
    // Clean expired cache entries first
    clean_device_cache();
    
    // Add a small delay to allow USB enumeration to stabilize
    std::thread::sleep(std::time::Duration::from_millis(50));
    
    let devices = list_devices();
    let mut current_devices = Vec::new();
    let mut seen_bus_addr = std::collections::HashSet::new();
    
    for device in devices.iter() {
        // Only process KeepKey devices
        if let Ok(desc) = device.device_descriptor() {
            if desc.vendor_id() == 0x2B24 { // KEEPKEY_VID
                let bus = device.bus_number();
                let addr = device.address();
                let bus_addr_key = format!("{}:{}", bus, addr);
                
                // Skip if we've already processed this bus:address combination
                if seen_bus_addr.contains(&bus_addr_key) {
                    continue;
                }
                seen_bus_addr.insert(bus_addr_key.clone());
                
                let friendly_device = device_to_friendly_with_cache(device);
                current_devices.push(friendly_device);
            }
        }
    }
    
    current_devices
}

/// Convert a USB device to FriendlyUsbDevice with caching for stability
fn device_to_friendly_with_cache(device: &rusb::Device<rusb::GlobalContext>) -> FriendlyUsbDevice {
    let desc = device.device_descriptor().unwrap();
    let vid = desc.vendor_id();
    let pid = desc.product_id();
    let bus = device.bus_number();
    let addr = device.address();
    let bus_addr_key = format!("{}:{}", bus, addr);
    
    // Check cache first for this bus:address combination (O(1) lookup)
    if let Ok(mut cache) = DEVICE_CACHE.lock() {
        if let Some(cached_info) = cache.get_mut(&bus_addr_key) {
            // Found cached info for this bus:address, update last_seen and return stable device
            cached_info.last_seen = std::time::Instant::now();
            log::info!("[CACHE HIT] Found device in cache: bus:addr={}, stable_id={}", bus_addr_key, cached_info.stable_id);
            return FriendlyUsbDevice::new(
                cached_info.stable_id.clone(),
                cached_info.vid,
                cached_info.pid,
                cached_info.manufacturer.clone(),
                cached_info.product.clone(),
                cached_info.serial_number.clone(),
            );
        }
    }
    
    // Not in cache, try to read device information
    let (manufacturer, product, serial_number) = if let Ok(handle) = device.open() {
        let timeout = std::time::Duration::from_millis(100);
        let langs = handle.read_languages(timeout).unwrap_or_default();
        
        if let Some(&lang) = langs.first() {
            let manuf = if desc.manufacturer_string_index().is_some() {
                handle.read_manufacturer_string(lang, &desc, timeout).ok()
            } else {
                None
            };
            
            let prod = if desc.product_string_index().is_some() {
                handle.read_product_string(lang, &desc, timeout).ok()
            } else {
                None
            };
            
            let serial = if desc.serial_number_string_index().is_some() {
                handle.read_serial_number_string(lang, &desc, timeout).ok()
            } else {
                None
            };
            
            (manuf, prod, serial)
        } else {
            (None, None, None)
        }
    } else {
        // If it's a KeepKey device and we can't open it, still add it with default values
        if vid == 0x2B24 { // KEEPKEY_VID
            log::warn!("Could not open KeepKey device {:04x}:{:04x}. Using default values.", vid, pid);
            (Some("KeepKey".to_string()), Some("KeepKey".to_string()), None)
        } else {
            (None, None, None)
        }
    };
    
    // Check for serial reuse - device reconnected with different bus:addr
    if let Some(ref serial) = serial_number {
        if !serial.is_empty() {
            if let Ok(mut cache) = DEVICE_CACHE.lock() {
                // Look for existing entry with this serial
                let existing_entry = cache.iter_mut()
                    .find(|(_, info)| info.serial_number.as_ref() == Some(serial));
                
                if let Some((old_key, info)) = existing_entry {
                    // Device reconnected - reuse stable ID and update
                    log::info!("[SERIAL REUSE] Device with serial {} reconnected: old bus:addr={}, new bus:addr={}", 
                              serial, old_key, bus_addr_key);
                    info.last_seen = std::time::Instant::now();
                    info.bus = bus;
                    info.address = addr;
                    
                    let stable_device = FriendlyUsbDevice::new(
                        info.stable_id.clone(),
                        info.vid,
                        info.pid,
                        info.manufacturer.clone(),
                        info.product.clone(),
                        info.serial_number.clone(),
                    );
                    
                    // Add alias entry for new bus:addr pointing to same device info
                    let cached_info = info.clone();
                    cache.insert(bus_addr_key.clone(), cached_info);
                    
                    return stable_device;
                }
            }
        }
    }
    
    // Determine stable unique ID - prefer serial if available
    let stable_id = if let Some(ref serial) = serial_number {
        if !serial.is_empty() {
            log::info!("[DEVICE ID] Using serial as stable ID: {}", serial);
            serial.clone()
        } else {
            let id = format!("keepkey_{:04x}_{:04x}_bus{}_addr{}", vid, pid, bus, addr);
            log::info!("[DEVICE ID] Serial empty, using fallback ID: {}", id);
            id
        }
    } else {
        let id = format!("keepkey_{:04x}_{:04x}_bus{}_addr{}", vid, pid, bus, addr);
        log::info!("[DEVICE ID] No serial, using fallback ID: {}", id);
        id
    };
    
    // Cache this device information
    if let Ok(mut cache) = DEVICE_CACHE.lock() {
        let cache_key = bus_addr_key.clone();
        let cached_info = CachedDeviceInfo {
            stable_id: stable_id.clone(),
            vid,
            pid,
            manufacturer: manufacturer.clone(),
            product: product.clone(),
            serial_number: serial_number.clone(),
            bus,
            address: addr,
            last_seen: std::time::Instant::now(),
        };
        cache.insert(cache_key, cached_info);
        log::info!("[CACHE] Cached device: bus:addr={}, stable_id={}, serial={:?}", 
                  bus_addr_key, stable_id, serial_number);
    }
    
    FriendlyUsbDevice::new(
        stable_id,
        vid,
        pid,
        manufacturer,
        product,
        serial_number,
    )
}

/// Get device features by device ID using high-level API
/// 
/// This function finds the device by ID and gets its features with automatic USB/HID fallback.
/// Applications should use this instead of manually finding devices and calling feature functions.
///
/// # Arguments
/// * `device_id` - The unique device ID to get features for
///
/// # Returns
/// - `Ok(DeviceFeatures)` if successful with all device information
/// - `Err` if device not found or feature retrieval fails
pub fn get_device_features_by_id(device_id: &str) -> Result<DeviceFeatures> {
    let devices = list_connected_devices();
    let device = devices
        .iter()
        .find(|d| d.unique_id == device_id)
        .ok_or_else(|| anyhow!("Device {} not found", device_id))?;
    
    get_device_features_with_fallback(device)
}

