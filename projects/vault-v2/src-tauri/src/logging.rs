use std::fs;
use std::io::Write;
use std::path::PathBuf;
use chrono::Utc;
use serde_json;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Device communication logger that writes to dated files in .keepkey/logs
pub struct DeviceLogger {
    logs_dir: PathBuf,
    current_log_file: Arc<Mutex<Option<std::fs::File>>>,
    current_date: Arc<Mutex<String>>,
}

impl DeviceLogger {
    /// Create a new device logger
    pub fn new() -> Result<Self, String> {
        let home_dir = dirs::home_dir()
            .ok_or_else(|| "Could not find home directory".to_string())?;
        
        let logs_dir = home_dir.join(".keepkey").join("logs");
        
        // Create the logs directory if it doesn't exist
        fs::create_dir_all(&logs_dir)
            .map_err(|e| format!("Failed to create logs directory: {}", e))?;
        
        Ok(DeviceLogger {
            logs_dir,
            current_log_file: Arc::new(Mutex::new(None)),
            current_date: Arc::new(Mutex::new(String::new())),
        })
    }
    
    /// Get the current date string for log file naming
    fn get_current_date() -> String {
        Utc::now().format("%Y-%m-%d").to_string()
    }
    
    /// Get the current log file, creating a new one if needed
    async fn get_current_log_file(&self) -> Result<std::fs::File, String> {
        let current_date = Self::get_current_date();
        
        let mut current_date_lock = self.current_date.lock().await;
        let mut current_log_file_lock = self.current_log_file.lock().await;
        
        // Check if we need to create a new log file (new day or first time)
        if *current_date_lock != current_date || current_log_file_lock.is_none() {
            let log_file_path = self.logs_dir.join(format!("device-communications-{}.log", current_date));
            
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_file_path)
                .map_err(|e| format!("Failed to open log file: {}", e))?;
            
            *current_log_file_lock = Some(file);
            *current_date_lock = current_date;
        }
        
        // Clone the file handle for returning
        let log_file_path = self.logs_dir.join(format!("device-communications-{}.log", current_date_lock));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file_path)
            .map_err(|e| format!("Failed to open log file: {}", e))?;
        
        Ok(file)
    }
    
    /// Log a device request
    pub async fn log_request(
        &self,
        device_id: &str,
        request_id: &str,
        request_type: &str,
        request_data: &serde_json::Value,
    ) -> Result<(), String> {
        let timestamp = Utc::now().to_rfc3339();
        
        let log_entry = serde_json::json!({
            "timestamp": timestamp,
            "direction": "REQUEST",
            "device_id": device_id,
            "request_id": request_id,
            "request_type": request_type,
            "data": request_data
        });
        
        self.write_log_entry(&log_entry).await
    }
    
    /// Log a device response
    pub async fn log_response(
        &self,
        device_id: &str,
        request_id: &str,
        request_type: &str,
        success: bool,
        response_data: &serde_json::Value,
        error: Option<&str>,
    ) -> Result<(), String> {
        let timestamp = Utc::now().to_rfc3339();
        
        let log_entry = serde_json::json!({
            "timestamp": timestamp,
            "direction": "RESPONSE",
            "device_id": device_id,
            "request_id": request_id,
            "request_type": request_type,
            "success": success,
            "data": response_data,
            "error": error
        });
        
        self.write_log_entry(&log_entry).await
    }
    
    /// Log a raw device message
    pub async fn log_raw_message(
        &self,
        device_id: &str,
        direction: &str, // "SEND" or "RECEIVE"
        message_type: &str,
        message_data: &serde_json::Value,
    ) -> Result<(), String> {
        let timestamp = Utc::now().to_rfc3339();
        
        let log_entry = serde_json::json!({
            "timestamp": timestamp,
            "direction": direction,
            "device_id": device_id,
            "message_type": message_type,
            "data": message_data
        });
        
        self.write_log_entry(&log_entry).await
    }
    
    /// Write a log entry to the current log file
    async fn write_log_entry(&self, log_entry: &serde_json::Value) -> Result<(), String> {
        let current_date = Self::get_current_date();
        
        // Hold both locks for the entire write operation to prevent interleaving
        let mut current_date_lock = self.current_date.lock().await;
        let mut current_log_file_lock = self.current_log_file.lock().await;
        
        // Check if we need to create a new log file (new day or first time)
        if *current_date_lock != current_date || current_log_file_lock.is_none() {
            let log_file_path = self.logs_dir.join(format!("device-communications-{}.log", current_date));
            
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_file_path)
                .map_err(|e| format!("Failed to open log file: {}", e))?;
            
            *current_date_lock = current_date;
            *current_log_file_lock = Some(file);
        }
        
        // Write to the file while holding the lock
        if let Some(ref mut file) = *current_log_file_lock {
            // Write the log entry as a JSON line
            writeln!(file, "{}", serde_json::to_string(log_entry).unwrap())
                .map_err(|e| format!("Failed to write log entry: {}", e))?;
            
            // Flush to ensure it's written immediately
            file.flush()
                .map_err(|e| format!("Failed to flush log file: {}", e))?;
        }
        
        Ok(())
    }
    
    /// Get the path to today's log file (creates it if it doesn't exist)
    pub fn get_todays_log_path(&self) -> PathBuf {
        let current_date = Self::get_current_date();
        let log_path = self.logs_dir.join(format!("device-communications-{}.log", current_date));
        
        // Ensure the file exists by creating it if needed
        if !log_path.exists() {
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(&log_path)
            {
                // Write an initial entry to mark the file creation
                let initial_entry = serde_json::json!({
                    "timestamp": Utc::now().to_rfc3339(),
                    "direction": "SYSTEM",
                    "message": "Log file created",
                    "version": "2.0.0"
                });
                
                if let Ok(json_str) = serde_json::to_string(&initial_entry) {
                    use std::io::Write;
                    let _ = writeln!(&file, "{}", json_str);
                }
            }
        }
        
        log_path
    }
    
    /// Clean up old log files (keep only last 30 days)
    pub async fn cleanup_old_logs(&self) -> Result<(), String> {
        let thirty_days_ago = Utc::now() - chrono::Duration::days(30);
        
        let entries = fs::read_dir(&self.logs_dir)
            .map_err(|e| format!("Failed to read logs directory: {}", e))?;
        
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();
            
            if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    if file_name.starts_with("device-communications-") && file_name.ends_with(".log") {
                        // Extract date from filename
                        if let Some(date_str) = file_name
                            .strip_prefix("device-communications-")
                            .and_then(|s| s.strip_suffix(".log"))
                        {
                            if let Ok(file_date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                                let file_datetime = file_date.and_hms_opt(0, 0, 0).unwrap().and_utc();
                                
                                if file_datetime < thirty_days_ago {
                                    println!("Cleaning up old log file: {}", file_name);
                                    let _ = fs::remove_file(&path);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        Ok(())
    }
}

/// Global device logger instance
static DEVICE_LOGGER: std::sync::OnceLock<DeviceLogger> = std::sync::OnceLock::new();

/// Initialize the global device logger
pub fn init_device_logger() -> Result<(), String> {
    let logger = DeviceLogger::new()?;
    DEVICE_LOGGER.set(logger).map_err(|_| "Device logger already initialized".to_string())?;
    Ok(())
}

/// Get the global device logger instance
pub fn get_device_logger() -> &'static DeviceLogger {
    DEVICE_LOGGER.get().expect("Device logger not initialized")
}

/// Helper function to log a device request
pub async fn log_device_request(
    device_id: &str,
    request_id: &str,
    request_type: &str,
    request_data: &serde_json::Value,
) -> Result<(), String> {
    let logger = get_device_logger();
    logger.log_request(device_id, request_id, request_type, request_data).await
}

/// Helper function to log a device response
pub async fn log_device_response(
    device_id: &str,
    request_id: &str,
    request_type: &str,
    success: bool,
    response_data: &serde_json::Value,
    error: Option<&str>,
) -> Result<(), String> {
    let logger = get_device_logger();
    logger.log_response(device_id, request_id, request_type, success, response_data, error).await
}

/// Helper function to log a raw device message
pub async fn log_raw_device_message(
    device_id: &str,
    direction: &str,
    message_type: &str,
    message_data: &serde_json::Value,
) -> Result<(), String> {
    let logger = get_device_logger();
    logger.log_raw_message(device_id, direction, message_type, message_data).await
} 