use tauri::{State, AppHandle, Emitter};
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::RwLock;


// Import types needed for DeviceRequestWrapper
use crate::commands::{DeviceRequestWrapper, DeviceRequest, DeviceResponse, DeviceQueueManager, parse_transaction_from_hex};

// Create a cache for device states to remember OOB bootloader status
lazy_static::lazy_static! {
    pub static ref DEVICE_STATE_CACHE: Arc<RwLock<HashMap<String, DeviceStateCache>>> = Arc::new(RwLock::new(HashMap::new()));
    pub static ref PASSPHRASE_REQUEST_STATE: Arc<RwLock<HashMap<String, PassphraseRequestState>>> = Arc::new(RwLock::new(HashMap::new()));
}

#[derive(Debug, Clone)]
pub struct DeviceStateCache {
    pub is_oob_bootloader: bool,
    pub last_features: Option<keepkey_rust::messages::Features>,
    #[allow(dead_code)]
    pub last_update: std::time::Instant,
}

#[derive(Debug, Clone)]
pub struct PassphraseRequestState {
    pub is_active: bool,
    pub request_id: String,
    pub timestamp: std::time::Instant,
}

#[tauri::command]
pub async fn add_to_device_queue(
    request: DeviceRequestWrapper,
    queue_manager: State<'_, DeviceQueueManager>,
    last_responses: State<'_, Arc<tokio::sync::Mutex<std::collections::HashMap<String, DeviceResponse>>>>,
    app: AppHandle,
) -> Result<String, String> {
    println!("Adding to device queue: {:?}", request);
    
    // Log the incoming request
    let request_data = serde_json::json!({
        "request": request.request,
        "device_id": request.device_id,
        "request_id": request.request_id
    });
    
    let request_type = match &request.request {
        DeviceRequest::GetXpub { .. } => "GetXpub",
        DeviceRequest::GetAddress { .. } => "GetAddress", 
        DeviceRequest::GetFeatures => "GetFeatures",
        DeviceRequest::SignTransaction { .. } => "SignTransaction",
        DeviceRequest::SendRaw { .. } => "SendRaw",
    };
    
    if let Err(e) = crate::logging::log_device_request(
        &request.device_id,
        &request.request_id,
        request_type,
        &request_data
    ).await {
        eprintln!("Failed to log device request: {}", e);
    }

    // --------------------------------------------------------------
    // Get or create (and cache) the per-device queue handle
    // --------------------------------------------------------------
    let queue_handle = {
        let mut manager = queue_manager.lock().await;

        if let Some(handle) = manager.get(&request.device_id) {
            handle.clone()
        } else {
            // Find the device by ID using high-level API
            let devices = keepkey_rust::features::list_connected_devices();
            let device_info = devices
                .iter()
                .find(|d| d.unique_id == request.device_id)
                .ok_or_else(|| format!("Device {} not found", request.device_id))?;

            // Spawn a new device worker using the real keepkey_rust implementation
            let handle = keepkey_rust::device_queue::DeviceQueueFactory::spawn_worker(request.device_id.clone(), device_info.clone());
            manager.insert(request.device_id.clone(), handle.clone());
            handle
        }
    };

    // ------------------------------------------------------------------
    // Check if device is in PIN flow BEFORE doing anything else
    // ------------------------------------------------------------------
    if crate::commands::is_device_in_pin_flow(&request.device_id) {
        // Don't interrupt PIN flow with ANY device operations
        match &request.request {
            DeviceRequest::GetXpub { .. } | 
            DeviceRequest::GetAddress { .. } | 
            DeviceRequest::SignTransaction { .. } => {
                println!("🚫 Blocking request during PIN flow - device is entering PIN");
                return Err("Device is currently in PIN entry mode. Please complete PIN entry first.".to_string());
            },
            _ => {
                // Allow GetFeatures and SendRaw during PIN flow as they might be needed
            }
        }
    }
    
    // ------------------------------------------------------------------
    // Check if device has an active passphrase request - BLOCK OTHER REQUESTS
    // ------------------------------------------------------------------
    let has_active_passphrase = {
        let passphrase_state = PASSPHRASE_REQUEST_STATE.read().await;
        passphrase_state.get(&request.device_id).map_or(false, |state| state.is_active)
    };
    
    if has_active_passphrase {
        // Don't interrupt passphrase flow with ANY device operations
        match &request.request {
            DeviceRequest::GetXpub { .. } | 
            DeviceRequest::GetAddress { .. } | 
            DeviceRequest::SignTransaction { .. } | 
            DeviceRequest::GetFeatures => {
                println!("🚫 BLOCKING request during passphrase flow - device is awaiting passphrase");
                return Err("PASSPHRASE_REQUIRED".to_string());  // Return same error so frontend knows
            },
            DeviceRequest::SendRaw { .. } => {
                // Allow SendRaw as it might be the PassphraseAck
            }
        }
    }
    
    // ------------------------------------------------------------------
    // Pre-flight status check – ensure the device can service this request
    // ------------------------------------------------------------------
    
    // Skip GetFeatures if device is in PIN flow OR has active passphrase request to avoid disrupting
    let raw_features_opt = if crate::commands::is_device_in_pin_flow(&request.device_id) || has_active_passphrase {
        if crate::commands::is_device_in_pin_flow(&request.device_id) {
            println!("⚠️ Skipping GetFeatures check - device is in PIN flow");
        }
        if has_active_passphrase {
            println!("⚠️ Skipping GetFeatures check - device has active passphrase request");
        }
        // Check cache for last known features
        let cache = DEVICE_STATE_CACHE.read().await;
        cache.get(&request.device_id).and_then(|state| state.last_features.clone())
    } else {
        // We fetch the current features via the queue (which opens a temporary
        // transport) so that we have accurate mode/version information.
        match keepkey_rust::device_queue::DeviceQueueHandle::get_features(&queue_handle).await {
            Ok(f) => {
                // Successfully got features, update cache
                let mut cache = DEVICE_STATE_CACHE.write().await;
                cache.insert(request.device_id.clone(), DeviceStateCache {
                    is_oob_bootloader: false,
                    last_features: Some(f.clone()),
                    last_update: std::time::Instant::now(),
                });
                Some(f)
            },
            Err(e) => {
                eprintln!("⚠️  Unable to fetch features for status check: {e}");
                
                // Check if we have cached state for this device
                let cache = DEVICE_STATE_CACHE.read().await;
                if let Some(cached_state) = cache.get(&request.device_id) {
                    // If we know this is an OOB bootloader from a previous successful check
                    if cached_state.is_oob_bootloader {
                        println!("📋 Using cached OOB bootloader state for device {}", request.device_id);
                        cached_state.last_features.clone()
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        }
    };

    let status = if let Some(raw) = &raw_features_opt {
        // Convert to the simplified struct used by the evaluator
        let converted = crate::commands::convert_features_to_device_features(raw.clone());
        crate::commands::evaluate_device_status(request.device_id.clone(), Some(&converted))
    } else {
        // Fallback – we couldn't grab features, assume unknown status
        crate::commands::evaluate_device_status(request.device_id.clone(), None)
    };

    // Special handling for devices that might be in OOB bootloader mode
    let _is_likely_oob_bootloader = raw_features_opt.is_none() && request_type != "GetFeatures";
    
    // If we couldn't fetch features AND this isn't a plain GetFeatures request
    if raw_features_opt.is_none() && request_type != "GetFeatures" {
        // Check if the device was successfully detected during initial connection
        // (which would have used Initialize for OOB bootloaders)
        let devices = keepkey_rust::features::list_connected_devices();
        let device_exists = devices.iter().any(|d| d.unique_id == request.device_id);
        
        if device_exists {
            println!("🔧 Device {} exists but GetFeatures failed - likely OOB bootloader, allowing request to proceed", request.device_id);
            // Mark this device as OOB bootloader in cache
            let mut cache = DEVICE_STATE_CACHE.write().await;
            cache.insert(request.device_id.clone(), DeviceStateCache {
                is_oob_bootloader: true,
                last_features: None,
                last_update: std::time::Instant::now(),
            });
        } else {
            println!("🚫 Rejecting {request_type} request – unable to determine device state (features fetch failed)");
            return Err("Device state unknown – cannot service request until communication succeeds.".to_string());
        }
    }

    // Check if device is in interactive PIN flow and block other operations
    if crate::commands::is_device_in_pin_flow(&request.device_id) {
        println!("🚫 Rejecting {request_type} request – device is in PIN creation flow");
        return Err("Device is currently in PIN creation flow. Please complete PIN setup before making other requests.".to_string());
    }

    // Only block requests if device needs bootloader update or initialization
    // Firmware updates should NOT block GetXpub or other basic operations
    // Don't block if we simply can't determine the state (OOB bootloader case)
    if raw_features_opt.is_some() && (status.needs_bootloader_update || status.needs_initialization) {
        let mut reasons = Vec::new();
        if status.needs_bootloader_update { reasons.push("bootloader update"); }
        if status.needs_initialization   { reasons.push("initialization"); }
        let reason_str = reasons.join(", ");
        println!("🚫 Rejecting {request_type} request – device requires {reason_str}");
        return Err(format!("Device cannot process requests until {} is completed.", reason_str));
    }
    
    // Log a warning for firmware updates but don't block operations
    if raw_features_opt.is_some() && status.needs_firmware_update {
        println!("⚠️ Device needs firmware update but allowing {request_type} request to proceed");
    }

    // Automatically trigger PIN entry for authenticated requests if device needs PIN unlock (except GetFeatures)
    // This ensures PIN entry is prompted immediately for all commands that need authentication
    if raw_features_opt.is_some() && status.needs_pin_unlock && request_type != "GetFeatures" {
        println!("🔒 Device is locked and needs PIN unlock for {request_type} request");
        
        // Check if device is already in PIN flow to avoid conflicts
        if !crate::commands::is_device_in_pin_flow(&request.device_id) {
            println!("🔑 Automatically triggering PIN entry for authenticated request");
            
            // Mark device as in PIN flow to prevent other operations from interfering
            if let Err(e) = crate::commands::mark_device_in_pin_flow(&request.device_id) {
                println!("⚠️ Failed to mark device in PIN flow: {}", e);
            }
            
            // Create a simple request that will trigger PIN on locked device
            let get_address = keepkey_rust::messages::GetAddress {
                address_n: vec![44, 0, 0, 0, 0], // m/44'/0'/0'/0/0
                coin_name: Some("Bitcoin".to_string()),
                script_type: Some(0), // SPENDADDRESS
                show_display: Some(false),
                ..Default::default()
            };
            
            // Send the PIN trigger request - this will prompt for PIN
            match queue_handle.send_raw(get_address.into(), false).await {
                Ok(keepkey_rust::messages::Message::PinMatrixRequest(_)) => {
                    println!("✅ Successfully triggered PIN request for device: {}", request.device_id);
                    
                    // Emit PIN request event to frontend
                    let pin_event_payload = serde_json::json!({
                        "deviceId": request.device_id,
                        "requestType": request_type,
                        "needsPinEntry": true
                    });
                    
                    if let Err(e) = app.emit("device:pin-request-triggered", &pin_event_payload) {
                        println!("❌ Failed to emit PIN request event: {}", e);
                    } else {
                        println!("📡 Emitted device:pin-request-triggered event");
                    }
                    
                    // Return error indicating PIN is needed, but it's now been triggered
                    return Err("PIN entry required. PIN request has been triggered - please enter your PIN and then retry the request.".to_string());
                }
                Ok(keepkey_rust::messages::Message::Failure(f)) => {
                    // Clean up PIN flow marking on failure
                    let _ = crate::commands::unmark_device_in_pin_flow(&request.device_id);
                    
                    // Check if this is the expected "Unknown message" failure when device is already in PIN mode
                    if f.message.as_deref() == Some("Unknown message") {
                        println!("✅ Device {} appears to already be in PIN mode", request.device_id);
                        return Err("Device is already waiting for PIN entry. Please enter your PIN.".to_string());
                    } else {
                        println!("⚠️ PIN trigger failed with: {:?}", f.message);
                        return Err(format!("Failed to trigger PIN entry: {}", f.message.unwrap_or_default()));
                    }
                }
                Ok(other_msg) => {
                    // Clean up PIN flow marking on unexpected response
                    let _ = crate::commands::unmark_device_in_pin_flow(&request.device_id);
                    println!("⚠️ Unexpected response when triggering PIN request: {:?}", other_msg.message_type());
                    return Err("Unexpected response when triggering PIN entry.".to_string());
                }
                Err(e) => {
                    // Clean up PIN flow marking on error
                    let _ = crate::commands::unmark_device_in_pin_flow(&request.device_id);
                    println!("❌ Failed to trigger PIN request: {}", e);
                    return Err(format!("Failed to trigger PIN entry: {}", e));
                }
            }
        } else {
            // Device is already in PIN flow
            println!("🔑 Device is already in PIN flow - PIN entry should be in progress");
            return Err("Device is already waiting for PIN entry. Please enter your PIN.".to_string());
        }
    }


    // Mark device as busy when starting operation
    crate::device::state::set_device_busy(&request.device_id, Some(request_type.to_string())).await;
    
    // Process the request based on type
    let result = match request.request {
        DeviceRequest::GetXpub { ref path } => {
            // Parse derivation path
            let path_parts = crate::commands::parse_derivation_path(&path)?;
            
            // Create GetPublicKey message for xpub
            let get_public_key = keepkey_rust::messages::Message::GetPublicKey(
                keepkey_rust::messages::GetPublicKey {
                    address_n: path_parts.clone(),
                    coin_name: Some("Bitcoin".to_string()),
                    script_type: None, // Default script type
                    ecdsa_curve_name: Some("secp256k1".to_string()),
                    show_display: Some(false), // Don't show on device for xpub requests
                    ..Default::default()
                }
            );
            
            // Send raw message to get xpub with passphrase support
            let response = queue_handle
                .send_raw(get_public_key, false)
                .await
                .map_err(|e| format!("Failed to get xpub: {}", e))?;
            
            match response {
                keepkey_rust::messages::Message::PublicKey(public_key) => {
                    // Extract xpub from the response
                    let xpub = public_key.xpub.unwrap_or_default();
                    if xpub.is_empty() {
                        Err("Device returned empty xpub".to_string())
                    } else {
                        Ok(xpub)
                    }
                }
                keepkey_rust::messages::Message::PassphraseRequest(_) => {
                    println!("🔐 Device requested passphrase for xpub");
                    
                    // Check if there's already an active passphrase request for this device
                    {
                        let mut passphrase_state = PASSPHRASE_REQUEST_STATE.write().await;
                        if let Some(state) = passphrase_state.get(&request.device_id) {
                            if state.is_active {
                                // Check if the request is stale (older than 2 minutes)
                                if state.timestamp.elapsed().as_secs() > 120 {
                                    println!("🧹 Clearing stale passphrase request for device {} (age: {}s)", 
                                        request.device_id, state.timestamp.elapsed().as_secs());
                                    passphrase_state.remove(&request.device_id);
                                    // Continue with new request
                                } else {
                                    println!("⚠️ Passphrase request already active for device {}, skipping duplicate", request.device_id);
                                    return Err("PASSPHRASE_ALREADY_REQUESTED".to_string());
                                }
                            }
                        }
                    }
                    
                    // Mark passphrase request as active
                    {
                        let mut passphrase_state = PASSPHRASE_REQUEST_STATE.write().await;
                        passphrase_state.insert(request.device_id.clone(), PassphraseRequestState {
                            is_active: true,
                            request_id: request.request_id.clone(),
                            timestamp: std::time::Instant::now(),
                        });
                    }
                    
                    // Store the pending GetPublicKey operation (clone path_parts to avoid move)
                    let get_public_key_msg = keepkey_rust::messages::Message::GetPublicKey(
                        keepkey_rust::messages::GetPublicKey {
                            address_n: path_parts.clone(),
                            coin_name: Some("Bitcoin".to_string()),
                            script_type: None,
                            ecdsa_curve_name: Some("secp256k1".to_string()),
                            show_display: Some(false),
                            ..Default::default()
                        }
                    );
                    
                    super::pending_operations::store_pending_operation(
                        request.device_id.clone(),
                        request.request_id.clone(),
                        get_public_key_msg,
                    ).await;
                    
                    // Emit passphrase request event to frontend
                    let payload = serde_json::json!({
                        "requestId": request.request_id.clone(),
                        "deviceId": request.device_id.clone(),
                    });
                    
                    println!("📡 Emitting passphrase_request event for device: {}", request.device_id);
                    if let Err(e) = app.emit("passphrase_request", payload.clone()) {
                        eprintln!("Failed to emit passphrase_request event: {}", e);
                    } else {
                        println!("✅ Successfully emitted passphrase_request event with payload: {:?}", payload);
                    }
                    
                    // Return a specific error that the frontend can recognize
                    Err("PASSPHRASE_REQUIRED".to_string())
                }
                keepkey_rust::messages::Message::Failure(failure) => {
                    Err(format!("Device returned error: {}", failure.message.unwrap_or_default()))
                }
                _ => {
                    Err("Unexpected response from device for xpub request".to_string())
                }
            }
        }
        DeviceRequest::GetAddress { ref path, ref coin_name, ref script_type, show_display } => {
            let path_parts = crate::commands::parse_derivation_path(&path)?;
            let script_type_int = match script_type.as_deref() {
                Some("p2pkh") => Some(0),       // SPENDADDRESS = 0
                Some("p2sh-p2wpkh") => Some(4), // SPENDP2SHWITNESS = 4  
                Some("p2wpkh") => Some(3),      // SPENDWITNESS = 3
                _ => None,
            };
            
            queue_handle
                .get_address(path_parts, coin_name.clone(), script_type_int, show_display)
                .await
                .map_err(|e| format!("Failed to get address: {}", e))
        }
        DeviceRequest::GetFeatures => {
            let features = queue_handle
                .get_features()
                .await
                .map_err(|e| format!("Failed to get features: {}", e))?;
            
            // Update device state based on features
            crate::device::state::update_device_state_from_features(&request.device_id, &features).await;
            
            // Create a serializable version of features
            let features_json = serde_json::json!({
                "version": format!("{}.{}.{}", 
                    features.major_version.unwrap_or(0), 
                    features.minor_version.unwrap_or(0), 
                    features.patch_version.unwrap_or(0)),
                "initialized": features.initialized.unwrap_or(false),
                "label": features.label.unwrap_or_default(),
                "vendor": features.vendor.unwrap_or_default(),
                "model": features.model.unwrap_or_default(),
                "bootloader_mode": features.bootloader_mode.unwrap_or(false)
            });
            
            Ok(features_json.to_string())
        }
        DeviceRequest::SignTransaction { ref coin, ref inputs, ref outputs, version, lock_time } => {
            // Build transaction map with previous transactions and unsigned transaction
            let mut tx_map = std::collections::HashMap::new();
            
            // Cache previous transactions (only required for legacy inputs)
            for (idx, input) in inputs.iter().enumerate() {
                // Only legacy (p2pkh) inputs require previous transaction hex
                // SegWit inputs (p2sh, p2sh-p2wpkh, p2wpkh) do NOT need hex
                let needs_hex = input.script_type == "p2pkh";
                
                if let Some(hex_data) = &input.prev_tx_hex {
                    if !hex_data.is_empty() {
                        let tx_hash = hex::decode(&input.txid).map_err(|e| format!("Invalid txid hex: {}", e))?;
                        let tx_hash_hex = hex::encode(&tx_hash);
                        
                        // Parse the previous transaction from hex
                        match parse_transaction_from_hex(hex_data) {
                            Ok((metadata, tx_inputs, tx_outputs)) => {
                                let tx = keepkey_rust::messages::TransactionType {
                                    version: Some(metadata.0),
                                    lock_time: Some(metadata.3),
                                    inputs_cnt: Some(metadata.1),
                                    outputs_cnt: Some(metadata.2),
                                    inputs: tx_inputs,
                                    bin_outputs: tx_outputs,
                                    outputs: vec![],
                                    extra_data: None,
                                    extra_data_len: Some(0),
                                    ..Default::default()
                                };
                                tx_map.insert(tx_hash_hex.clone(), tx);
                                println!("✅ Cached previous transaction for legacy input: {} (v{}, {} inputs, {} outputs)", 
                                       tx_hash_hex, metadata.0, metadata.1, metadata.2);
                            }
                            Err(e) => {
                                eprintln!("⚠️ Failed to parse previous transaction for input {}: {}", idx, e);
                                return Err(format!("Failed to parse previous transaction for input {}: {}", idx, e));
                            }
                        }
                    } else if needs_hex {
                        return Err(format!("Legacy input {} missing required previous transaction hex", idx));
                    }
                } else if needs_hex {
                    return Err(format!("Legacy input {} missing required previous transaction hex", idx));
                } else {
                    println!("⚡ SegWit input {} ({}): no hex required", idx, input.script_type);
                }
            }

            // Build the unsigned transaction
            let mut new_tx_inputs = Vec::new();
            for input in inputs {
                let script_type = match input.script_type.as_str() {
                    "p2pkh" => keepkey_rust::messages::InputScriptType::Spendaddress,
                    "p2sh" | "p2sh-p2wpkh" => keepkey_rust::messages::InputScriptType::Spendp2shwitness,
                    "p2wpkh" => keepkey_rust::messages::InputScriptType::Spendwitness,
                    _ => keepkey_rust::messages::InputScriptType::Spendaddress,
                };

                new_tx_inputs.push(keepkey_rust::messages::TxInputType {
                    address_n: input.address_n_list.clone(),
                    prev_hash: hex::decode(&input.txid).map_err(|e| format!("Invalid txid hex: {}", e))?,
                    prev_index: input.vout,
                    script_sig: None,
                    sequence: Some(0xffffffff),
                    script_type: Some(script_type as i32),
                    amount: Some(input.amount.parse::<u64>().map_err(|_| "Invalid amount")?),
                    ..Default::default()
                });
            }

            let mut new_tx_outputs = Vec::new();
            for output in outputs {
                let script_type = match output.address_type.as_str() {
                    "change" => {
                        // For change outputs, use address_n and appropriate script type
                        match output.script_type.as_deref().unwrap_or("p2pkh") {
                            "p2pkh" => keepkey_rust::messages::OutputScriptType::Paytoaddress,
                            "p2sh" => keepkey_rust::messages::OutputScriptType::Paytoscripthash,
                            "p2wpkh" => keepkey_rust::messages::OutputScriptType::Paytowitness,
                            _ => keepkey_rust::messages::OutputScriptType::Paytoaddress,
                        }
                    },
                    _ => {
                        // For spend outputs
                        keepkey_rust::messages::OutputScriptType::Paytoaddress
                    }
                };

                new_tx_outputs.push(keepkey_rust::messages::TxOutputType {
                    address: if output.address_type == "change" { None } else { Some(output.address.clone()) },
                    address_n: if output.address_type == "change" { 
                        output.address_n_list.clone().unwrap_or_default() 
                    } else { 
                        vec![] 
                    },
                    amount: output.amount,
                    script_type: script_type as i32,
                    address_type: Some(if output.address_type == "change" {
                        keepkey_rust::messages::OutputAddressType::Change as i32
                    } else {
                        keepkey_rust::messages::OutputAddressType::Spend as i32
                    }),
                    ..Default::default()
                });
            }

            let unsigned_tx = keepkey_rust::messages::TransactionType {
                version: Some(version),
                lock_time: Some(lock_time),
                inputs_cnt: Some(inputs.len() as u32),
                outputs_cnt: Some(outputs.len() as u32),
                inputs: new_tx_inputs,
                bin_outputs: vec![],
                outputs: new_tx_outputs,
                extra_data: None,
                extra_data_len: Some(0),
                ..Default::default()
            };

            tx_map.insert("unsigned".to_string(), unsigned_tx);

            // Start the Bitcoin signing protocol
            let sign_tx = keepkey_rust::messages::Message::SignTx(
                keepkey_rust::messages::SignTx {
                    coin_name: Some(coin.clone()),
                    inputs_count: inputs.len() as u32,
                    outputs_count: outputs.len() as u32,
                    version: Some(version),
                    lock_time: Some(lock_time),
                    ..Default::default()
                }
            );

            println!("📤 Sending SignTx message to device");
            
            // Execute the signing protocol
            let mut current_message = sign_tx;
            let mut signatures = Vec::new();
            let mut serialized_tx_parts = Vec::new();
            
            let signing_result = loop {
                let response = queue_handle.send_raw(current_message, false).await
                    .map_err(|e| format!("Device communication error: {}", e))?;
                
                match response {
                    keepkey_rust::messages::Message::TxRequest(tx_req) => {
                        // Handle serialized data if present
                        if let Some(serialized) = &tx_req.serialized {
                            if let Some(serialized_tx) = &serialized.serialized_tx {
                                serialized_tx_parts.push(serialized_tx.clone());
                            }
                            if let Some(signature) = &serialized.signature {
                                if let Some(sig_index) = serialized.signature_index {
                                    signatures.push((sig_index, hex::encode(signature)));
                                }
                            }
                        }
                        
                        // Handle the transaction request
                        match handle_tx_request(tx_req, &tx_map) {
                            Ok(Some(next_msg)) => current_message = next_msg,
                            Ok(None) => {
                                // Transaction finished
                                let mut serialized_tx = Vec::new();
                                for part in &serialized_tx_parts {
                                    serialized_tx.extend_from_slice(part);
                                }
                                
                                let signed_tx_hex = hex::encode(&serialized_tx);
                                
                                println!("✅ Transaction signed successfully!");
                                println!("   Signatures: {}", signatures.len());
                                println!("   Serialized TX: {} bytes", serialized_tx.len());
                                println!("📦 Raw Transaction Hex:");
                                println!("   {}", signed_tx_hex);
                                
                                // Log individual signatures
                                if !signatures.is_empty() {
                                    println!("📝 Individual Signatures:");
                                    for (idx, sig) in &signatures {
                                        println!("   Input {}: {}", idx, sig);
                                    }
                                }
                                
                                // Don't return early - let the function continue to response creation
                                break Ok(signed_tx_hex);
                            }
                            Err(e) => break Err(e),
                        }
                    }
                    keepkey_rust::messages::Message::PassphraseRequest(_) => {
                        println!("🔐 Device requested passphrase during signing");
                        
                        // Emit passphrase request event to frontend
                        let payload = serde_json::json!({
                            "requestId": request.request_id.clone(),
                            "deviceId": request.device_id.clone(),
                        });
                        
                        if let Err(e) = app.emit("passphrase_request", payload) {
                            eprintln!("Failed to emit passphrase_request event: {}", e);
                        }
                        
                        // Return a specific error that the frontend can recognize
                        break Err("PASSPHRASE_REQUIRED".to_string());
                    }
                    keepkey_rust::messages::Message::Failure(failure) => {
                        let error = format!("Device returned error: {}", failure.message.unwrap_or_default());
                        println!("❌ Failed to sign transaction: {}", error);
                        break Err(error);
                    }
                    _ => {
                        let error = format!("Unexpected response from device: {:?}", response);
                        println!("❌ Failed to sign transaction: {}", error);
                        break Err(error);
                    }
                }
            };
            
            signing_result
        }
        DeviceRequest::SendRaw { ref message_type, ref message_data } => {
            // Log the raw message being sent
            if let Err(e) = crate::logging::log_raw_device_message(
                &request.device_id,
                "SEND",
                &message_type,
                &message_data
            ).await {
                eprintln!("Failed to log raw device message: {}", e);
            }
            
            // For raw messages, we'd need to implement proper message parsing
            Err("Raw message sending not yet implemented".to_string())
        }
    };
    
    // Create and store the response
    let device_response = match (&request.request, &result) {
        (DeviceRequest::GetXpub { path }, Ok(ref xpub)) => {
            // Infer script_type from path
            let script_type = if path.starts_with("m/44'") {
                Some("p2pkh".to_string())
            } else if path.starts_with("m/49'") {
                Some("p2sh-p2wpkh".to_string())
            } else if path.starts_with("m/84'") {
                Some("p2wpkh".to_string())
            } else {
                None
            };
            // Debug logging for xpub conversion
            println!("[slip132-debug] Original xpub: {}", xpub);
            println!("[slip132-debug] Inferred script_type: {:?}", script_type);
            // Convert xpub prefix if possible
            let converted_xpub = if let Some(ref st) = script_type {
                match crate::slip132::convert_xpub_prefix(&xpub, st) {
                    Ok(res) => {
                        println!("[slip132-debug] Converted xpub: {}", res);
                        res
                    },
                    Err(e) => {
                        eprintln!("[slip132] Failed to convert xpub prefix: {}", e);
                        xpub.to_string()
                    }
                }
            } else {
                xpub.to_string()
            };
            DeviceResponse::Xpub {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                path: path.clone(),
                xpub: converted_xpub,
                script_type,
                success: true,
                error: None,
            }
        }
        (DeviceRequest::GetXpub { path }, Err(e)) => {
            // Infer script_type from path for error case as well
            let script_type = if path.starts_with("m/44'") {
                Some("p2pkh".to_string())
            } else if path.starts_with("m/49'") {
                Some("p2sh-p2wpkh".to_string())
            } else if path.starts_with("m/84'") {
                Some("p2wpkh".to_string())
            } else {
                None
            };
            DeviceResponse::Xpub {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                path: path.clone(),
                xpub: String::new(),
                script_type,
                success: false,
                error: Some(e.clone()),
            }
        }
        (DeviceRequest::GetAddress { path, .. }, Ok(ref address)) => {
            DeviceResponse::Address {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                path: path.clone(),
                address: address.clone(),
                success: true,
                error: None,
            }
        }
        (DeviceRequest::GetAddress { path, .. }, Err(e)) => {
            DeviceResponse::Address {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                path: path.clone(),
                address: String::new(),
                success: false,
                error: Some(e.clone()),
            }
        }
        (DeviceRequest::SignTransaction { .. }, Ok(ref signed_tx)) => {
            println!("🔐 Creating SignedTransaction DeviceResponse");
            println!("    request_id: {}", request.request_id);
            println!("    device_id: {}", request.device_id);
            println!("    signed_tx length: {}", signed_tx.len());
            println!("    signed_tx preview: {}...", if signed_tx.len() > 40 { &signed_tx[..40] } else { signed_tx });
            DeviceResponse::SignedTransaction {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                signed_tx: signed_tx.clone(),
                txid: None, // TODO: Calculate txid from signed transaction if needed (see v1 implementation)
                // WARNING: If txid is required by the consumer, port calculation logic from v1
                success: true,
                error: None,
            }
        }
        (DeviceRequest::SignTransaction { .. }, Err(e)) => {
            DeviceResponse::SignedTransaction {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                signed_tx: String::new(),
                txid: None,
                success: false,
                error: Some(e.clone()),
            }
        }
        _ => {
            // For other request types, create a generic raw response
            DeviceResponse::Raw {
                request_id: request.request_id.clone(),
                device_id: request.device_id.clone(),
                response: match &result {
                    Ok(resp) => serde_json::json!({"response": resp}),
                    Err(e) => serde_json::json!({"error": e}),
                },
                success: result.is_ok(),
                error: result.as_ref().err().cloned(),
            }
        }
    };
    
    // Mark device as not busy when operation completes
    crate::device::state::set_device_busy(&request.device_id, None).await;
    
    // Store the response for queue status queries
    {
        let mut responses = last_responses.lock().await;
        println!("🗄️ Inserting DeviceResponse into last_responses: device_id={}, request_id={}", request.device_id, request.request_id);
        responses.insert(request.request_id.clone(), device_response.clone());
    }
    
    // Emit event to frontend with the response
    let event_payload = serde_json::json!({
        "device_id": request.device_id,
        "request_id": request.request_id,
        "response": device_response
    });
    
    // EXPLICIT LOGGING FOR SIGNING EVENTS
    if let DeviceResponse::SignedTransaction { ref signed_tx, .. } = device_response {
        println!("🚀 Emitting SignedTransaction event to frontend!");
        println!("    device_id: {}", request.device_id);
        println!("    request_id: {}", request.request_id);
        println!("    signed_tx length: {}", signed_tx.len());
        println!("    event_payload: {}", serde_json::to_string_pretty(&event_payload).unwrap_or_else(|_| "failed to serialize".to_string()));
    }
    
    if let Err(e) = app.emit("device:response", &event_payload) {
        eprintln!("Failed to emit device:response event: {}", e);
    } else {
        println!("📡 Emitted device:response event for request {}", request.request_id);
    }
    
    // Log the response
    match &result {
        Ok(response) => {
            println!("✅ Device operation completed: {}", response);
            
            let response_data = serde_json::json!({
                "response": response,
                "request_type": request_type
            });
            
            if let Err(e) = crate::logging::log_device_response(
                &request.device_id,
                &request.request_id,
                &request_type,
                true,
                &response_data,
                None
            ).await {
                eprintln!("Failed to log device response: {}", e);
            }
            
            Ok(request.request_id)
        }
        Err(e) => {
            println!("❌ Device operation failed: {}", e);
            
            let error_data = serde_json::json!({
                "error": e,
                "request_type": request_type
            });
            
            if let Err(log_err) = crate::logging::log_device_response(
                &request.device_id,
                &request.request_id,
                &request_type,
                false,
                &error_data,
                Some(e)
            ).await {
                eprintln!("Failed to log device error response: {}", log_err);
            }
            
            Err(e.to_string())
        }
    }
}

/// Handle transaction request from device during Bitcoin signing protocol
fn handle_tx_request(
    tx_req: keepkey_rust::messages::TxRequest,
    tx_map: &std::collections::HashMap<String, keepkey_rust::messages::TransactionType>,
) -> Result<Option<keepkey_rust::messages::Message>, String> {
    // Extract transaction hash if provided
    let tx_hash_hex = if let Some(details) = &tx_req.details {
        if let Some(tx_hash) = &details.tx_hash {
            hex::encode(tx_hash)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    // Handle request type
    match tx_req.request_type {
        Some(rt) if rt == keepkey_rust::messages::RequestType::Txinput as i32 => {
            let details = tx_req.details.as_ref()
                .ok_or_else(|| "Missing details in TXINPUT request".to_string())?;
            let req_index = details.request_index
                .ok_or_else(|| "Missing request_index".to_string())? as usize;
            
            let current_tx = if tx_hash_hex.is_empty() {
                tx_map.get("unsigned")
                    .ok_or_else(|| "Unsigned transaction not found".to_string())?
            } else {
                tx_map.get(&tx_hash_hex)
                    .ok_or_else(|| format!("Previous transaction {} not found", tx_hash_hex))?
            };
            
            let input = current_tx.inputs.get(req_index)
                .ok_or_else(|| format!("Input {} not found", req_index))?;
            
            let mut tx_ack_msg = keepkey_rust::messages::TransactionType::default();
            tx_ack_msg.inputs = vec![input.clone()];
            
            Ok(Some(keepkey_rust::messages::Message::TxAck(
                keepkey_rust::messages::TxAck { tx: Some(tx_ack_msg) }
            )))
        }
        Some(rt) if rt == keepkey_rust::messages::RequestType::Txoutput as i32 => {
            let details = tx_req.details.as_ref()
                .ok_or_else(|| "Missing details in TXOUTPUT request".to_string())?;
            let req_index = details.request_index
                .ok_or_else(|| "Missing request_index".to_string())? as usize;
            
            let current_tx = if tx_hash_hex.is_empty() {
                tx_map.get("unsigned")
                    .ok_or_else(|| "Unsigned transaction not found".to_string())?
            } else {
                tx_map.get(&tx_hash_hex)
                    .ok_or_else(|| format!("Previous transaction {} not found", tx_hash_hex))?
            };
            
            if tx_hash_hex.is_empty() {
                // For unsigned transaction, use outputs
                let output = current_tx.outputs.get(req_index)
                    .ok_or_else(|| format!("Output {} not found", req_index))?;
                
                let mut tx_ack_msg = keepkey_rust::messages::TransactionType::default();
                tx_ack_msg.outputs = vec![output.clone()];
                
                Ok(Some(keepkey_rust::messages::Message::TxAck(
                    keepkey_rust::messages::TxAck { tx: Some(tx_ack_msg) }
                )))
            } else {
                // For previous transactions, use bin_outputs
                let bin_output = current_tx.bin_outputs.get(req_index)
                    .ok_or_else(|| format!("Binary output {} not found", req_index))?;
                
                let mut tx_ack_msg = keepkey_rust::messages::TransactionType::default();
                tx_ack_msg.bin_outputs = vec![bin_output.clone()];
                
                Ok(Some(keepkey_rust::messages::Message::TxAck(
                    keepkey_rust::messages::TxAck { tx: Some(tx_ack_msg) }
                )))
            }
        }
        Some(rt) if rt == keepkey_rust::messages::RequestType::Txmeta as i32 => {
            let current_tx = if tx_hash_hex.is_empty() {
                tx_map.get("unsigned")
                    .ok_or_else(|| "Unsigned transaction not found".to_string())?
            } else {
                tx_map.get(&tx_hash_hex)
                    .ok_or_else(|| format!("Previous transaction {} not found", tx_hash_hex))?
            };
            
            let tx_meta = keepkey_rust::messages::TransactionType {
                version: current_tx.version,
                inputs_cnt: current_tx.inputs_cnt,
                outputs_cnt: if tx_hash_hex.is_empty() {
                    Some(current_tx.outputs.len() as u32)
                } else {
                    current_tx.outputs_cnt
                },
                lock_time: current_tx.lock_time,
                extra_data_len: current_tx.extra_data_len,
                inputs: vec![],
                bin_outputs: vec![],
                outputs: vec![],
                extra_data: None,
                expiry: current_tx.expiry,
                overwintered: current_tx.overwintered,
                version_group_id: current_tx.version_group_id,
                branch_id: current_tx.branch_id,
            };
            
            Ok(Some(keepkey_rust::messages::Message::TxAck(
                keepkey_rust::messages::TxAck { tx: Some(tx_meta) }
            )))
        }
        Some(rt) if rt == keepkey_rust::messages::RequestType::Txfinished as i32 => {
            Ok(None) // Signal completion
        }
        _ => Err(format!("Unknown request type: {:?}", tx_req.request_type)),
    }
}
