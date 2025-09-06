# KeepKey Vault Logging System Improvement Plan

## Executive Summary
This document outlines a comprehensive plan to improve the logging system for KeepKey Vault to provide complete debugging information, structured error reporting, and actionable insights for developers.

## Current State Analysis

### Problems Identified
1. **Unstructured Logging** - Raw console.log statements without consistent format
2. **Missing Context** - Errors lack environment, user action, and state information
3. **Minified Stack Traces** - Production builds show unhelpful minified code references
4. **No Log Levels** - Everything is logged at same level, no filtering capability
5. **No Correlation** - Cannot trace related events across components
6. **Missing Metadata** - No timestamps, session IDs, or user identifiers
7. **Poor Error Boundaries** - React errors not properly caught and logged
8. **No Backend Integration** - Frontend and Rust backend logs are disconnected

## Proposed Logging Architecture

### 1. Structured Logging Format

```typescript
interface LogEntry {
  // Core Fields
  timestamp: string;           // ISO 8601 format
  level: LogLevel;             // ERROR, WARN, INFO, DEBUG, TRACE
  category: LogCategory;       // Component category
  message: string;             // Human-readable message
  
  // Context Fields
  sessionId: string;           // Unique session identifier
  correlationId?: string;      // Track related operations
  userId?: string;             // Anonymized user identifier
  deviceId?: string;           // KeepKey device identifier
  
  // Location Fields
  component: string;           // Component name
  function?: string;           // Function/method name
  file?: string;              // Source file (with source maps)
  line?: number;              // Line number
  
  // Error Fields (when applicable)
  error?: {
    type: string;             // Error type/name
    message: string;          // Error message
    stack?: string;           // Full stack trace
    code?: string;            // Error code
    context?: any;            // Additional error context
  };
  
  // Performance Fields
  duration?: number;          // Operation duration in ms
  memory?: {
    used: number;             // Memory usage
    limit: number;            // Memory limit
  };
  
  // Metadata
  metadata?: Record<string, any>;  // Additional structured data
  tags?: string[];            // Searchable tags
  
  // Environment
  environment: {
    platform: string;         // Windows, macOS, Linux
    version: string;          // App version
    browser?: string;         // Browser info if web
    locale: string;           // User locale
  };
}
```

### 2. Log Levels and Categories

#### Log Levels
```typescript
enum LogLevel {
  ERROR = 0,   // App-breaking errors, data loss risks
  WARN = 1,    // Recoverable issues, degraded performance
  INFO = 2,    // Important state changes, milestones
  DEBUG = 3,   // Detailed debugging information
  TRACE = 4    // Very detailed trace information
}
```

#### Log Categories
```typescript
enum LogCategory {
  // Device Operations
  DEVICE_CONNECTION = 'device.connection',
  DEVICE_COMMUNICATION = 'device.communication',
  DEVICE_UPDATE = 'device.update',
  DEVICE_AUTH = 'device.auth',
  
  // UI Components
  UI_RENDER = 'ui.render',
  UI_ERROR = 'ui.error',
  UI_INTERACTION = 'ui.interaction',
  UI_NAVIGATION = 'ui.navigation',
  
  // Business Logic
  WALLET_OPERATION = 'wallet.operation',
  TRANSACTION = 'transaction',
  PORTFOLIO = 'portfolio',
  
  // System
  SYSTEM_INIT = 'system.init',
  SYSTEM_ERROR = 'system.error',
  SYSTEM_PERFORMANCE = 'system.performance',
  
  // Security
  SECURITY_AUTH = 'security.auth',
  SECURITY_CRYPTO = 'security.crypto',
  SECURITY_VIOLATION = 'security.violation',
  
  // Network
  NETWORK_REQUEST = 'network.request',
  NETWORK_RESPONSE = 'network.response',
  NETWORK_ERROR = 'network.error',
  
  // Backend/Rust
  RUST_COMMAND = 'rust.command',
  RUST_EVENT = 'rust.event',
  RUST_ERROR = 'rust.error'
}
```

### 3. Logger Implementation

#### Frontend Logger (TypeScript/React)
```typescript
class KeepKeyLogger {
  private sessionId: string;
  private buffer: LogEntry[] = [];
  private config: LoggerConfig;
  
  constructor(config: LoggerConfig) {
    this.sessionId = generateSessionId();
    this.config = config;
    this.setupErrorBoundaries();
    this.setupUnhandledRejections();
  }
  
  // Core logging methods
  error(category: LogCategory, message: string, error?: Error, metadata?: any): void
  warn(category: LogCategory, message: string, metadata?: any): void
  info(category: LogCategory, message: string, metadata?: any): void
  debug(category: LogCategory, message: string, metadata?: any): void
  trace(category: LogCategory, message: string, metadata?: any): void
  
  // Specialized methods
  logDeviceOperation(operation: string, deviceId: string, result: 'success' | 'failure', metadata?: any): void
  logUIError(component: string, error: Error, userAction?: string): void
  logPerformance(operation: string, duration: number, metadata?: any): void
  logTransaction(type: string, details: any, status: string): void
  
  // Context management
  withCorrelationId<T>(correlationId: string, fn: () => T): T
  withDeviceContext<T>(deviceId: string, fn: () => T): T
  
  // Buffer management
  flush(): Promise<void>
  export(): LogEntry[]
  clear(): void
}
```

#### Backend Logger (Rust)
```rust
use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: DateTime<Utc>,
    pub level: LogLevel,
    pub category: String,
    pub message: String,
    pub session_id: String,
    pub correlation_id: Option<String>,
    pub device_id: Option<String>,
    pub component: String,
    pub metadata: Option<serde_json::Value>,
}

pub struct KeepKeyLogger {
    session_id: String,
    buffer: Vec<LogEntry>,
    config: LoggerConfig,
}

impl KeepKeyLogger {
    pub fn error(&self, category: &str, message: &str, metadata: Option<serde_json::Value>);
    pub fn warn(&self, category: &str, message: &str, metadata: Option<serde_json::Value>);
    pub fn info(&self, category: &str, message: &str, metadata: Option<serde_json::Value>);
    pub fn debug(&self, category: &str, message: &str, metadata: Option<serde_json::Value>);
    pub fn trace(&self, category: &str, message: &str, metadata: Option<serde_json::Value>);
}
```

### 4. Error Tracking Enhancements

#### React Error Boundary
```typescript
class LoggingErrorBoundary extends React.Component {
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error(
      LogCategory.UI_ERROR,
      'React component error',
      error,
      {
        componentStack: errorInfo.componentStack,
        errorBoundary: this.constructor.name,
        props: this.props,
        state: this.state
      }
    );
  }
}
```

#### Device Error Context
```typescript
interface DeviceErrorContext {
  deviceId: string;
  firmwareVersion: string;
  bootloaderVersion: string;
  connectionType: 'USB' | 'WebUSB';
  lastCommand: string;
  commandHistory: string[];
  deviceState: DeviceState;
  pinAttempts?: number;
  isLocked: boolean;
}
```

### 5. Debug Information Requirements

#### Essential Debug Information per Component

##### Device Operations
- Device ID (real vs placeholder)
- Connection state and history
- Command queue status
- Firmware/bootloader versions
- PIN/passphrase state
- Error recovery attempts
- Timeout occurrences

##### UI Components
- Component hierarchy
- Props and state at error time
- User interaction trail
- Render cycle count
- Performance metrics

##### Wallet Operations
- Current wallet state
- Transaction details
- Address derivation paths
- XPUB status
- Portfolio loading state

##### Network Operations
- Request/response pairs
- API endpoints called
- Response times
- Error codes and messages
- Retry attempts

### 6. Log Output Destinations

#### Development Mode
1. **Browser Console** - Colored, formatted output
2. **Redux DevTools** - State changes and actions
3. **Local File** - Rotating log files in app data directory
4. **Debug Panel** - In-app debug overlay

#### Production Mode
1. **Encrypted Local Storage** - Last 1000 entries
2. **Error Reporting Service** - Critical errors only
3. **User Export** - Sanitized logs for support

### 7. Privacy and Security

#### Sensitive Data Handling
```typescript
const sanitizers = {
  // Never log these fields
  blacklist: ['pin', 'passphrase', 'seedPhrase', 'privateKey', 'password'],
  
  // Partially mask these fields
  mask: {
    xpub: (value: string) => `${value.slice(0, 10)}...${value.slice(-4)}`,
    address: (value: string) => `${value.slice(0, 6)}...${value.slice(-4)}`,
    deviceId: (value: string) => `${value.slice(0, 8)}...`,
  },
  
  // Hash these fields
  hash: ['email', 'userId', 'ipAddress']
};
```

### 8. Implementation Phases

#### Phase 1: Core Logger (Week 1-2)
- [ ] Implement base logger class
- [ ] Add structured logging format
- [ ] Create log levels and categories
- [ ] Setup error boundaries

#### Phase 2: Frontend Integration (Week 3-4)
- [ ] Replace console.log statements
- [ ] Add component-specific loggers
- [ ] Implement correlation IDs
- [ ] Add performance tracking

#### Phase 3: Backend Integration (Week 5-6)
- [ ] Implement Rust logger
- [ ] Create unified log format
- [ ] Setup IPC for log synchronization
- [ ] Add device operation logging

#### Phase 4: Debug Tools (Week 7-8)
- [ ] Create debug overlay UI
- [ ] Add log export functionality
- [ ] Implement log filtering/search
- [ ] Create log analysis tools

#### Phase 5: Testing & Documentation (Week 9-10)
- [ ] Test all logging scenarios
- [ ] Document logging guidelines
- [ ] Create troubleshooting guide
- [ ] Train team on new system

### 9. Success Metrics

1. **Error Resolution Time** - Reduce by 50%
2. **Support Ticket Quality** - Include actionable logs in 90% of reports
3. **Developer Productivity** - Reduce debugging time by 40%
4. **Production Issues** - Catch 80% of issues before user reports
5. **Log Usefulness Score** - Developer survey rating >4/5

### 10. Example Usage

#### Before (Current State)
```javascript
console.log("Device connected:", device);
console.error("Error:", error);
```

#### After (Improved System)
```typescript
logger.info(LogCategory.DEVICE_CONNECTION, 'Device connected successfully', {
  deviceId: device.id,
  firmwareVersion: device.firmware,
  connectionType: 'USB'
});

logger.error(LogCategory.DEVICE_COMMUNICATION, 'Failed to communicate with device', error, {
  deviceId: device.id,
  lastCommand: 'GetFeatures',
  attempts: 3,
  timeout: true
});
```

### 11. Log Analysis Tools

#### Log Viewer Features
- Real-time log streaming
- Advanced filtering (by level, category, device, time range)
- Log correlation visualization
- Error pattern detection
- Performance profiling
- Export to various formats (JSON, CSV, plaintext)

#### Automated Analysis
- Anomaly detection
- Common error patterns
- Performance regression alerts
- Device failure prediction
- User journey reconstruction

### 12. Configuration

```typescript
interface LoggerConfig {
  // Levels
  minLevel: LogLevel;
  
  // Outputs
  outputs: {
    console: boolean;
    file: boolean;
    remote: boolean;
    overlay: boolean;
  };
  
  // Features
  features: {
    performanceTracking: boolean;
    errorBoundaries: boolean;
    correlationIds: boolean;
    deviceContext: boolean;
    sanitization: boolean;
  };
  
  // Limits
  limits: {
    bufferSize: number;      // Max logs in memory
    fileSize: number;        // Max log file size
    retentionDays: number;   // How long to keep logs
  };
  
  // Remote
  remote?: {
    endpoint: string;
    apiKey: string;
    batchSize: number;
    flushInterval: number;
  };
}
```

## Conclusion

This comprehensive logging system will transform debugging from a frustrating guessing game into a systematic, data-driven process. By implementing structured logging with proper context, correlation, and analysis tools, we can dramatically improve developer productivity, reduce time to resolution, and enhance overall product quality.

## Next Steps

1. Review and approve this plan
2. Set up development environment for logger
3. Create proof of concept for Phase 1
4. Begin incremental rollout starting with critical paths
5. Gather feedback and iterate

## Appendix

### A. Sample Log Output
```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "ERROR",
  "category": "device.communication",
  "message": "Device communication timeout",
  "sessionId": "sess_abc123",
  "correlationId": "corr_xyz789",
  "deviceId": "393231301147373231001800",
  "component": "DeviceUpdateManager",
  "function": "getFeatures",
  "file": "DeviceUpdateManager.tsx",
  "line": 145,
  "error": {
    "type": "TimeoutError",
    "message": "Device did not respond within 30 seconds",
    "code": "DEVICE_TIMEOUT"
  },
  "metadata": {
    "attempts": 3,
    "lastCommand": "GetFeatures",
    "deviceState": "connected",
    "firmwareVersion": "7.10.0"
  },
  "environment": {
    "platform": "Windows",
    "version": "2.2.6",
    "browser": "Chrome 120.0.0",
    "locale": "en-US"
  }
}
```

### B. References
- [Structured Logging Best Practices](https://www.structlog.org/)
- [OpenTelemetry Logging](https://opentelemetry.io/docs/specs/otel/logs/)
- [React Error Boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary)
- [Rust Logging with tracing](https://docs.rs/tracing/latest/tracing/)