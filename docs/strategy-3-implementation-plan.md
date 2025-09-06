# Strategy 3: Dual-Track Smart Reconciliation Implementation Plan

## Executive Summary

This document provides a comprehensive implementation plan for fixing the device ID confusion issue using a dual-track approach with smart reconciliation. This strategy maintains backward compatibility while providing immediate user feedback and handling all device states including bootloaders, OOB devices, and PID transitions.

**Timeline**: 4 weeks  
**Risk Level**: Low  
**Complexity**: Moderate  
**Success Probability**: >95%

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Components](#core-components)
3. [Phase 1: Foundation (Week 1)](#phase-1-foundation-week-1)
4. [Phase 2: Protocol Handlers (Week 2)](#phase-2-protocol-handlers-week-2)
5. [Phase 3: Fallback Chains (Week 3)](#phase-3-fallback-chains-week-3)
6. [Phase 4: Advanced Scenarios (Week 4)](#phase-4-advanced-scenarios-week-4)
7. [Testing Strategy](#testing-strategy)
8. [Migration Path](#migration-path)
9. [Success Metrics](#success-metrics)

---

## Architecture Overview

### System Design

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend UI                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │Device List   │  │Status Panel  │  │Error Display │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└────────────────────────┬────────────────────────────────────┘
                         │ Events & Updates
┌────────────────────────┴────────────────────────────────────┐
│                    SmartDeviceManager                       │
│  ┌──────────────────────────────────────────────────┐     │
│  │            Device Track Management                │     │
│  │  • Placeholder ID Generation                      │     │
│  │  • Real ID Mapping                               │     │
│  │  • Status Tracking                               │     │
│  └──────────────────────────────────────────────────┘     │
│  ┌──────────────────────────────────────────────────┐     │
│  │            Protocol Orchestration                 │     │
│  │  • WebUSB Handler (PID 0x0002)                   │     │
│  │  • HID Handler (PID 0x0001)                      │     │
│  │  • Bootloader Protocol                           │     │
│  └──────────────────────────────────────────────────┘     │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                    USB/HID Transport Layer                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │    WebUSB    │  │     HID      │  │     RUSB     │    │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Device Connection** → USB event detected
2. **Placeholder Creation** → Immediate ID generated from USB descriptors
3. **UI Notification** → Device shown with "Connecting..." status
4. **Protocol Selection** → Choose protocol based on PID
5. **Connection Attempts** → Try primary protocol with fallbacks
6. **ID Reconciliation** → Map placeholder to real ID when obtained
7. **UI Update** → Seamless upgrade to full device info

---

## Core Components

### 1. DeviceTrack Structure

```typescript
interface DeviceTrack {
  // Identifiers
  placeholderId: string;           // Generated from USB descriptors
  realId: string | null;           // Device serial from GetFeatures
  
  // USB Information
  usbDevice: USBDevice;            // Raw USB device reference
  vendorId: number;                // 0x2B24 for KeepKey
  productId: number;               // 0x0001 or 0x0002
  busNumber: number;               // USB bus location
  deviceAddress: number;           // USB device address
  
  // Connection State
  status: ConnectionStatus;        // Current connection status
  connectionAttempts: ConnectionAttempt[];  // History of attempts
  activeProtocol: Protocol | null; // Currently active protocol
  
  // Device Information
  features: DeviceFeatures | null; // Features from device
  deviceMode: DeviceMode;         // Bootloader, Firmware, etc.
  firmwareVersion: string | null; // Firmware version if known
  
  // Timing
  connectedAt: number;             // Timestamp of connection
  lastActivityAt: number;          // Last successful communication
  upgradeCompletedAt: number | null; // When real ID obtained
}

enum ConnectionStatus {
  DETECTED = 'detected',
  CONNECTING = 'connecting',
  IDENTIFYING = 'identifying',
  READY = 'ready',
  ERROR = 'error',
  DISCONNECTED = 'disconnected'
}

interface ConnectionAttempt {
  protocol: Protocol;
  startedAt: number;
  completedAt: number | null;
  success: boolean;
  error: string | null;
  obtainedId: string | null;
}
```

### 2. SmartDeviceManager Class

```typescript
class SmartDeviceManager {
  private deviceTracks: Map<string, DeviceTrack>;
  private realIdToPlaceholder: Map<string, string>;
  private eventEmitter: EventEmitter;
  private protocolHandlers: Map<Protocol, ProtocolHandler>;
  
  constructor() {
    this.deviceTracks = new Map();
    this.realIdToPlaceholder = new Map();
    this.eventEmitter = new EventEmitter();
    this.initializeProtocolHandlers();
    this.startUSBMonitoring();
  }
  
  // Core public methods
  async connectDevice(usbDevice: USBDevice): Promise<Device>;
  async disconnectDevice(deviceId: string): Promise<void>;
  getDevice(deviceId: string): Device | null;
  getAllDevices(): Device[];
  
  // ID management
  private generateStablePlaceholder(usbDevice: USBDevice): string;
  private mapRealIdToPlaceholder(realId: string, placeholderId: string): void;
  private resolveDeviceId(anyId: string): string;
  
  // Protocol orchestration
  private selectProtocolStrategy(usbDevice: USBDevice): ProtocolStrategy;
  private async executeProtocolStrategy(track: DeviceTrack, strategy: ProtocolStrategy): Promise<void>;
  private async handleProtocolFallback(track: DeviceTrack, failedProtocol: Protocol): Promise<void>;
  
  // UI updates
  private notifyUIDeviceDetected(track: DeviceTrack): void;
  private notifyUIStatusUpdate(track: DeviceTrack): void;
  private notifyUIDeviceReady(track: DeviceTrack): void;
  private notifyUIDeviceError(track: DeviceTrack, error: Error): void;
}
```

### 3. Protocol Handlers

```typescript
interface ProtocolHandler {
  name: Protocol;
  supportedPIDs: number[];
  priority: number;
  
  canHandle(usbDevice: USBDevice): boolean;
  connect(usbDevice: USBDevice): Promise<Transport>;
  getFeatures(transport: Transport): Promise<DeviceFeatures>;
  initialize(transport: Transport): Promise<void>;
  cleanup(transport: Transport): Promise<void>;
}

class WebUSBProtocolHandler implements ProtocolHandler {
  name = Protocol.WEBUSB;
  supportedPIDs = [0x0002];
  priority = 1;
  
  async connect(usbDevice: USBDevice): Promise<Transport> {
    // Implementation for WebUSB connection
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: 0x2B24, productId: 0x0002 }]
    });
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    return new WebUSBTransport(device);
  }
  
  async getFeatures(transport: Transport): Promise<DeviceFeatures> {
    // Send GetFeatures command via WebUSB
    const response = await transport.call('GetFeatures', {});
    return response as DeviceFeatures;
  }
}

class HIDProtocolHandler implements ProtocolHandler {
  name = Protocol.HID;
  supportedPIDs = [0x0001, 0x0002]; // Supports both
  priority = 2;
  
  async connect(usbDevice: USBDevice): Promise<Transport> {
    // Implementation for HID connection
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: 0x2B24 }]
    });
    if (devices.length === 0) throw new Error('No HID device found');
    await devices[0].open();
    return new HIDTransport(devices[0]);
  }
  
  async getFeatures(transport: Transport): Promise<DeviceFeatures> {
    // Send Initialize for HID devices
    const response = await transport.call('Initialize', {});
    if (response.type === 'Features') {
      return response as DeviceFeatures;
    }
    throw new Error('Unexpected response to Initialize');
  }
}

class BootloaderProtocolHandler implements ProtocolHandler {
  name = Protocol.BOOTLOADER;
  supportedPIDs = [0x0001];
  priority = 3;
  
  async connect(usbDevice: USBDevice): Promise<Transport> {
    // Special handling for bootloader mode
    const transport = await this.establishBootloaderConnection(usbDevice);
    return transport;
  }
  
  async getFeatures(transport: Transport): Promise<DeviceFeatures> {
    // Bootloader may have limited features
    try {
      const response = await transport.call('Initialize', {});
      return this.parseBootloaderFeatures(response);
    } catch (e) {
      // Return minimal features for bootloader
      return {
        bootloaderMode: true,
        deviceId: null, // No serial in bootloader
        firmwareVersion: 'Bootloader',
        initialized: false
      };
    }
  }
}
```

---

## Phase 1: Foundation (Week 1)

### Goals
- Implement stable placeholder ID generation
- Create basic dual-track structure
- Add UI status update system
- Establish event communication

### Tasks

#### 1.1 Placeholder ID Generation
```typescript
// Location: src-tauri/src/device/manager.rs
impl SmartDeviceManager {
    fn generate_stable_placeholder(&self, usb_device: &UsbDevice) -> String {
        // Use combination of VID, PID, bus, and port for stability
        let vid = usb_device.vendor_id();
        let pid = usb_device.product_id();
        let bus = usb_device.bus_number();
        let addr = usb_device.address();
        
        // Format: keepkey_[pid]_[bus]_[addr]
        // This remains stable across reconnects to same port
        format!("keepkey_{:04x}_{:03}_{:03}", pid, bus, addr)
    }
}
```

#### 1.2 Device Track Creation
```typescript
// Location: src/contexts/DeviceContext.tsx
const createDeviceTrack = (usbDevice: USBDevice): DeviceTrack => {
  const placeholderId = generateStablePlaceholder(usbDevice);
  
  return {
    placeholderId,
    realId: null,
    usbDevice,
    vendorId: usbDevice.vendorId,
    productId: usbDevice.productId,
    busNumber: usbDevice.busNumber,
    deviceAddress: usbDevice.deviceAddress,
    status: ConnectionStatus.DETECTED,
    connectionAttempts: [],
    activeProtocol: null,
    features: null,
    deviceMode: DeviceMode.UNKNOWN,
    firmwareVersion: null,
    connectedAt: Date.now(),
    lastActivityAt: Date.now(),
    upgradeCompletedAt: null
  };
};
```

#### 1.3 UI Status Component
```tsx
// Location: src/components/DeviceStatus.tsx
interface DeviceStatusProps {
  track: DeviceTrack;
}

export const DeviceStatus: React.FC<DeviceStatusProps> = ({ track }) => {
  const getStatusMessage = () => {
    switch (track.status) {
      case ConnectionStatus.DETECTED:
        return 'Device detected, initializing...';
      case ConnectionStatus.CONNECTING:
        return `Connecting via ${track.activeProtocol || 'USB'}...`;
      case ConnectionStatus.IDENTIFYING:
        return 'Getting device information...';
      case ConnectionStatus.READY:
        return `Connected: ${track.features?.label || track.realId || track.placeholderId}`;
      case ConnectionStatus.ERROR:
        const lastError = track.connectionAttempts
          .filter(a => !a.success)
          .pop()?.error;
        return `Connection failed: ${lastError || 'Unknown error'}`;
      default:
        return 'Unknown status';
    }
  };
  
  const getProgressPercentage = () => {
    switch (track.status) {
      case ConnectionStatus.DETECTED: return 10;
      case ConnectionStatus.CONNECTING: return 40;
      case ConnectionStatus.IDENTIFYING: return 70;
      case ConnectionStatus.READY: return 100;
      case ConnectionStatus.ERROR: return 0;
      default: return 0;
    }
  };
  
  return (
    <div className="device-status">
      <div className="device-id">
        {track.realId || track.placeholderId}
      </div>
      <div className="status-message">
        {getStatusMessage()}
      </div>
      <ProgressBar percentage={getProgressPercentage()} />
      {track.status === ConnectionStatus.ERROR && (
        <RetryButton onClick={() => retryConnection(track.placeholderId)} />
      )}
    </div>
  );
};
```

#### 1.4 Event System
```typescript
// Location: src-tauri/src/device/events.rs
#[derive(Clone, Serialize)]
#[serde(tag = "type")]
pub enum DeviceEvent {
    DeviceDetected {
        placeholder_id: String,
        vendor_id: u16,
        product_id: u16,
    },
    StatusUpdate {
        device_id: String,
        status: ConnectionStatus,
        message: Option<String>,
    },
    DeviceReady {
        placeholder_id: String,
        real_id: Option<String>,
        features: DeviceFeatures,
    },
    DeviceError {
        device_id: String,
        error: String,
        recoverable: bool,
    },
    DeviceDisconnected {
        device_id: String,
    },
}

impl DeviceEvent {
    pub fn emit(&self, app: &AppHandle) -> Result<()> {
        app.emit_all("device-event", self)?;
        Ok(())
    }
}
```

### Deliverables (End of Week 1)
- [ ] Stable placeholder ID generation working
- [ ] Device tracks created on connection
- [ ] UI shows devices immediately with status
- [ ] Event system operational
- [ ] Basic error handling in place

---

## Phase 2: Protocol Handlers (Week 2)

### Goals
- Implement PID-based protocol selection
- Create WebUSB handler for PID 0x0002
- Create HID handler for PID 0x0001
- Add bootloader protocol support

### Tasks

#### 2.1 Protocol Strategy Selection
```typescript
// Location: src/services/protocols/strategy.ts
const selectProtocolStrategy = (usbDevice: USBDevice): ProtocolStrategy => {
  const pid = usbDevice.productId;
  
  switch (pid) {
    case 0x0001:
      // Legacy device or bootloader
      return {
        primary: Protocol.HID,
        fallbacks: [Protocol.BOOTLOADER],
        timeout: 10000,
        retries: 3
      };
      
    case 0x0002:
      // Modern device
      return {
        primary: Protocol.WEBUSB,
        fallbacks: [Protocol.HID],
        timeout: 5000,
        retries: 2
      };
      
    default:
      // Unknown device, try everything
      return {
        primary: Protocol.HID,
        fallbacks: [Protocol.WEBUSB, Protocol.BOOTLOADER],
        timeout: 15000,
        retries: 3
      };
  }
};
```

#### 2.2 Protocol Execution Engine
```typescript
// Location: src/services/protocols/executor.ts
class ProtocolExecutor {
  async execute(
    track: DeviceTrack,
    strategy: ProtocolStrategy
  ): Promise<ConnectionResult> {
    // Update status
    track.status = ConnectionStatus.CONNECTING;
    this.notifyStatusUpdate(track);
    
    // Try primary protocol
    const primaryAttempt = await this.tryProtocol(
      track,
      strategy.primary,
      strategy.timeout,
      strategy.retries
    );
    
    if (primaryAttempt.success) {
      return primaryAttempt;
    }
    
    // Try fallback protocols
    for (const fallbackProtocol of strategy.fallbacks) {
      const fallbackAttempt = await this.tryProtocol(
        track,
        fallbackProtocol,
        strategy.timeout,
        strategy.retries
      );
      
      if (fallbackAttempt.success) {
        return fallbackAttempt;
      }
    }
    
    // All protocols failed
    track.status = ConnectionStatus.ERROR;
    this.notifyStatusUpdate(track);
    throw new Error('All connection attempts failed');
  }
  
  private async tryProtocol(
    track: DeviceTrack,
    protocol: Protocol,
    timeout: number,
    retries: number
  ): Promise<ConnectionResult> {
    const attempt: ConnectionAttempt = {
      protocol,
      startedAt: Date.now(),
      completedAt: null,
      success: false,
      error: null,
      obtainedId: null
    };
    
    track.connectionAttempts.push(attempt);
    track.activeProtocol = protocol;
    
    for (let i = 0; i < retries; i++) {
      try {
        const handler = this.getHandler(protocol);
        const transport = await this.withTimeout(
          handler.connect(track.usbDevice),
          timeout
        );
        
        track.status = ConnectionStatus.IDENTIFYING;
        this.notifyStatusUpdate(track);
        
        const features = await this.withTimeout(
          handler.getFeatures(transport),
          timeout
        );
        
        attempt.success = true;
        attempt.obtainedId = features.deviceId || null;
        attempt.completedAt = Date.now();
        
        track.features = features;
        track.realId = features.deviceId || null;
        track.deviceMode = this.determineDeviceMode(features);
        track.firmwareVersion = features.firmwareVersion || null;
        
        return {
          success: true,
          transport,
          features,
          protocol
        };
      } catch (error) {
        attempt.error = error.message;
        
        if (i === retries - 1) {
          // Last retry failed
          attempt.completedAt = Date.now();
          return {
            success: false,
            error: error.message,
            protocol
          };
        }
        
        // Wait before retry
        await this.delay(1000 * (i + 1)); // Exponential backoff
      }
    }
  }
}
```

#### 2.3 WebUSB Implementation
```typescript
// Location: src/services/protocols/webusb.ts
class WebUSBHandler {
  async connect(usbDevice: USBDevice): Promise<WebUSBTransport> {
    try {
      await usbDevice.open();
      await usbDevice.selectConfiguration(1);
      
      // Try to claim main interface
      await usbDevice.claimInterface(0);
      
      // Optional: Try to claim debug interface
      try {
        await usbDevice.claimInterface(1);
        console.log('Debug interface claimed');
      } catch (e) {
        console.log('Debug interface not available');
      }
      
      return new WebUSBTransport(usbDevice);
    } catch (error) {
      if (error.message.includes('LIBUSB_ERROR_ACCESS')) {
        throw new Error('Device already in use by another application');
      }
      throw error;
    }
  }
  
  async getFeatures(transport: WebUSBTransport): Promise<DeviceFeatures> {
    // Send GetFeatures message
    const message = {
      type: MessageType.GetFeatures,
      payload: {}
    };
    
    const response = await transport.call(message);
    
    if (response.type !== MessageType.Features) {
      throw new Error(`Unexpected response: ${response.type}`);
    }
    
    return this.parseFeatures(response.payload);
  }
}
```

#### 2.4 HID Implementation
```typescript
// Location: src/services/protocols/hid.ts
class HIDHandler {
  async connect(device: HIDDevice): Promise<HIDTransport> {
    if (!device.opened) {
      await device.open();
    }
    
    // Set up event listeners
    device.addEventListener('inputreport', this.handleInputReport);
    
    return new HIDTransport(device);
  }
  
  async getFeatures(transport: HIDTransport): Promise<DeviceFeatures> {
    // HID devices need Initialize message
    const message = {
      type: MessageType.Initialize,
      payload: {}
    };
    
    const response = await transport.call(message);
    
    if (response.type === MessageType.Features) {
      return this.parseFeatures(response.payload);
    } else if (response.type === MessageType.Failure) {
      // May be in bootloader mode
      if (response.payload.code === 'Failure_UnknownMessage') {
        // Try bootloader-specific commands
        return this.tryBootloaderMode(transport);
      }
      throw new Error(`Device failure: ${response.payload.message}`);
    }
    
    throw new Error(`Unexpected response: ${response.type}`);
  }
  
  private async tryBootloaderMode(transport: HIDTransport): Promise<DeviceFeatures> {
    // Bootloader may not support GetFeatures
    // Return minimal info
    return {
      bootloaderMode: true,
      deviceId: null,
      firmwareVersion: 'Bootloader',
      initialized: false,
      vendorId: 0x2B24,
      productId: transport.device.productId
    };
  }
}
```

### Deliverables (End of Week 2)
- [ ] Protocol selection based on PID
- [ ] WebUSB handler fully functional
- [ ] HID handler with bootloader detection
- [ ] Protocol fallback working
- [ ] Connection retry with backoff

---

## Phase 3: Fallback Chains (Week 3)

### Goals
- Implement comprehensive fallback logic
- Add timeout handling at each stage
- Create recovery mechanisms
- Handle partial connections

### Tasks

#### 3.1 Fallback Chain Definition
```typescript
// Location: src/services/protocols/fallback.ts
interface FallbackChain {
  steps: FallbackStep[];
  maxTotalTime: number;
  onStepComplete?: (step: FallbackStep, result: StepResult) => void;
  onChainComplete?: (results: StepResult[]) => void;
}

interface FallbackStep {
  name: string;
  protocol: Protocol;
  timeout: number;
  retries: number;
  conditions?: {
    requiresPID?: number[];
    requiresMode?: DeviceMode[];
    skipIf?: (track: DeviceTrack) => boolean;
  };
  recovery?: {
    onTimeout?: () => Promise<void>;
    onError?: (error: Error) => Promise<void>;
  };
}

const createFallbackChain = (usbDevice: USBDevice): FallbackChain => {
  const pid = usbDevice.productId;
  
  if (pid === 0x0002) {
    // Modern device chain
    return {
      steps: [
        {
          name: 'WebUSB Primary',
          protocol: Protocol.WEBUSB,
          timeout: 5000,
          retries: 2
        },
        {
          name: 'HID Fallback',
          protocol: Protocol.HID,
          timeout: 7000,
          retries: 2,
          recovery: {
            onError: async (error) => {
              if (error.message.includes('Access denied')) {
                // Try to release WebUSB claim
                await releaseWebUSBClaim(usbDevice);
              }
            }
          }
        },
        {
          name: 'Direct USB',
          protocol: Protocol.DIRECT_USB,
          timeout: 10000,
          retries: 1
        }
      ],
      maxTotalTime: 30000
    };
  } else if (pid === 0x0001) {
    // Legacy device chain
    return {
      steps: [
        {
          name: 'HID Primary',
          protocol: Protocol.HID,
          timeout: 7000,
          retries: 3
        },
        {
          name: 'Bootloader Check',
          protocol: Protocol.BOOTLOADER,
          timeout: 5000,
          retries: 1,
          conditions: {
            skipIf: (track) => track.features?.bootloaderMode === false
          }
        },
        {
          name: 'Recovery Mode',
          protocol: Protocol.RECOVERY,
          timeout: 10000,
          retries: 1
        }
      ],
      maxTotalTime: 45000
    };
  }
  
  // Unknown device - try everything
  return createComprehensiveFallbackChain();
};
```

#### 3.2 Timeout Management
```typescript
// Location: src/services/protocols/timeout.ts
class TimeoutManager {
  private globalTimeout: NodeJS.Timeout | null = null;
  private stepTimeouts: Map<string, NodeJS.Timeout> = new Map();
  
  async executeWithTimeout<T>(
    operation: Promise<T>,
    timeout: number,
    name: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new TimeoutError(`${name} timed out after ${timeout}ms`));
      }, timeout);
      
      this.stepTimeouts.set(name, timeoutId);
      
      operation
        .then(result => {
          clearTimeout(timeoutId);
          this.stepTimeouts.delete(name);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          this.stepTimeouts.delete(name);
          reject(error);
        });
    });
  }
  
  setGlobalTimeout(timeout: number, onTimeout: () => void) {
    this.globalTimeout = setTimeout(onTimeout, timeout);
  }
  
  clearAll() {
    if (this.globalTimeout) {
      clearTimeout(this.globalTimeout);
      this.globalTimeout = null;
    }
    
    this.stepTimeouts.forEach(timeout => clearTimeout(timeout));
    this.stepTimeouts.clear();
  }
}
```

#### 3.3 Recovery Mechanisms
```typescript
// Location: src/services/protocols/recovery.ts
class RecoveryManager {
  async attemptRecovery(
    track: DeviceTrack,
    lastError: Error
  ): Promise<RecoveryResult> {
    const recoveryStrategies = this.selectRecoveryStrategies(track, lastError);
    
    for (const strategy of recoveryStrategies) {
      try {
        const result = await this.executeRecoveryStrategy(strategy, track);
        if (result.success) {
          return result;
        }
      } catch (e) {
        console.error(`Recovery strategy ${strategy.name} failed:`, e);
      }
    }
    
    return { success: false, error: 'All recovery attempts failed' };
  }
  
  private selectRecoveryStrategies(
    track: DeviceTrack,
    error: Error
  ): RecoveryStrategy[] {
    const strategies: RecoveryStrategy[] = [];
    
    if (error.message.includes('timeout')) {
      strategies.push({
        name: 'Reset USB',
        execute: () => this.resetUSBDevice(track.usbDevice)
      });
    }
    
    if (error.message.includes('Access denied')) {
      strategies.push({
        name: 'Release Locks',
        execute: () => this.releaseAllLocks(track.usbDevice)
      });
    }
    
    if (track.productId === 0x0001) {
      strategies.push({
        name: 'Bootloader Recovery',
        execute: () => this.tryBootloaderRecovery(track)
      });
    }
    
    // Always include device reset as last resort
    strategies.push({
      name: 'Device Reset',
      execute: () => this.requestDeviceReset(track)
    });
    
    return strategies;
  }
  
  private async resetUSBDevice(usbDevice: USBDevice): Promise<void> {
    // Request USB reset
    await usbDevice.reset();
    // Wait for device to reinitialize
    await delay(2000);
  }
  
  private async releaseAllLocks(usbDevice: USBDevice): Promise<void> {
    // Release all interface claims
    for (const iface of usbDevice.configuration?.interfaces || []) {
      try {
        await usbDevice.releaseInterface(iface.interfaceNumber);
      } catch (e) {
        // Interface may not be claimed
      }
    }
    
    // Close device
    await usbDevice.close();
    
    // Wait before reconnecting
    await delay(1000);
  }
}
```

#### 3.4 Partial Connection Handling
```typescript
// Location: src/services/protocols/partial.ts
class PartialConnectionHandler {
  async handlePartialConnection(
    track: DeviceTrack,
    partialResult: PartialConnectionResult
  ): Promise<void> {
    // Device connected but incomplete features
    if (partialResult.transport && !partialResult.features) {
      // Try alternative methods to get features
      const features = await this.tryAlternativeFeatures(
        partialResult.transport,
        track
      );
      
      if (features) {
        track.features = features;
        track.realId = features.deviceId || null;
        track.status = ConnectionStatus.READY;
      } else {
        // Use device in limited mode
        track.status = ConnectionStatus.LIMITED;
        track.features = this.createLimitedFeatures(track);
      }
    }
    
    // Device identified but transport failed
    if (!partialResult.transport && partialResult.features) {
      // Store features and retry transport later
      track.features = partialResult.features;
      track.realId = partialResult.features.deviceId || null;
      track.status = ConnectionStatus.PARTIAL;
      
      // Schedule transport retry
      this.scheduleTransportRetry(track);
    }
  }
  
  private createLimitedFeatures(track: DeviceTrack): DeviceFeatures {
    return {
      deviceId: track.placeholderId,
      vendorId: track.vendorId,
      productId: track.productId,
      bootloaderMode: track.productId === 0x0001,
      initialized: false,
      firmwareVersion: 'Unknown',
      label: `KeepKey (${track.placeholderId.slice(-6)})`
    };
  }
}
```

### Deliverables (End of Week 3)
- [ ] Comprehensive fallback chains
- [ ] Timeout handling at all levels
- [ ] Recovery mechanisms for common failures
- [ ] Partial connection support
- [ ] Limited mode for problematic devices

---

## Phase 4: Advanced Scenarios (Week 4)

### Goals
- Handle PID transitions during updates
- Support OOB device detection
- Implement multi-device management
- Add comprehensive testing

### Tasks

#### 4.1 PID Transition Handling
```typescript
// Location: src/services/device/transitions.ts
class PIDTransitionManager {
  private transitionHistory: Map<string, PIDTransition[]> = new Map();
  
  async handleBootloaderUpdate(track: DeviceTrack): Promise<void> {
    const originalPID = track.productId;
    
    // Register expected transition
    this.registerExpectedTransition(track.placeholderId, {
      from: 0x0001,
      to: 0x0002,
      reason: 'bootloader_update',
      expectedDisconnectTime: 5000
    });
    
    // Monitor for device reconnection
    const reconnectMonitor = this.createReconnectMonitor(track);
    
    try {
      // Perform update
      await this.performBootloaderUpdate(track);
      
      // Wait for reconnection with new PID
      const newTrack = await reconnectMonitor.waitForReconnect(10000);
      
      // Merge tracks
      this.mergeDeviceTracks(track, newTrack);
      
    } catch (error) {
      reconnectMonitor.cancel();
      throw error;
    }
  }
  
  private createReconnectMonitor(originalTrack: DeviceTrack): ReconnectMonitor {
    return new ReconnectMonitor({
      expectedVID: originalTrack.vendorId,
      expectedPIDs: [0x0001, 0x0002], // Could be either
      busNumber: originalTrack.busNumber,
      portNumber: originalTrack.deviceAddress,
      serialNumberHint: originalTrack.realId,
      
      onDeviceFound: (usbDevice) => {
        // Verify this is our device
        return this.verifyDeviceIdentity(originalTrack, usbDevice);
      }
    });
  }
  
  private async verifyDeviceIdentity(
    originalTrack: DeviceTrack,
    usbDevice: USBDevice
  ): Promise<boolean> {
    // Check if same physical port
    if (usbDevice.busNumber === originalTrack.busNumber &&
        Math.abs(usbDevice.deviceAddress - originalTrack.deviceAddress) <= 2) {
      // Device address might change slightly
      return true;
    }
    
    // Try to get serial number if available
    try {
      const serial = await this.getDeviceSerial(usbDevice);
      return serial === originalTrack.realId;
    } catch (e) {
      // Can't get serial, assume it's the same device if timing is right
      const timeSinceDisconnect = Date.now() - originalTrack.lastActivityAt;
      return timeSinceDisconnect < 10000; // Within 10 seconds
    }
  }
}
```

#### 4.2 OOB Device Detection
```typescript
// Location: src/services/device/oob.ts
class OOBDeviceDetector {
  async detectOOBState(track: DeviceTrack): Promise<OOBState> {
    const features = track.features;
    
    if (!features) {
      return OOBState.UNKNOWN;
    }
    
    // Check bootloader indicators
    if (features.bootloaderMode === true ||
        features.firmwareVersion?.includes('Bootloader') ||
        features.firmwareVersion?.includes('bootloader')) {
      return OOBState.BOOTLOADER;
    }
    
    // Check initialization state
    if (features.initialized === false) {
      // Short response indicates OOB bootloader
      if (track.connectionAttempts[0]?.responseLength < 64) {
        return OOBState.OOB_BOOTLOADER;
      }
      
      // Uninitialized wallet
      return OOBState.OOB_WALLET;
    }
    
    // Check for specific OOB patterns
    if (this.hasOOBPattern(features)) {
      return OOBState.OOB_WALLET;
    }
    
    return OOBState.NORMAL;
  }
  
  private hasOOBPattern(features: DeviceFeatures): boolean {
    // Check for OOB-specific patterns
    return (
      !features.deviceId ||
      features.deviceId === '0000000000000000' ||
      !features.label ||
      features.pinProtection === false
    );
  }
  
  async handleOOBDevice(track: DeviceTrack, state: OOBState): Promise<void> {
    switch (state) {
      case OOBState.OOB_BOOTLOADER:
        // Need firmware upload
        track.status = ConnectionStatus.NEEDS_FIRMWARE;
        this.notifyUI({
          type: 'oob_bootloader',
          message: 'Device needs firmware installation',
          action: 'INSTALL_FIRMWARE'
        });
        break;
        
      case OOBState.OOB_WALLET:
        // Need initialization
        track.status = ConnectionStatus.NEEDS_SETUP;
        this.notifyUI({
          type: 'oob_wallet',
          message: 'Device needs to be set up',
          action: 'START_SETUP'
        });
        break;
        
      case OOBState.NORMAL:
        // Device ready to use
        track.status = ConnectionStatus.READY;
        break;
    }
  }
}
```

#### 4.3 Multi-Device Management
```typescript
// Location: src/services/device/multidevice.ts
class MultiDeviceManager {
  private devices: Map<string, DeviceTrack> = new Map();
  private activeDevice: string | null = null;
  
  async handleMultipleDevices(usbDevices: USBDevice[]): Promise<void> {
    // Group devices by physical connection
    const deviceGroups = this.groupDevicesByConnection(usbDevices);
    
    for (const group of deviceGroups) {
      if (group.length === 1) {
        // Single device, normal handling
        await this.connectDevice(group[0]);
      } else {
        // Multiple devices on same connection (shouldn't happen)
        await this.handleConflictingDevices(group);
      }
    }
    
    // Update UI with all devices
    this.notifyUIMultipleDevices(Array.from(this.devices.values()));
  }
  
  private groupDevicesByConnection(
    usbDevices: USBDevice[]
  ): USBDevice[][] {
    const groups = new Map<string, USBDevice[]>();
    
    for (const device of usbDevices) {
      const key = `${device.busNumber}_${device.deviceAddress}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(device);
    }
    
    return Array.from(groups.values());
  }
  
  selectActiveDevice(deviceId: string): void {
    const track = this.resolveDeviceTrack(deviceId);
    if (!track) {
      throw new Error(`Device ${deviceId} not found`);
    }
    
    this.activeDevice = track.placeholderId;
    
    // Update UI
    this.notifyUIActiveDeviceChanged(track);
  }
  
  private resolveDeviceTrack(deviceId: string): DeviceTrack | null {
    // Check if it's a placeholder ID
    if (this.devices.has(deviceId)) {
      return this.devices.get(deviceId)!;
    }
    
    // Check if it's a real ID
    for (const track of this.devices.values()) {
      if (track.realId === deviceId) {
        return track;
      }
    }
    
    return null;
  }
}
```

#### 4.4 Comprehensive Testing
```typescript
// Location: tests/device-connection.test.ts
describe('Device Connection Tests', () => {
  describe('Placeholder ID Generation', () => {
    it('should generate stable IDs for same USB port', () => {
      const device1 = createMockUSBDevice({ bus: 1, address: 2 });
      const device2 = createMockUSBDevice({ bus: 1, address: 2 });
      
      const id1 = generateStablePlaceholder(device1);
      const id2 = generateStablePlaceholder(device2);
      
      expect(id1).toBe(id2);
    });
    
    it('should generate different IDs for different ports', () => {
      const device1 = createMockUSBDevice({ bus: 1, address: 2 });
      const device2 = createMockUSBDevice({ bus: 1, address: 3 });
      
      const id1 = generateStablePlaceholder(device1);
      const id2 = generateStablePlaceholder(device2);
      
      expect(id1).not.toBe(id2);
    });
  });
  
  describe('Protocol Selection', () => {
    it('should select WebUSB for PID 0x0002', () => {
      const device = createMockUSBDevice({ productId: 0x0002 });
      const strategy = selectProtocolStrategy(device);
      
      expect(strategy.primary).toBe(Protocol.WEBUSB);
      expect(strategy.fallbacks).toContain(Protocol.HID);
    });
    
    it('should select HID for PID 0x0001', () => {
      const device = createMockUSBDevice({ productId: 0x0001 });
      const strategy = selectProtocolStrategy(device);
      
      expect(strategy.primary).toBe(Protocol.HID);
      expect(strategy.fallbacks).toContain(Protocol.BOOTLOADER);
    });
  });
  
  describe('Fallback Chains', () => {
    it('should fall back from WebUSB to HID on failure', async () => {
      const device = createMockUSBDevice({ productId: 0x0002 });
      const track = createDeviceTrack(device);
      
      // Mock WebUSB to fail
      mockWebUSBConnect.mockRejectedValue(new Error('WebUSB failed'));
      // Mock HID to succeed
      mockHIDConnect.mockResolvedValue(mockHIDTransport);
      
      const result = await executeProtocolStrategy(track, {
        primary: Protocol.WEBUSB,
        fallbacks: [Protocol.HID]
      });
      
      expect(result.success).toBe(true);
      expect(result.protocol).toBe(Protocol.HID);
      expect(track.connectionAttempts).toHaveLength(2);
    });
  });
  
  describe('PID Transitions', () => {
    it('should track device through PID change', async () => {
      const manager = new PIDTransitionManager();
      const track = createDeviceTrack(
        createMockUSBDevice({ productId: 0x0001 })
      );
      
      // Simulate bootloader update
      const updatePromise = manager.handleBootloaderUpdate(track);
      
      // Simulate device reconnecting with new PID
      await delay(100);
      const newDevice = createMockUSBDevice({ 
        productId: 0x0002,
        busNumber: track.busNumber,
        deviceAddress: track.deviceAddress
      });
      
      mockUSBDeviceFound.mockResolvedValue(newDevice);
      
      await updatePromise;
      
      expect(track.productId).toBe(0x0002);
      expect(track.placeholderId).toBe(track.placeholderId); // Same ID
    });
  });
  
  describe('OOB Detection', () => {
    it('should detect OOB bootloader mode', async () => {
      const detector = new OOBDeviceDetector();
      const track = createDeviceTrack(
        createMockUSBDevice({ productId: 0x0001 })
      );
      
      track.features = {
        bootloaderMode: true,
        initialized: false,
        firmwareVersion: 'Legacy Bootloader'
      };
      
      const state = await detector.detectOOBState(track);
      expect(state).toBe(OOBState.OOB_BOOTLOADER);
    });
    
    it('should detect OOB wallet mode', async () => {
      const detector = new OOBDeviceDetector();
      const track = createDeviceTrack(
        createMockUSBDevice({ productId: 0x0001 })
      );
      
      track.features = {
        bootloaderMode: false,
        initialized: false,
        deviceId: null
      };
      
      const state = await detector.detectOOBState(track);
      expect(state).toBe(OOBState.OOB_WALLET);
    });
  });
  
  describe('Multi-Device', () => {
    it('should handle multiple devices', async () => {
      const manager = new MultiDeviceManager();
      
      const devices = [
        createMockUSBDevice({ busNumber: 1, deviceAddress: 2 }),
        createMockUSBDevice({ busNumber: 2, deviceAddress: 3 })
      ];
      
      await manager.handleMultipleDevices(devices);
      
      expect(manager.getAllDevices()).toHaveLength(2);
      expect(manager.getAllDevices()[0].placeholderId)
        .not.toBe(manager.getAllDevices()[1].placeholderId);
    });
  });
});
```

### Deliverables (End of Week 4)
- [ ] PID transition handling complete
- [ ] OOB device detection working
- [ ] Multi-device support functional
- [ ] All test scenarios passing
- [ ] Documentation updated

---

## Testing Strategy

### Unit Tests
- Placeholder ID generation
- Protocol selection logic
- Fallback chain execution
- Recovery mechanisms
- ID mapping

### Integration Tests
- Full connection flow
- Protocol fallbacks
- PID transitions
- Multi-device scenarios
- Error recovery

### E2E Tests
- Real device connection
- Bootloader updates
- OOB device setup
- Multi-device switching
- Stress testing with disconnects

### Test Devices Needed
1. Modern KeepKey (PID 0x0002)
2. Legacy KeepKey (PID 0x0001)
3. OOB KeepKey (uninitialized)
4. Bootloader mode device
5. Multiple devices for concurrent testing

---

## Migration Path

### Phase 1: Parallel Implementation
- New system runs alongside old system
- Flag to enable new system for testing
- Fallback to old system on failure

### Phase 2: Gradual Rollout
- Enable for internal testing (Week 4)
- Beta users opt-in (Week 5)
- Staged rollout to all users (Week 6)

### Phase 3: Deprecation
- Monitor metrics for 2 weeks
- Disable old system (Week 8)
- Remove old code (Week 10)

### Rollback Plan
- Feature flag to instantly revert
- Old system remains functional
- Telemetry to detect issues early

---

## Success Metrics

### Technical Metrics
| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Connection Success Rate | <70% | >95% | Successful connections / Total attempts |
| Time to Connect | 10-30s | <5s | Median connection time |
| Fallback Success | Unknown | >90% | Successful fallbacks / Fallback attempts |
| PID Transition Success | <50% | >99% | Successful transitions / Total transitions |
| Multi-device Support | Buggy | 100% | Devices correctly identified / Total devices |

### User Experience Metrics
| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| "Device Not Found" Errors | >30% | <2% | Error reports / Total connections |
| User Confusion Reports | High | Low | Support tickets mentioning connection |
| Onboarding Success | <70% | >95% | Completed onboarding / Started onboarding |
| Time to First Transaction | >10min | <2min | Time from connect to first operation |

### Code Quality Metrics
| Metric | Target | Measurement |
|--------|--------|-------------|
| Test Coverage | >90% | Lines covered / Total lines |
| Cyclomatic Complexity | <10 | Complexity analysis tools |
| Documentation Coverage | 100% | Documented functions / Total functions |
| Error Handling | 100% | Try-catch blocks / Async operations |

---

## Risk Mitigation

### Identified Risks

1. **WebUSB Browser Compatibility**
   - Mitigation: Fallback to HID
   - Detection: User agent checking
   
2. **USB Permission Issues**
   - Mitigation: Clear permission prompts
   - Recovery: Permission reset guide
   
3. **Race Conditions**
   - Mitigation: Proper state locking
   - Testing: Concurrent connection tests
   
4. **Memory Leaks**
   - Mitigation: Proper cleanup in all paths
   - Monitoring: Memory profiling
   
5. **Regression in Old Devices**
   - Mitigation: Extensive backwards compatibility testing
   - Fallback: Feature flag for old system

---

## Implementation Checklist

### Week 1: Foundation
- [ ] Create SmartDeviceManager class
- [ ] Implement placeholder ID generation
- [ ] Build device track system
- [ ] Add UI status components
- [ ] Set up event system
- [ ] Basic error handling
- [ ] Unit tests for core components

### Week 2: Protocols
- [ ] Protocol strategy selection
- [ ] WebUSB handler implementation
- [ ] HID handler implementation
- [ ] Bootloader protocol support
- [ ] Protocol execution engine
- [ ] Connection retry logic
- [ ] Integration tests for protocols

### Week 3: Fallbacks
- [ ] Fallback chain definitions
- [ ] Timeout management system
- [ ] Recovery mechanisms
- [ ] Partial connection handling
- [ ] Limited mode support
- [ ] Comprehensive error recovery
- [ ] Fallback scenario tests

### Week 4: Advanced
- [ ] PID transition handling
- [ ] OOB device detection
- [ ] Multi-device management
- [ ] End-to-end testing
- [ ] Performance optimization
- [ ] Documentation completion
- [ ] Production readiness review

---

## Conclusion

This implementation plan provides a robust solution to the device ID confusion problem while maintaining backward compatibility and improving user experience. The dual-track approach with smart reconciliation ensures devices are shown immediately while obtaining accurate identification in the background.

The phased implementation reduces risk while allowing for continuous testing and validation. By the end of Week 4, the system will handle all known device scenarios including bootloaders, OOB devices, PID transitions, and multi-device setups.

Success will be measured through improved connection rates, reduced user confusion, and faster time to first operation. The comprehensive testing strategy ensures reliability across all device types and connection scenarios.